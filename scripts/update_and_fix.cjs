const fs = require('fs');
let code = fs.readFileSync('src/server.ts', 'utf8');

const descriptions = {
  'browser_map': 'Snapshot interactive DOM with stable ref IDs.',
  'browser_navigate': 'Navigate to a URL.',
  'browser_click': 'Click an element.',
  'browser_captcha': 'Detect and solve CAPTCHAs.',
  'browser_type': 'Type text into an input field.',
  'browser_type_secret': 'Inject a secret from an environment variable.',
  'browser_key': 'Press a keyboard key.',
  'browser_scroll': 'Scroll the page.',
  'browser_dialog': 'Accept or dismiss JS dialogs.',
  'browser_burst': 'Chain multiple tool calls in one round-trip.',
  'browser_tabs': 'Manage browser tabs (open, switch, close, list).',
  'browser_wait': 'Pause until a condition is met.',
  'browser_thought': 'Send a message or question to the user via UI.',
  'browser_pointer': 'Advanced pointer control (hover, drag).',
  'browser_select': 'Select an option from a native dropdown.',
  'browser_fill': 'Smart form-filling for various input types.',
  'github_analyze': 'Analyze a GitHub repository.',
  'github_read': 'Read file contents from a GitHub repository.',
  'github_issues': 'Interact with GitHub issues.',
  'github_get_pr': 'Interact with GitHub pull requests.',
  'browser_highlight': 'Highlight an element with a colored overlay.',
  'browser_upload': 'Upload files to a file input.',
  'browser_storage': 'Manage localStorage and sessionStorage.',
  'browser_network_intercept': 'Intercept and stub network responses.',
  'browser_console': 'Read or clear console logs.',
  'browser_pdf': 'Print the current page to a PDF file.',
  'browser_eval': 'Run arbitrary JavaScript in the page context.',
  'browser_cookies': 'Manage browser cookies.',
  'browser_canvas': 'Interact with Canvas elements.',
  'browser_scrape': 'Extract attributes from multiple elements.',
  'browser_snapshot': 'Capture or restore an MHTML snapshot.',
  'browser_screenshot': 'Capture a screenshot of the current tab.',
  'browser_viewport': 'Set viewport dimensions and device emulation.',
  'browser_clipboard': 'Read or write to the system clipboard.',
  'browser_inspect': 'Deep DOM inspection for debugging.',
  'browser_automation': 'Inject and manage a self-running background script.',
  'browser_recording': 'Record a video screencast.',
  'browser_reset_loop_counter': 'Reset the loop detection counter.',
  'browser_detect': 'Detect available browsers on the machine.',
  'browser_performance': 'Retrieve page performance metrics.',
  'browser_office_parse': 'Parse a downloaded or remote document.',
  'browser_macro_compile': 'Compile a recent trail into a burst macro.'
};

// Safe tool description replacement
for (const [name, desc] of Object.entries(descriptions)) {
  const toolDefRegex = new RegExp(`server\\.tool\\(\\s*"${name}",\\s*"([^"]+)",`, 'g');
  code = code.replace(toolDefRegex, `server.tool(\n    "${name}",\n    "${desc}",`);
}

// Add Anti-spam to parameter descriptions safely
function injectAntiSpam(toolName, paramName, injection) {
  let idx = code.indexOf(`"${toolName}"`);
  if (idx === -1) return;
  let nextIdx = code.indexOf('server.tool(', idx + 10);
  if (nextIdx === -1) nextIdx = code.length;
  
  let toolChunk = code.substring(idx, nextIdx);
  let paramRegex = new RegExp(`${paramName}\\s*:\\s*z\\.[^\\(]+\\([^\\)]*\\)\\.optional\\(\\)\\.describe\\(\\"([^\\"]+)\\"\\)`, 'g');
  if (!paramRegex.test(toolChunk)) {
    paramRegex = new RegExp(`${paramName}\\s*:\\s*z\\.[^\\(]+\\([^\\)]*\\)\\.describe\\(\\"([^\\"]+)\\"\\)`, 'g');
  }
  
  toolChunk = toolChunk.replace(paramRegex, (match, desc) => {
    if (!desc.includes('DO NOT SPAM') && !desc.includes('DO NOT blindly')) {
      return match.replace(desc, desc + ' ' + injection);
    }
    return match;
  });
  code = code.substring(0, idx) + toolChunk + code.substring(nextIdx);
}

const standardAntiSpam = 'DO NOT SPAM. If action fails or loops, STOP calling this tool and use browser_map to re-evaluate the page state.';
injectAntiSpam('browser_click', 'id', standardAntiSpam);
injectAntiSpam('browser_type', 'text', standardAntiSpam);
injectAntiSpam('browser_key', 'key', standardAntiSpam);
injectAntiSpam('browser_scroll', 'id', standardAntiSpam);
injectAntiSpam('browser_wait', 'for', 'If the condition times out, DO NOT blindly retry. Re-evaluate your approach.');

// Fix 1: Stdout/Stdin aggressive check
const target1 = `    process.stdin.on("close", exitOnClose);
    process.stdin.on("end", exitOnClose);`;
const replacement1 = `    process.stdin.on("close", exitOnClose);
    process.stdin.on("end", exitOnClose);
    process.stdout.on("error", exitOnClose);
    process.stdin.on("error", exitOnClose);
    
    // Windows aggressive zombie process prevention
    setInterval(() => {
      try {
        if (process.stdin.destroyed || process.stdout.destroyed) {
          exitOnClose();
        }
      } catch (e) {
        exitOnClose();
      }
    }, 2000).unref();`;
code = code.replace(target1, replacement1);

// Fix 2: Global uncaughtException handler
const target2 = `process.on("unhandledRejection", (reason) => {
  logDebug("[Weavetab] Unhandled rejection (non-fatal):", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  logDebug("[Weavetab] Uncaught exception (non-fatal):", err.message);
});`;
const replacement2 = `process.on("unhandledRejection", (reason) => {
  logDebug("[Weavetab] Unhandled rejection (non-fatal):", reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error && (reason.message.includes("EPIPE") || reason.message.includes("ECONNRESET") || reason.message.includes("EOF"))) {
    process.exit(0);
  }
});
process.on("uncaughtException", (err) => {
  logDebug("[Weavetab] Uncaught exception (non-fatal):", err.message);
  if (err.message.includes("EPIPE") || err.message.includes("ECONNRESET") || err.message.includes("EOF")) {
    process.exit(0);
  }
});`;
code = code.replace(target2, replacement2);

fs.writeFileSync('src/server.ts', code, 'utf8');
console.log('Fixed server.ts');
