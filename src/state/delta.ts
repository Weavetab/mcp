import { SessionSecretTracker } from "../security/secrets.js";
import type { ActionElement as _ActionElement } from "../cdp/walker.js";
import { hookPipeline } from "../plugin/pipeline.js";
export type ActionElement = _ActionElement;

export interface RefEntry {
  id: string;
  role: string;
  label: string;
  type?: string;
  value?: string;
  href?: string;
  disabled?: boolean;
  fingerprint: string;
}

export interface SnapshotDiff {
  added: RefEntry[];
  removed: string[];
  changed: RefEntry[];
  stable_count: number;
  _refs_truncated?: number;
}

export interface PropertyDiff {
  [propName: string]: { from: string; to: string };
}

export interface RichChangedRef {
  ref: string;
  role: string;
  label: string;
  changes: PropertyDiff;
  actionable?: boolean;
  recommended_action?: string;
}

export interface IframeChange {
  frameUrl: string;
  status: "added" | "removed" | "changed";
  elementCount: number;
}

export interface RichDelta {
  added: RefEntry[];
  removed: string[];
  changed: RichChangedRef[];
  stable_count: number;
  iframes?: IframeChange[];
  _refs_truncated?: number;
}

const snapshots = new Map<string, { url: string; refs: Map<string, RefEntry> }>();
const propSnapshots = new Map<string, { url: string; props: Map<string, Record<string, string>> }>();
const frameSnapshots = new Map<string, Map<string, number>>();

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox",
  "checkbox", "radio", "menuitem", "tab", "select",
]);

function redactText(targetId: string | undefined, text: string): string {
  if (!text) return text;
  const byTarget = targetId ? SessionSecretTracker.redact(targetId, text) : text;
  return SessionSecretTracker.redactAll(byTarget);
}

function isSecretElement(el: ActionElement, targetId?: string): boolean {
  return Boolean(
    (el.backendNodeId !== undefined &&
      targetId &&
      SessionSecretTracker.isNodeSecret(targetId, el.backendNodeId)) ||
      el.role === "password" ||
      el.type === "password"
  );
}

function serializeProps(el: ActionElement, targetId?: string): Record<string, string> {
  const isSecretField = isSecretElement(el, targetId);
  const isSecretValue = isSecretField || el.value === "[REDACTED]";

  return {
    label: redactText(targetId, el.label ?? ""),
    value: isSecretValue ? "[REDACTED]" : redactText(targetId, el.value ?? ""),
    disabled: String(!!el.disabled),
    role: el.role,
    href: el.href ?? "",
    placeholder: redactText(targetId, el.placeholder ?? ""),
    textContent:
      isSecretField && el.textContent && !el.value
        ? "[REDACTED]"
        : redactText(targetId, el.textContent ?? ""),
    className: (el.className ?? "").split(" ").filter(Boolean).sort().join(" "),
  };
}

function elementToRefEntry(el: ActionElement, targetId: string): RefEntry {
  const isSecretField = isSecretElement(el, targetId);
  const isSecretValue = isSecretField || el.value === "[REDACTED]";
  const redactedLabel = redactText(targetId, el.label ?? "");
  const redactedValue =
    el.value === undefined
      ? undefined
      : isSecretValue
      ? "[REDACTED]"
      : redactText(targetId, el.value);

  return {
    id: el.id,
    role: el.role,
    label: redactedLabel,
    type: el.type,
    href: el.href,
    disabled: el.disabled,
    value: redactedValue,
    fingerprint: el.fingerprint,
  };
}

function redactRefEntry(ref: RefEntry, targetId: string): RefEntry {
  const isPassword = ref.role === "password" || ref.type === "password";
  return {
    ...ref,
    label: redactText(targetId, ref.label ?? ""),
    ...(ref.value !== undefined
      ? { value: isPassword ? "[REDACTED]" : redactText(targetId, ref.value) }
      : {}),
  };
}

export function storeSnapshot(
  targetId: string,
  urlOrRefs: string | RefEntry[],
  maybeRefs?: RefEntry[]
): void {
  const url = typeof urlOrRefs === "string" ? urlOrRefs : "";
  const refs = Array.isArray(urlOrRefs) ? urlOrRefs : maybeRefs || [];
  const map = new Map<string, RefEntry>();
  for (const r of refs) {
    map.set(r.id, redactRefEntry(r, targetId));
  }
  snapshots.set(targetId, { url, refs: map });
}

