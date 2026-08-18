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
  'browser_plan': 'Create a live task panel in the browser.',
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

let matchRegex = /server\.tool\(\s*"([^"]+)",\s*"([^"]+)",/g;
let updatedCode = code.replace(matchRegex, (match, name, oldDesc) => {
  if (descriptions[name]) {
    return `server.tool(\n    "${name}",\n    "${descriptions[name]}",`;
  }
  return match;
});

function injectAntiSpam(toolName, paramName, injection) {
  let toolStart = updatedCode.indexOf('"' + toolName + '"');
  if (toolStart === -1) return;
  let blockEnd = updatedCode.indexOf('server.tool(', toolStart + 10);
  if (blockEnd === -1) blockEnd = updatedCode.length;
  
  let block = updatedCode.substring(toolStart, blockEnd);
  
  let paramRegex = new RegExp(paramName + '\\s*:\\s*z\\.[^\\(]+\\([^\\)]*\\)\\.optional\\(\\)\\.describe\\(\\"([^\\"]+)\\"\\)', 'g');
  if (!paramRegex.test(block)) {
     paramRegex = new RegExp(paramName + '\\s*:\\s*z\\.[^\\(]+\\([^\\)]*\\)\\.describe\\(\\"([^\\"]+)\\"\\)', 'g');
  }
  
  block = block.replace(paramRegex, (m, desc) => {
     if (!desc.includes('DO NOT SPAM') && !desc.includes('DO NOT blindly')) {
        return m.replace(desc, desc + ' ' + injection);
     }
     return m;
  });
  
  updatedCode = updatedCode.substring(0, toolStart) + block + updatedCode.substring(blockEnd);
}

const standardAntiSpam = 'DO NOT SPAM. If action fails or loops, STOP calling this tool and use browser_map to re-evaluate the page state.';

injectAntiSpam('browser_click', 'id', standardAntiSpam);
injectAntiSpam('browser_type', 'text', standardAntiSpam);
injectAntiSpam('browser_key', 'key', standardAntiSpam);
injectAntiSpam('browser_scroll', 'id', standardAntiSpam);
injectAntiSpam('browser_wait', 'for', 'If the condition times out, DO NOT blindly retry. Re-evaluate your approach.');

fs.writeFileSync('src/server.ts', updatedCode);
console.log('Updated server.ts successfully.');

// Also update mcp.json
try {
  let mcpJson = JSON.parse(fs.readFileSync('mcp.json', 'utf8'));
  if (mcpJson.mcpServers && mcpJson.mcpServers.weavetab && mcpJson.mcpServers.weavetab.tools) {
     mcpJson.mcpServers.weavetab.tools.forEach(tool => {
        if (descriptions[tool.name]) {
           tool.description = descriptions[tool.name];
        }
     });
     fs.writeFileSync('mcp.json', JSON.stringify(mcpJson, null, 2));
     console.log('Updated mcp.json successfully.');
  }
} catch (e) {
  console.error('Could not update mcp.json', e);
}
