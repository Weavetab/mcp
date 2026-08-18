const fs = require('fs');

const path = './mcp.json';
let content = fs.readFileSync(path, 'utf8');

const replacements = [
  {
    regex: /"description": "Human-like clicking with Ghost Cursor Bézier curves and acceleration profiles"/g,
    replacement: '"description": "Human-like clicking. DO NOT SPAM. If click fails, DO NOT retry blindly. Call browser_map to re-evaluate the page state."'
  },
  {
    regex: /"description": "Send keyboard events including special keys and combinations"/g,
    replacement: '"description": "Send keyboard events. DO NOT SPAM. If pressing a key (like Enter) has no effect, DO NOT retry. Ensure an element is focused or call browser_map to find a submit button."'
  },
  {
    regex: /"description": "Human-like typing with burst patterns, character jitter, and natural pauses"/g,
    replacement: '"description": "Human-like typing. DO NOT SPAM. If typing fails, do not blindly retry. Call browser_map to re-evaluate."'
  },
  {
    regex: /"description": "Intelligent waiting for network, DOM, or custom conditions"/g,
    replacement: '"description": "Intelligent wait. DO NOT blindly spam. If timeout is reached, do not retry the exact same condition."'
  },
  {
    regex: /"description": "Natural scrolling with velocity and acceleration profiles"/g,
    replacement: '"description": "Natural scrolling. Do not blindly spam scroll if nothing is revealed. Re-evaluate with browser_map."'
  },
  {
    regex: /"description": "Advanced pointer control with hover and drag operations"/g,
    replacement: '"description": "Advanced pointer control. DO NOT SPAM. If action fails, verify visibility with browser_map."'
  }
];

let changed = false;
for (const r of replacements) {
  if (content.match(r.regex)) {
    content = content.replace(r.regex, r.replacement);
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(path, content, 'utf8');
  console.log('Successfully updated mcp.json');
} else {
  console.log('No changes made to mcp.json');
}
