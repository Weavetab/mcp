import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadJson(filename) {
  const filepath = resolve(root, filename);
  try {
    return JSON.parse(readFileSync(filepath, 'utf8'));
  } catch (err) {
    console.error(`[Weavetab Verify] Failed to read ${filename}: ${err.message}`);
    process.exit(1);
  }
}

const pkg = loadJson('package.json');
const mcp = loadJson('mcp.json');
const server = loadJson('server.json');

const versions = {
  'package.json': pkg.version,
  'mcp.json': mcp.version,
  'server.json': server.version
};

console.log('[Weavetab Version Check] Verifying manifest synchronization...');

let mismatch = false;
const targetVersion = pkg.version;

for (const [file, ver] of Object.entries(versions)) {
  if (ver !== targetVersion) {
    console.error(`  [ERROR] Mismatch: ${file} version is "${ver}", but package.json version is "${targetVersion}"`);
    mismatch = true;
  } else {
    console.log(`  [OK] ${file}: v${ver}`);
  }
}

if (mismatch) {
  console.error('\n[Weavetab Verify Failed] Version numbers across manifests must be identical.');
  process.exit(1);
}

console.log('[Weavetab Verify Passed] All manifest versions are synchronized (v' + targetVersion + ').\n');