export function seedRichSnapshot(
  targetId: string,
  urlOrElements: string | ActionElement[],
  maybeElements?: ActionElement[]
): void {
  const url = typeof urlOrElements === "string" ? urlOrElements : "";
  const rawElements = Array.isArray(urlOrElements) ? urlOrElements : maybeElements || [];
  const elements = rawElements.filter((el) => !el.selector?.includes("data-wt-internal"));

  const propMap = new Map<string, Record<string, string>>();
  const snapMap = new Map<string, RefEntry>();
  const frameMap = new Map<string, number>();

  for (const el of elements) {
    propMap.set(el.id, serializeProps(el, targetId));
    snapMap.set(el.id, elementToRefEntry(el, targetId));
    const fk = el.frameUrl || "__top__";
    frameMap.set(fk, (frameMap.get(fk) || 0) + 1);
  }

  propSnapshots.set(targetId, { url, props: propMap });
  snapshots.set(targetId, { url, refs: snapMap });
  frameSnapshots.set(targetId, frameMap);
}

export function computeDelta(
  targetId: string,
  urlOrNewRefs: string | RefEntry[],
  maybeNewRefs?: RefEntry[],
  skipHooks = false
): SnapshotDiff | null {
  const url = typeof urlOrNewRefs === "string" ? urlOrNewRefs : "";
  const newRefs = Array.isArray(urlOrNewRefs) ? urlOrNewRefs : maybeNewRefs || [];
  const prevWrapper = snapshots.get(targetId);
  if (!prevWrapper) return null;
  if (url && prevWrapper.url && prevWrapper.url !== url) return null;
  const prev = prevWrapper.refs;

  const next = new Map<string, RefEntry>();
  for (const r of newRefs) {
    next.set(r.id, redactRefEntry(r, targetId));
  }

  if (prev.size > 500) {
    snapshots.set(targetId, { url, refs: next });
    return {
      added: [],
      removed: [],
      changed: [],
      stable_count: Math.min(prev.size, next.size),
      _refs_truncated: prev.size,
    };
  }

  const added: RefEntry[] = [];
  const removed: string[] = [];
  const changed: RefEntry[] = [];
  let stable_count = 0;

  for (const [id, ref] of next) {
    const old = prev.get(id);
    if (!old) {
      added.push(ref);
    } else if (
      old.label !== ref.label ||
      old.disabled !== ref.disabled ||
      old.type !== ref.type ||
      old.href !== ref.href ||
      (ref.value !== undefined && old.value !== ref.value)
    ) {
      changed.push(ref);
    } else {
      stable_count++;
    }
  }

  for (const id of prev.keys()) {
    if (!next.has(id)) removed.push(id);
  }

  snapshots.set(targetId, { url, refs: next });

  const diff: SnapshotDiff = { added, removed, changed, stable_count };
  if (!skipHooks && (added.length > 0 || removed.length > 0 || changed.length > 0)) {
    hookPipeline
      .dispatchDOMMutation({
        type: "dom_diff",
        timestamp: Date.now(),
        url,
        added,
        removed,
        changed,
        stable_count,
        significantChange: added.length > 0 || changed.length > 0,
      })
      .catch(() => {});
  }

  return diff;
}

