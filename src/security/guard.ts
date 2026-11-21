import CDP from "chrome-remote-interface";

export function assertNotRoot(): void {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error("[!] Weave failed: Running as root is not allowed. Start Weavetab as a normal user.");
  }
}

const STORAGE_BLOCK_SCRIPT = `
(function() {
  var _origCookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (_origCookieDesc && _origCookieDesc.get && _origCookieDesc.set) {
    Object.defineProperty(document, 'cookie', {
      get: function() { return _origCookieDesc.get.call(document); },
      set: function(v) {
        if (/(_ga|_gid|_fbp|_fbc|__utm|fr|_gcl)/.test(v)) return;
        _origCookieDesc.set.call(document, v);
      },
      configurable: true
    });
  }
})();
`;

export async function blockStorageAccess(session: CDP.Client): Promise<void> {
  await session.Page.addScriptToEvaluateOnNewDocument({
    source: STORAGE_BLOCK_SCRIPT,
  });

  await session.Runtime.evaluate({
    expression: STORAGE_BLOCK_SCRIPT,
    returnByValue: false,
  });
}
