const fs = require('fs');

const path = './src/server.ts';
let content = fs.readFileSync(path, 'utf8');

const replacements = [
  {
    regex: /"Click element by ref ID \(w:NN\) or label via Ghost Cursor\. Cannot click invisible or occluded elements\."/g,
    replacement: '"Click element by ref ID (w:NN) or label. DO NOT SPAM. If click fails, DO NOT retry blindly. Call browser_map to re-evaluate the page state. Cannot click invisible elements."'
  },
  {
    regex: /"Press key with modifiers \(Ctrl\/Shift\/Alt\)\. Cannot press if no element focused or CDP disconnected\."/g,
    replacement: '"Press key. DO NOT SPAM. If pressing a key (like Enter) has no effect, DO NOT retry. Ensure an element is focused or call browser_map to find a submit button."'
  },
  {
    regex: /"Type into input field\. Cannot type if field disabled\/readonly or CDP disconnected\."/g,
    replacement: '"Type into input field. DO NOT SPAM. If typing fails, do not blindly retry. Call browser_map to re-evaluate."'
  },
  {
    regex: /"Pause until condition met \(element, text, URL, stable, network\)\. Cannot wait indefinitely \(has timeout\)\."/g,
    replacement: '"Pause until condition met. DO NOT blindly spam. If timeout is reached, do not retry the exact same condition."'
  },
  {
    regex: /"Scroll page or element via mouse wheel\. Cannot scroll if element not scrollable\."/g,
    replacement: '"Scroll page. Do not blindly spam scroll if nothing is revealed. Re-evaluate with browser_map."'
  },
  {
    regex: /"Hover, click, double-click, or drag via native mouse events\. Cannot interact if element invisible\."/g,
    replacement: '"Advanced pointer control. DO NOT SPAM. If action fails, verify visibility with browser_map."'
  },
  {
    regex: /"Navigate to a URL\. One call per navigation — do not chain\. Fails on invalid URLs or crashed browser\."/g,
    replacement: '"Navigate to URL. Fails on invalid URLs. DO NOT retry the exact same URL if it fails."'
  }
];

let changed = false;
for (const r of replacements) {
  if (content.match(r.regex)) {
    content = content.replace(r.regex, r.replacement);
    changed = true;
  } else {
    console.warn('Regex not found:', r.regex);
  }
}

if (changed) {
  fs.writeFileSync(path, content, 'utf8');
  console.log('Successfully updated src/server.ts');
} else {
  console.log('No changes made');
}
