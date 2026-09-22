import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpRoot = resolve(__dirname, '..');
const repoRoot = resolve(mcpRoot, '..');

function loadJson(filepath) {
  try {
    return JSON.parse(readFileSync(filepath, 'utf8'));
  } catch (err) {
    console.error(`[Weavetab Verify] Failed to read ${filepath}: ${err.message}`);
    process.exit(1);
  }
}

const pkg = loadJson(resolve(mcpRoot, 'package.json'));
const mcp = loadJson(resolve(mcpRoot, 'mcp.json'));
const server = loadJson(resolve(mcpRoot, 'server.json'));

const targetVersion = pkg.version;

const versions = {
  'MCP/package.json': pkg.version,
  'MCP/mcp.json': mcp.version,
  'MCP/server.json': server.version,
};

// Check SDK if present in repo
const sdkPkgPath = resolve(repoRoot, 'sdk', 'package.json');
if (existsSync(sdkPkgPath)) {
  const sdkPkg = loadJson(sdkPkgPath);
  versions['sdk/package.json'] = sdkPkg.version;
}

// Check skills if present in repo
const skillsPkgPath = resolve(repoRoot, 'skills', 'package.json');
if (existsSync(skillsPkgPath)) {
  const skillsPkg = loadJson(skillsPkgPath);
  versions['skills/package.json'] = skillsPkg.version;
}

// Check WEAVETAB_VERSION constant files
const mcpVersionTs = resolve(mcpRoot, 'src', 'version.ts');
if (existsSync(mcpVersionTs)) {
  const content = readFileSync(mcpVersionTs, 'utf8');
  const match = content.match(/WEAVETAB_VERSION\s*=\s*["']([^"']+)["']/);
  if (match) versions['MCP/src/version.ts'] = match[1];
}

const sdkVersionTs = resolve(repoRoot, 'sdk', 'src', 'version.ts');
if (existsSync(sdkVersionTs)) {
  const content = readFileSync(sdkVersionTs, 'utf8');
  const match = content.match(/WEAVETAB_VERSION\s*=\s*["']([^"']+)["']/);
  if (match) versions['sdk/src/version.ts'] = match[1];
}

console.log('[Weavetab Version Check] Verifying manifest & package synchronization across MCP, SDK, and Skills...');

let mismatch = false;

for (const [file, ver] of Object.entries(versions)) {
  if (ver !== targetVersion) {
    console.error(`  [ERROR] Mismatch: ${file} version is "${ver}", but target is "${targetVersion}"`);
    mismatch = true;
  } else {
    console.log(`  [OK] ${file}: v${ver}`);
  }
}

if (mismatch) {
  console.error('\n[Weavetab Verify Failed] Version numbers across packages and manifests must be identical.');
  process.exit(1);
}

console.log('[Weavetab Verify Passed] All ecosystem versions are in lock-step (v' + targetVersion + ').\n');
