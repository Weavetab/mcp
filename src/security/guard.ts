/**
 * Weavetab — security/guard.ts
 * Root process guard and browser-side storage access blocker via CDP Page API.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";

export function assertNotRoot(): void {
  // process.getuid is Unix-only; on Windows it doesn't exist which is fine
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error("[!] Weave failed: Running as root is not allowed. Start Weavetab as a normal user.");
  }
}

const STORAGE_BLOCK_SCRIPT = `
(function() {
  // Only block cookie WRITES for known tracking domains, not reads.
  // Fully blocking storage breaks site rendering (GitHub, etc.)
  var _origCookieDesc = Object.getOwnPropertyDescriptor(document, 'cookie');
  if (_origCookieDesc) {
    Object.defineProperty(document, 'cookie', {
      get: function() { return _origCookieDesc.get.call(document); },
      set: function(v) {
        // Block cookies from known trackers
        if (/(_ga|_gid|_fbp|_fbc|__utm|fr|_gcl)/.test(v)) return;
        _origCookieDesc.set.call(document, v);
      },
      configurable: true
    });
  }
  // Do NOT block localStorage/sessionStorage — sites need them to render
})();
`;

export async function blockStorageAccess(session: CDP.Client): Promise<void> {
  await session.Page.addScriptToEvaluateOnNewDocument({
    source: STORAGE_BLOCK_SCRIPT,
  });

  // Also apply immediately to the current page context
  await session.Runtime.evaluate({
    expression: STORAGE_BLOCK_SCRIPT,
    returnByValue: false,
  });
}
