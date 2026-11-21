/**
 * Weavetab — tools/storage.ts
 * browser_storage: read/write localStorage and sessionStorage via Runtime.evaluate.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import { SessionSecretTracker } from "../security/secrets.js";
import { sessionRegistry } from "../state/session.js";

const MAX_LIST_VALUE_LEN = 2000;

export interface StorageOptions {
  scope: "local" | "session";
  action: "get" | "set" | "remove" | "list" | "clear";
  key?: string;
  value?: string;
}

export async function browserStorage(
  session: CDP.Client,
  options: StorageOptions,
  _config: Config
): Promise<{ success: boolean; result?: string | null; data?: { key: string; value: string | null }[]; message?: string }> {
  const { scope, action, key, value } = options;
  const storageObj = scope === "local" ? "localStorage" : scope === "session" ? "sessionStorage" : null;
  if (!storageObj) {
    throw new Error(`browser_storage: invalid scope "${scope}" (expected "local" or "session")`);
  }

  const targetId = sessionRegistry.getActive(getConfigAgentId(_config))?.targetId ?? "default";

  if (action === "get") {
    if (!key) throw new Error("browser_storage get requires a 'key'");
    const { result } = await session.Runtime.evaluate({
      expression: `(function(k){ return ${storageObj}.getItem(k); })(${JSON.stringify(key)})`,
      returnByValue: true
    });
    const raw = result.value as string | null;
    return { success: true, result: typeof raw === "string" ? SessionSecretTracker.redact(targetId, raw) : raw };
  }

  if (action === "set") {
    if (!key || value === undefined) throw new Error("browser_storage set requires 'key' and 'value'");
    await session.Runtime.evaluate({
      expression: `(function(k,v){ ${storageObj}.setItem(k,v); })(${JSON.stringify(key)}, ${JSON.stringify(value ?? "")})`
    });
    return { success: true, message: `Set ${storageObj} key ${key}` };
  }

  if (action === "remove") {
    if (!key) throw new Error("browser_storage remove requires a 'key'");
    await session.Runtime.evaluate({
      expression: `(function(k){ ${storageObj}.removeItem(k); })(${JSON.stringify(key)})`
    });
    return { success: true, message: `Removed ${storageObj} key ${key}` };
  }

  if (action === "list") {
    const { result } = await session.Runtime.evaluate({
      expression: `(function(){ var out = []; var s = ${storageObj}; for (var i = 0; i < s.length; i++) { var k = s.key(i); out.push({ key: k, value: s.getItem(k) }); } return out; })()`,
      returnByValue: true
    });
    const rawList = Array.isArray(result.value) ? (result.value as { key: string; value: string | null }[]) : [];
    const data = rawList.map(({ key: k, value: v }) => {
      if (typeof v !== "string") return { key: k, value: v };
      const clean = SessionSecretTracker.redact(targetId, v);
      const capped = clean.length > MAX_LIST_VALUE_LEN
        ? `${clean.slice(0, MAX_LIST_VALUE_LEN)}... (+${clean.length - MAX_LIST_VALUE_LEN} chars)`
        : clean;
      return { key: k, value: capped };
    });
    return { success: true, data, message: `${storageObj} has ${data.length} key(s)` };
  }

  if (action === "clear") {
    await session.Runtime.evaluate({
      expression: `${storageObj}.clear()`
    });
    return { success: true, message: `Cleared ${storageObj}` };
  }

  throw new Error(`Unknown action: ${action}`);
}
