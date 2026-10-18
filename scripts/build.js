import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const node = process.execPath;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

function sizeOf(relPath) {
  try {
    return `${(fs.statSync(path.join(root, relPath)).size / 1024).toFixed(1)} kB`;
  } catch {
    return null;
  }
}

const steps = [
  {
    title: 'Chrome extension',
    detail: 'service worker + content scripts',
    cmd: [node, 'scripts/build-ext.js'],
    artifacts: ['ext-dist/background.js', 'ext-dist/content.js', 'ext-dist/styles.css'],
  },
  {
    title: 'HUD overlay',
    detail: 'bundled widget layer',
    cmd: [
      node,
      'node_modules/esbuild/bin/esbuild',
      'ext-dist/hud/src/index.ts',
      '--bundle',
      '--minify',
      '--format=iife',
      '--log-level=warning',
      '--outfile=ext-dist/hud/hud.js',
    ],
    artifacts: ['ext-dist/hud/hud.js'],
  },
  {
    title: 'MCP server',
    detail: 'TypeScript compilation to dist/',
    cmd: [node, 'node_modules/typescript/bin/tsc'],
    artifacts: [],
  },
];

const line = `${C.dim}${'─'.repeat(64)}${C.reset}`;

console.log('');
console.log(`${C.bold}${C.cyan}Weavetab MCP${C.reset} ${C.dim}— production build${C.reset}`);
console.log(`${C.dim}Compiling the MCP server, Chrome extension, and HUD overlay.${C.reset}`);
console.log(line);

const start = Date.now();
let failed = false;

for (const step of steps) {
  const r = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: root, encoding: 'utf8' });
  const ok = r.status === 0;
  const sizes = step.artifacts.map(sizeOf).filter(Boolean).join('  ·  ');
  const badge = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;

  console.log(` ${badge}  ${step.title} ${C.dim}· ${step.detail}${C.reset}`);
  if (ok && sizes) {
    console.log(`      ${C.dim}${sizes}${C.reset}`);
  }
  if (ok && r.stdout && r.stdout.trim()) {
    for (const l of r.stdout.trim().split(/\r?\n/)) {
      console.log(`      ${C.dim}${l}${C.reset}`);
    }
  }
  if (!ok) {
    failed = true;
    console.log('');
    console.log(`${C.red}${step.title} failed${C.reset}`);
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    break;
  }
}

console.log(line);
const secs = ((Date.now() - start) / 1000).toFixed(2);

if (failed) {
  console.log(`${C.red}Build failed${C.reset} ${C.dim}— ${secs}s${C.reset}`);
  console.log('');
  process.exit(1);
}

console.log(`${C.green}Build complete${C.reset} ${C.dim}— ${steps.length}/${steps.length} targets · ${secs}s${C.reset}`);
console.log('');
