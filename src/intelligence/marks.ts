/**
 * Weavetab — intelligence/marks.ts
 * Visual grounding mark cache.
 *
 * When browser_map runs with visual: true/auto, numbered SoM badges are
 * injected over the page, a screenshot is taken, and each badge's position
 * and optional DOM ref are stored here. Interaction tools (browser_click,
 * browser_pointer, etc.) can then resolve a { mark: N } argument directly
 * to pixel coordinates without any further DOM walk.
 *
 * Weavetab by fy2ne
 */

export interface MarkEntry {
  /** Center X coordinate (viewport-relative pixels). */
  x: number;
  /** Center Y coordinate (viewport-relative pixels). */
  y: number;
  /** Width of the element bounding box. */
  width: number;
  /** Height of the element bounding box. */
  height: number;
  /** Volatile ref ID (w:NN) if the element is DOM-backed. Undefined for canvas/visual-only regions. */
  ref?: string;
  /** Visible text or aria-label, if available. */
  label?: string;
  /** Element type hint. */
  type?: "button" | "input" | "link" | "select" | "canvas_region" | "unknown";
}

/** Per-tab: Map<targetId, Map<markNumber, MarkEntry>> */
const store = new Map<string, Map<number, MarkEntry>>();

/** Write a full set of marks for a tab. Replaces any previous marks. */
export function marksSet(targetId: string, marks: Map<number, MarkEntry>): void {
  store.set(targetId, marks);
}

/** Look up a single mark for a tab. Returns null if not found. */
export function marksGet(targetId: string, mark: number): MarkEntry | null {
  return store.get(targetId)?.get(mark) ?? null;
}

/** Clear all marks for a tab (called on navigation). */
export function marksInvalidate(targetId: string): void {
  store.delete(targetId);
}

/** Return all marks for a tab (used for debugging / list output). */
export function marksGetAll(targetId: string): Map<number, MarkEntry> {
  return store.get(targetId) ?? new Map();
}
