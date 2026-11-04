import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionSecretTracker } from "../security/secrets.js";
import { toPromptShape } from "./schema.js";
import type {
  PluginSurfaceContext,
  PromptReturn,
  ResourceReturn,
  WeavetabPluginPrompt,
  WeavetabPluginResource,
} from "./interface.js";

const PROMPT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// weavetab:// belongs to core; the rest would make clients treat plugin output as a page or file
const BLOCKED = new Set(["weavetab", "file", "http", "https", "data", "javascript"]);

const scrub = (s: string) => SessionSecretTracker.redactAll(s);

function schemeOf(uri: string) {
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri)?.[1].toLowerCase();
}

export function toPromptResult(r: PromptReturn) {
  if (typeof r === "string") {
    return { messages: [{ role: "user" as const, content: { type: "text" as const, text: scrub(r) } }] };
  }
  if (!r || !Array.isArray(r.messages) || !r.messages.length) throw new Error("prompt returned no messages");
  return {
    ...(r.description ? { description: r.description } : {}),
    messages: r.messages.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: { type: "text" as const, text: scrub(typeof m.content === "string" ? m.content : m.content?.text ?? "") },
    })),
  };
}

export function toReadResult(r: ResourceReturn, uri: string, mime?: string) {
  const one = (c: { uri?: string; text?: string; blob?: string; mimeType?: string }) => {
    const base = { uri: c.uri ?? uri, mimeType: c.mimeType ?? mime };
    if (typeof c.text === "string") return { ...base, mimeType: base.mimeType ?? "text/plain", text: scrub(c.text) };
    if (typeof c.blob === "string") return { ...base, blob: c.blob };
    throw new Error("resource content needs text or blob");
  };
  if (typeof r === "string") return { contents: [one({ text: r })] };
  if (r && "contents" in r && Array.isArray(r.contents) && r.contents.length) return { contents: r.contents.map(one) };
  if (r && ("text" in r || "blob" in r)) return { contents: [one(r)] };
  throw new Error("resource returned nothing");
}

type Owned = { key: string; kind: "prompt" | "resource"; remove: () => void };

export function createSurface(
  server: McpServer,
  ctxFor: (owner: string) => PluginSurfaceContext,
  warn: (msg: string) => void
) {
  const raw = server as any;
  const owned = new Map<string, Owned[]>();
  const keep = (owner: string, o: Owned) => owned.set(owner, [...(owned.get(owner) ?? []), o]);

  function addPrompt(owner: string, p: WeavetabPluginPrompt): boolean {
    if (!PROMPT_NAME.test(p?.name ?? "")) {
      warn(`${owner}: prompt name "${p?.name}" rejected, use lowercase letters, digits, - or _ (max 64)`);
      return false;
    }
    if (typeof p.handler !== "function") {
      warn(`${owner}: prompt "${p.name}" has no handler`);
      return false;
    }
    if (raw._registeredPrompts?.[p.name]) {
      warn(`${owner}: prompt "${p.name}" already exists, skipped`);
      return false;
    }

    const shape = toPromptShape(p.arguments);
    const hasArgs = Object.keys(shape).length > 0;
    try {
      const h = server.registerPrompt(
        p.name,
        { title: p.title, description: p.description, ...(hasArgs ? { argsSchema: shape } : {}) },
        (async (first: any) => {
          try {
            return toPromptResult(await p.handler(hasArgs ? first : {}, ctxFor(owner)));
          } catch (e: any) {
            throw new Error(scrub(e?.message || String(e)));
          }
        }) as any
      );
      keep(owner, { key: p.name, kind: "prompt", remove: () => h.remove() });
      return true;
    } catch (e: any) {
      warn(`${owner}: prompt "${p.name}" not registered: ${e?.message}`);
      return false;
    }
  }

  function addResource(owner: string, r: WeavetabPluginResource): boolean {
    if (!r?.name || typeof r.read !== "function") {
      warn(`${owner}: resource needs a name and a read()`);
      return false;
    }
    if (!!r.uri === !!r.uriTemplate) {
      warn(`${owner}: resource "${r.name}" needs exactly one of uri or uriTemplate`);
      return false;
    }
    const target = (r.uri || r.uriTemplate) as string;
    const sch = schemeOf(target);
    if (!sch || BLOCKED.has(sch)) {
      warn(`${owner}: resource "${r.name}" uri must look like myscheme://..., and not use ${[...BLOCKED].join("/")}`);
      return false;
    }

    const meta = { title: r.title, description: r.description, mimeType: r.mimeType };
    const ctx = () => ctxFor(owner);
    const guard = async <T>(fn: () => Promise<T> | T) => {
      try {
        return await fn();
      } catch (e: any) {
        throw new Error(scrub(e?.message || String(e)));
      }
    };

    try {
      if (r.uri) {
        if (raw._registeredResources?.[r.uri]) {
          warn(`${owner}: resource ${r.uri} already exists, skipped`);
          return false;
        }
        const h = server.registerResource(r.name, r.uri, meta, (u: URL) =>
          guard(async () => toReadResult(await r.read(u.href, {}, ctx()), u.href, r.mimeType))
        );
        keep(owner, { key: r.uri, kind: "resource", remove: () => h.remove() });
        return true;
      }

      if (raw._registeredResourceTemplates?.[r.name]) {
        warn(`${owner}: resource template "${r.name}" already exists, skipped`);
        return false;
      }
      const complete = r.complete
        ? Object.fromEntries(
            Object.entries(r.complete).map(([k, fn]) => [k, async (v: string) => (await fn(v)).slice(0, 100)])
          )
        : undefined;
      const tpl = new ResourceTemplate(r.uriTemplate as string, {
        list: r.list
          ? () =>
              guard(async () => ({
                resources: (await r.list!(ctx())).map((x) => ({ ...x, mimeType: x.mimeType ?? r.mimeType })),
              }))
          : undefined,
        complete,
      });
      const h = server.registerResource(r.name, tpl, meta, (u: URL, vars: any) =>
        guard(async () => toReadResult(await r.read(u.href, vars, ctx()), u.href, r.mimeType))
      );
      keep(owner, { key: r.name, kind: "resource", remove: () => h.remove() });
      return true;
    } catch (e: any) {
      warn(`${owner}: resource "${r.name}" not registered: ${e?.message}`);
      return false;
    }
  }

  function drop(owner: string, kind?: Owned["kind"], key?: string) {
    const all = owned.get(owner) ?? [];
    const gone = all.filter((o) => (!kind || o.kind === kind) && (!key || o.key === key));
    for (const o of gone) o.remove();
    owned.set(owner, all.filter((o) => !gone.includes(o)));
    return gone.length > 0;
  }

  return {
    addPrompt,
    addResource,
    removePrompt: (owner: string, name: string) => drop(owner, "prompt", name),
    removeResource: (owner: string, key: string) => drop(owner, "resource", key),
    dropAll: (owner: string) => drop(owner),
    count: () => ({
      prompts: Object.keys(raw._registeredPrompts ?? {}).length,
      resources: Object.keys(raw._registeredResources ?? {}).length + Object.keys(raw._registeredResourceTemplates ?? {}).length,
    }),
  };
}
