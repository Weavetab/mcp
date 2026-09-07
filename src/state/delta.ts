// src/state/delta.ts
// Per-tab snapshot diffing for delta reads (Rule 11).
// weave_read first visit → full snapshot stored here.
// Subsequent calls → diff against stored snapshot → return only changed refs.

import { SessionSecretTracker } from "../security/secrets.js";
import type { ActionElement as _ActionElement } from "../cdp/walker.js";
import { hookPipeline } from "../plugin/pipeline.js";
export type ActionElement = _ActionElement;

export interface RefEntry {
  id: string;         // "w:42"
  role: string;
  label: string;
  type?: string;
  value?: string;
  href?: string;
  disabled?: boolean;
  fingerprint: string; // role:normalizedLabel:parentRole:depth
}

export interface SnapshotDiff {
  added: RefEntry[];
  removed: string[];   // ref IDs that disappeared
  changed: RefEntry[]; // refs whose label/state changed
  stable_count: number;
  _refs_truncated?: number; // set when diff was truncated (>500 refs)
}

// ── Rich delta types (Phase 5e) ──────────────────────────────────────────────

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
}

const snapshots = new Map<string, { url: string; refs: Map<string, RefEntry> }>();
const propSnapshots = new Map<string, { url: string; props: Map<string, Record<string, string>> }>();
const frameSnapshots = new Map<string, Map<string, number>>();

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox',
  'checkbox', 'radio', 'menuitem', 'tab', 'select',
]);

function serializeProps(el: ActionElement, targetId?: string): Record<string, string> {
  const isSecret = (el.backendNodeId !== undefined && targetId &&
    SessionSecretTracker.isNodeSecret(targetId, el.backendNodeId)) ||
    el.label === '[REDACTED]' ||
    el.value === '[REDACTED]' ||
    el.role === 'password' ||
    el.type === 'password';
  return {
    label: isSecret ? '[REDACTED]' : (targetId ? SessionSecretTracker.redact(targetId, el.label ?? '') : (el.label ?? '')),
    value: isSecret ? '[REDACTED]' : (targetId ? SessionSecretTracker.redact(targetId, el.value ?? '') : (el.value ?? '')),
    disabled: String(!!el.disabled),
    role: el.role,
    href: el.href ?? '',
    placeholder: isSecret ? '[REDACTED]' : (targetId ? SessionSecretTracker.redact(targetId, el.placeholder ?? '') : (el.placeholder ?? '')),
    textContent: isSecret ? '[REDACTED]' : (targetId ? SessionSecretTracker.redact(targetId, el.textContent ?? '') : (el.textContent ?? '')),
    className: (el.className ?? '').split(' ').filter(Boolean).sort().join(' '),
  };
}

/**
 * Store a full snapshot for a tab target.
 */
export function storeSnapshot(
  targetId: string,
  urlOrRefs: string | RefEntry[],
  maybeRefs?: RefEntry[]
): void {
  const url = typeof urlOrRefs === 'string' ? urlOrRefs : '';
  const refs = Array.isArray(urlOrRefs) ? urlOrRefs : (maybeRefs || []);
  const map = new Map<string, RefEntry>();
  for (const r of refs) map.set(r.id, r);
  snapshots.set(targetId, { url, refs: map });
}

/**
 * Eagerly initialize the property snapshot cache for a tab.
 */
export function seedRichSnapshot(
  targetId: string,
  urlOrElements: string | ActionElement[],
  maybeElements?: ActionElement[]
): void {
  const url = typeof urlOrElements === 'string' ? urlOrElements : '';
  const elements = Array.isArray(urlOrElements) ? urlOrElements : (maybeElements || []);
  const propMap = new Map<string, Record<string, string>>();
  const snapMap = new Map<string, RefEntry>();
  const frameMap = new Map<string, number>();
  for (const el of elements) {
    propMap.set(el.id, serializeProps(el, targetId));
    snapMap.set(el.id, {
      id: el.id,
      role: el.role,
      label: el.label,
      type: el.type,
      href: el.href,
      disabled: el.disabled,
      value: el.value,
      fingerprint: el.fingerprint,
    });
    const fk = el.frameUrl || '__top__';
    frameMap.set(fk, (frameMap.get(fk) || 0) + 1);
  }
  propSnapshots.set(targetId, { url, props: propMap });
  snapshots.set(targetId, { url, refs: snapMap });
  frameSnapshots.set(targetId, frameMap);
}

/**
 * Compute basic delta.
 */
