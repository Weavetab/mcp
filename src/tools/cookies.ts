/**
 * Weavetab — tools/cookies.ts
 * browser_cookies: Read and inject browser cookies via the CDP Network domain.
 *
 * Use this tool to:
 * - GET: Read all cookies for the current page's URL (for inspection or debugging)
 * - SET: Inject a cookie to pre-authenticate a session without logging in manually
 * - DELETE: Remove a specific cookie by name and domain
 *
 * This is the correct tool for session pre-authentication. Do NOT use browser_eval
 * for cookie manipulation — this tool uses the proper CDP Network domain which
 * works correctly with HttpOnly and Secure cookies.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export interface CookiesGetResult {
  success: true;
  action: "get";
  cookies: CookieEntry[];
  count: number;
  found?: boolean;
  message?: string;
}

export interface CookiesSetResult {
  success: true;
  action: "set";
  name: string;
}

export interface CookiesDeleteResult {
  success: true;
  action: "delete";
  name: string;
}

export type CookiesResult = CookiesGetResult | CookiesSetResult | CookiesDeleteResult;

export interface CookieSetOptions {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export async function browserCookies(
  session: CDP.Client,
  args: {
    action: "get" | "set" | "delete";
    name?: string;
    value?: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    url?: string;
  },
  _config: Config
): Promise<CookiesResult> {
  if (args.action === "get") {
    // Get current page URL for scoping
    const { frameTree } = await session.Page.getFrameTree();
    const pageUrl = args.url ?? frameTree.frame.url;

    const { cookies } = await session.Network.getCookies({ urls: [pageUrl] });

    let mapped: CookieEntry[] = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));

    // Honor the name filter
    let found: boolean | undefined;
    let message: string | undefined;
    
    if (args.name) {
      mapped = mapped.filter(c => c.name === args.name);
      found = mapped.length > 0;
      if (!found) {
        message = `Cookie with name '${args.name}' was not found for the given URL.`;
      }
    }

    return { 
      success: true, 
      action: "get", 
      cookies: mapped, 
      count: mapped.length,
      ...(found !== undefined ? { found } : {}),
      ...(message ? { message } : {})
    };
  }

  if (args.action === "set") {
    if (!args.name) throw new Error("browser_cookies set: 'name' is required");
    if (args.value === undefined) throw new Error("browser_cookies set: 'value' is required");

    // Resolve domain from current page if not provided
    let domain = args.domain;
    let pageUrl = args.url;
    if (!domain || args.secure === undefined) {
      const { frameTree } = await session.Page.getFrameTree();
      pageUrl = pageUrl ?? frameTree.frame.url;
      try {
        const u = new URL(pageUrl);
        if (!domain) domain = u.hostname;
        // Default secure to true for https pages
        if (args.secure === undefined && u.protocol === "https:") {
          args.secure = true;
        }
      } catch {
        if (!domain) throw new Error("browser_cookies set: could not determine domain — provide 'domain' explicitly.");
      }
    }

    await session.Network.setCookie({
      name: args.name,
      value: args.value,
      domain,
      path: args.path ?? "/",
      expires: args.expires,
      httpOnly: args.httpOnly ?? false,
      secure: args.secure ?? false,
      sameSite: args.sameSite,
    });

    return { success: true, action: "set", name: args.name };
  }

  if (args.action === "delete") {
    if (!args.name) throw new Error("browser_cookies delete: 'name' is required");

    // Resolve the URL to scope the cookie lookup
    let pageUrl = args.url;
    if (!pageUrl) {
      const { frameTree } = await session.Page.getFrameTree();
      pageUrl = frameTree.frame.url;
    }

    if (args.domain) {
      await session.Network.deleteCookies({
        name: args.name,
        domain: args.domain,
        path: args.path ?? "/",
      });
      return { success: true, action: "delete", name: args.name };
    }

    // deleteCookies requires the domain to match exactly how the cookie was
    // stored (e.g. ".github.com" with a leading dot). Fetch all matching 
    // cookies and delete each using its exact stored domain and path.
    try {
      const { cookies: existing } = await session.Network.getCookies({ urls: [pageUrl] });
      const matches = existing.filter(c => c.name === args.name);
      
      if (matches.length > 0) {
        for (const cookie of matches) {
          await session.Network.deleteCookies({
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
          });
        }
      } else {
        // Fallback: derive hostname; won't work for subdomain cookies but attempts a best-effort deletion.
        const domain = new URL(pageUrl).hostname;
        await session.Network.deleteCookies({
          name: args.name,
          domain,
          path: args.path ?? "/",
        });
      }
    } catch {
      throw new Error("browser_cookies delete: could not determine domain — provide 'domain' explicitly.");
    }

    return { success: true, action: "delete", name: args.name };
  }

  throw new Error(`browser_cookies: unknown action "${args.action}"`);
}