export async function computeRichDelta(
  targetId: string,
  urlOrNewElements: string | ActionElement[],
  maybeNewElements?: ActionElement[]
): Promise<RichDelta | null> {
  const url = typeof urlOrNewElements === "string" ? urlOrNewElements : "";
  const rawElements = Array.isArray(urlOrNewElements) ? urlOrNewElements : maybeNewElements || [];
  const newElements = rawElements.filter((el) => !el.selector?.includes("data-wt-internal"));

  const existingPropSnap = propSnapshots.get(targetId);
  if (!existingPropSnap || (url && existingPropSnap.url && existingPropSnap.url !== url)) {
    seedRichSnapshot(targetId, url, newElements);
    return null;
  }

  const oldPropMap = existingPropSnap.props;
  const newElMap = new Map<string, ActionElement>();
  const newRefs: RefEntry[] = [];

  for (const el of newElements) {
    newElMap.set(el.id, el);
    newRefs.push(elementToRefEntry(el, targetId));
  }

  const basicDiff = computeDelta(targetId, url, newRefs, true);
  if (!basicDiff) {
    seedRichSnapshot(targetId, url, newElements);
    return null;
  }

  const richChanged: RichChangedRef[] = [];
  for (const changedRef of basicDiff.changed) {
    const oldProps = oldPropMap.get(changedRef.id);
    const newEl = newElMap.get(changedRef.id);
    if (!oldProps || !newEl) {
      richChanged.push({
        ref: changedRef.id,
        role: changedRef.role,
        label: changedRef.label,
        changes: {},
      });
      continue;
    }

    const newProps = serializeProps(newEl, targetId);
    const changes: PropertyDiff = {};
    for (const key of new Set([...Object.keys(oldProps), ...Object.keys(newProps)])) {
      if (oldProps[key] !== newProps[key]) {
        changes[key] = { from: oldProps[key] ?? "", to: newProps[key] ?? "" };
      }
    }

    const isActionable = INTERACTIVE_ROLES.has(newEl.role);
    const recommendedAction = isActionable
      ? newEl.role === "link"
        ? "navigate"
        : "click"
      : undefined;

    richChanged.push({
      ref: changedRef.id,
      role: changedRef.role,
      label: changedRef.label,
      changes,
      actionable: isActionable,
      recommended_action: recommendedAction,
    });
  }

  const newFrameCounts = new Map<string, number>();
  for (const el of newElements) {
    const fk = el.frameUrl || "__top__";
    newFrameCounts.set(fk, (newFrameCounts.get(fk) || 0) + 1);
  }

  const oldFrames = frameSnapshots.get(targetId) || new Map();
  const iframeChanges: IframeChange[] = [];

  for (const [fk, count] of newFrameCounts) {
    if (fk === "__top__") continue;
    const oldCount = oldFrames.get(fk);
    if (oldCount === undefined) {
      iframeChanges.push({ frameUrl: fk, status: "added", elementCount: count });
    } else if (oldCount !== count) {
      iframeChanges.push({ frameUrl: fk, status: "changed", elementCount: count });
    }
  }

  for (const [fk] of oldFrames) {
    if (fk === "__top__") continue;
    if (!newFrameCounts.has(fk)) {
      iframeChanges.push({ frameUrl: fk, status: "removed", elementCount: 0 });
    }
  }

  frameSnapshots.set(targetId, newFrameCounts);

  const newPropMap = new Map<string, Record<string, string>>();
  for (const el of newElements) {
    newPropMap.set(el.id, serializeProps(el, targetId));
  }
  propSnapshots.set(targetId, { url, props: newPropMap });

  const richResult: RichDelta = {
    added: basicDiff.added,
    removed: basicDiff.removed,
    changed: richChanged,
    stable_count: basicDiff.stable_count,
    ...(iframeChanges.length > 0 ? { iframes: iframeChanges } : {}),
    ...(basicDiff._refs_truncated !== undefined ? { _refs_truncated: basicDiff._refs_truncated } : {}),
  };

  if (basicDiff.added.length > 0 || basicDiff.removed.length > 0 || richChanged.length > 0) {
    hookPipeline
      .dispatchDOMMutation({
        type: "rich_delta",
        timestamp: Date.now(),
        url,
        added: basicDiff.added,
        removed: basicDiff.removed,
        changed: richChanged,
        stable_count: basicDiff.stable_count,
        iframes: iframeChanges,
        significantChange: basicDiff.added.length > 0 || richChanged.some((c) => c.actionable),
      })
      .catch(() => {});
  }

  return richResult;
}

export function clearSnapshot(targetId: string): void {
  snapshots.delete(targetId);
  propSnapshots.delete(targetId);
  frameSnapshots.delete(targetId);
}

export function clearAllSnapshots(): void {
  snapshots.clear();
  propSnapshots.clear();
  frameSnapshots.clear();
}

export function getStoredRef(targetId: string, refId: string): RefEntry | undefined {
  return snapshots.get(targetId)?.refs.get(refId);
}

export function getStoredProps(targetId: string, refId: string): Record<string, string> | undefined {
  return propSnapshots.get(targetId)?.props.get(refId);
}