export function computeDelta(
  targetId: string,
  urlOrNewRefs: string | RefEntry[],
  maybeNewRefs?: RefEntry[]
): SnapshotDiff | null {
  const url = typeof urlOrNewRefs === 'string' ? urlOrNewRefs : '';
  const newRefs = Array.isArray(urlOrNewRefs) ? urlOrNewRefs : (maybeNewRefs || []);
  const prevWrapper = snapshots.get(targetId);
  if (!prevWrapper) return null;
  if (url && prevWrapper.url && prevWrapper.url !== url) return null;
  const prev = prevWrapper.refs;

  const next = new Map<string, RefEntry>();
  for (const r of newRefs) next.set(r.id, r);

  // Short-circuit: for maps with 500+ refs, return count-only diff
  // to avoid O(n) comparison hanging on large pages.
  if (prev.size > 500) {
    const addedCount = next.size - prev.size;
    const removedCount = Array.from(prev.keys()).filter(id => !next.has(id)).length;
    snapshots.set(targetId, { url, refs: next });
    return { added: [], removed: [], changed: [], stable_count: Math.min(prev.size, next.size), _refs_truncated: prev.size };
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
  if (added.length > 0 || removed.length > 0 || changed.length > 0) {
    hookPipeline.dispatchDOMMutation({
      type: "dom_diff",
      timestamp: Date.now(),
      url,
      added,
      removed,
      changed,
      stable_count,
      significantChange: added.length > 0 || changed.length > 0,
    }).catch(() => {});
  }

  return diff;
}

/**
 * Rich delta: wraps computeDelta with property-level change details.
 */
export async function computeRichDelta(
  targetId: string,
  urlOrNewElements: string | ActionElement[],
  maybeNewElements?: ActionElement[]
): Promise<RichDelta | { delta_timeout: true } | null> {
  const url = typeof urlOrNewElements === 'string' ? urlOrNewElements : '';
  const newElements = Array.isArray(urlOrNewElements) ? urlOrNewElements : (maybeNewElements || []);

  // Wrap computation in a 5-second race against a timeout to avoid O(n^2) hangs
  const computePromise = new Promise<RichDelta | null>((resolve) => {
    if (!propSnapshots.has(targetId) || (url && propSnapshots.get(targetId)!.url && propSnapshots.get(targetId)!.url !== url)) {
      seedRichSnapshot(targetId, url, newElements);
      resolve(null);
      return;
    }

    const oldPropMap = propSnapshots.get(targetId)!.props;
    const newRefs: RefEntry[] = newElements
      .filter(el => !el.selector?.includes('data-wt-internal'))
      .map(el => ({
      id: el.id,
      role: el.role,
      label: el.label,
      type: el.type,
      href: el.href,
      disabled: el.disabled,
      value: el.value,
      fingerprint: el.fingerprint,
    }));

    const basicDiff = computeDelta(targetId, url, newRefs);
    if (!basicDiff) {
      resolve(null);
      return;
    }

    // Compute rich changes with property diffs
    const richChanged: RichChangedRef[] = [];
    for (const changedRef of basicDiff.changed) {
      const oldProps = oldPropMap.get(changedRef.id);
      const newEl = newElements.find(e => e.id === changedRef.id);
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
      for (const key of [...new Set([...Object.keys(oldProps), ...Object.keys(newProps)])]) {
        if (oldProps[key] !== newProps[key]) {
          changes[key] = { from: oldProps[key] ?? '', to: newProps[key] ?? '' };
        }
      }

      const isActionable = INTERACTIVE_ROLES.has(newEl.role);
      let recommendedAction: string | undefined;
      if (isActionable) {
        recommendedAction = newEl.role === 'link' ? 'navigate' : 'click';
      }

      richChanged.push({
        ref: changedRef.id,
        role: changedRef.role,
        label: changedRef.label,
        changes,
        actionable: isActionable,
        recommended_action: recommendedAction,
      });
    }

    // ── Phase 5d: Iframe-aware content tracking ──────────────────────────────
    const newFrameCounts = new Map<string, number>();
    for (const el of newElements) {
      const fk = el.frameUrl || '__top__';
      newFrameCounts.set(fk, (newFrameCounts.get(fk) || 0) + 1);
    }

    const oldFrames = frameSnapshots.get(targetId) || new Map();
    const iframeChanges: IframeChange[] = [];

    // Detect added/changed frames
    for (const [fk, count] of newFrameCounts) {
      if (fk === '__top__') continue;
      const oldCount = oldFrames.get(fk);
      if (oldCount === undefined) {
        iframeChanges.push({ frameUrl: fk, status: "added", elementCount: count });
      } else if (oldCount !== count) {
        iframeChanges.push({ frameUrl: fk, status: "changed", elementCount: count });
      }
    }

    // Detect removed frames
    for (const [fk] of oldFrames) {
      if (fk === '__top__') continue;
      if (!newFrameCounts.has(fk)) {
        iframeChanges.push({ frameUrl: fk, status: "removed", elementCount: 0 });
      }
    }

    frameSnapshots.set(targetId, newFrameCounts);

    // Update property snapshot
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
    };

    if (basicDiff.added.length > 0 || basicDiff.removed.length > 0 || richChanged.length > 0) {
      hookPipeline.dispatchDOMMutation({
        type: "rich_delta",
        timestamp: Date.now(),
        url,
        added: basicDiff.added,
        removed: basicDiff.removed,
        changed: richChanged,
        stable_count: basicDiff.stable_count,
        iframes: iframeChanges,
        significantChange: basicDiff.added.length > 0 || richChanged.some(c => c.actionable),
      }).catch(() => {});
    }

    resolve(richResult);
  });

  const timeoutPromise = new Promise<{ delta_timeout: true }>((resolve) => {
    setTimeout(() => resolve({ delta_timeout: true }), 5000);
  });

  return Promise.race([computePromise, timeoutPromise]);
}

/**
 * Clear snapshot for a tab (called on hard navigation).
 */
export function clearSnapshot(targetId: string): void {
  snapshots.delete(targetId);
  frameSnapshots.delete(targetId);
}

/**
 * Clear all snapshots (called on CDP disconnect).
 */
export function clearAllSnapshots(): void {
  snapshots.clear();
  propSnapshots.clear();
  frameSnapshots.clear();
}

/**
 * Get stored ref entry from snapshot for recovery of detached nodes.
 */
export function getStoredRef(targetId: string, refId: string): RefEntry | undefined {
  return snapshots.get(targetId)?.refs.get(refId);
}

/**
 * Get stored element properties from rich snapshot for recovery.
 */
export function getStoredProps(targetId: string, refId: string): Record<string, string> | undefined {
  return propSnapshots.get(targetId)?.props.get(refId);
}

