/**
 * Weavetab by fy2ne
 * @file schema.ts — Plugin tool schema normalizer.
 *
 * Converts a plugin-provided tool schema into a Zod raw shape accepted by
 * `McpServer.tool()`. Supports the three shapes plugin authors may provide:
 *   1. Zod raw shape        — { field: z.string() }            (preferred)
 *   2. Zod object schema    — z.object({ field: z.string() })
 *   3. Plain JSON Schema    — { type: "object", properties: { field: { type: "string" } } }
 */

import { z } from "zod";

export function toPluginInputShape(schema: any): Record<string, any> {
  if (!schema || typeof schema !== "object") return {};

  // A Zod object/schema instance (e.g. z.object({...})) — use its shape.
  if (schema._def || schema._zod) {
    const shape = typeof schema.shape === "function" ? schema.shape() : schema.shape;
    return shape && typeof shape === "object" ? shape : {};
  }

  // A raw shape: an object whose values are Zod schemas.
  const values = Object.values(schema);
  if (values.some((v: any) => v && typeof v === "object" && (v._def || v._zod || typeof v.parse === "function"))) {
    return schema as Record<string, any>;
  }

  // A plain JSON Schema object — convert its properties into a Zod raw shape.
  if (schema.properties && typeof schema.properties === "object") {
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    const shape: Record<string, any> = {};
    for (const [key, prop] of Object.entries<any>(schema.properties)) {
      let field: any;
      switch (prop?.type) {
        case "number":
        case "integer":
          field = z.number();
          break;
        case "boolean":
          field = z.boolean();
          break;
        case "array":
          field = z.array(z.any());
          break;
        case "object":
          field = z.record(z.string(), z.any());
          break;
        default:
          field = z.string();
      }
      if (typeof prop?.description === "string") field = field.describe(prop.description);
      if (prop?.default !== undefined) field = field.default(prop.default);
      if (!required.includes(key)) field = field.optional();
      shape[key] = field;
    }
    return shape;
  }

  return {};
}
