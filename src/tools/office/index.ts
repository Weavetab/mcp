/**
 * Weavetab — tools/office/index.ts
 * Re-exports office document tools for agent consumption.
 * Weavetab by fy2ne
 */
export { browserOfficeParse } from "./parse.js";
export type { OfficeParseOptions, OfficeParseResult } from "./parse.js";
export { browserOfficeList } from "./list.js";
export type { OfficeListResult } from "./list.js";
