/**
 * Weavetab — tools/storage.ts
 * browser_storage: read/write localStorage and sessionStorage via Runtime.evaluate.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";

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

  if (action === "get") {
    if (!key) throw new Error("browser_storage get requires a 'key'");
    const { result } = await session.Runtime.evaluate({
      // Use JSON.stringify to safely embed the key — no raw string interpolation
      expression: `(function(k){ return ${scope}Storage.getItem(k); })(${JSON.stringify(key)})`,
      returnByValue: true
    });
    return { success: true, result: result.value as string | null };
  } 
  
  else if (action === "set") {
    if (!key || value === undefined) throw new Error("browser_storage set requires 'key' and 'value'");
    await session.Runtime.evaluate({
      // Use JSON.stringify to safely embed key and value — no raw string interpolation
      expression: `(function(k,v){ ${scope}Storage.setItem(k,v); })(${JSON.stringify(key)}, ${JSON.stringify(value ?? "")})`
    });
    return { success: true, message: `Set ${scope}Storage key ${key}` };
  } 

  else if (action === "remove") {
    if (!key) throw new Error("browser_storage remove requires a 'key'");
    await session.Runtime.evaluate({
      expression: `(function(k){ ${scope}Storage.removeItem(k); })(${JSON.stringify(key)})`
    });
    return { success: true, message: `Removed ${scope}Storage key ${key}` };
  }

  else if (action === "list") {
    const { result } = await session.Runtime.evaluate({
      expression: `(function(){ var out = []; var s = ${scope}Storage; for (var i = 0; i < s.length; i++) { var k = s.key(i); out.push({ key: k, value: s.getItem(k) }); } return out; })()`,
      returnByValue: true
    });
    const data = Array.isArray(result.value) ? (result.value as { key: string; value: string | null }[]) : [];
    return { success: true, data, message: `${scope}Storage has ${data.length} key(s)` };
  }

  else if (action === "clear") {
    await session.Runtime.evaluate({
      expression: `${scope}Storage.clear()`
    });
    return { success: true, message: `Cleared ${scope}Storage` };
  }

  throw new Error(`Unknown action: ${action}`);
}
