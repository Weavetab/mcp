import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extDir = path.join(__dirname, '..', 'ext-dist');
const manifestPath = path.join(extDir, 'manifest.json');
const backgroundPath = path.join(extDir, 'background.js');

try {
  const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Auto-bump the extension patch version on every build.
  // Chrome keys its MV3 service worker cache by extension version — bumping
  // the patch version forces Chrome to evict the cached background.js and
  // load the fresh script from disk on next launch.
  //
  // Strategy: use the first 8 hex chars of a SHA-256 hash of background.js
  // as the patch component, so the version is deterministic (idempotent
  // re-runs produce the same version) and always changes when the script changes.
  //
  // Version format: MAJOR.MINOR.PATCH  e.g. "1.0.171a3c8f" → normalised to
  // three numeric dotted segments as Chrome requires: "1.0.<decimal-of-hash>"
  let patchVersion = 0;
  if (fs.existsSync(backgroundPath)) {
    const bgContent = fs.readFileSync(backgroundPath);
    const hashHex = createHash('sha256').update(bgContent).digest('hex').slice(0, 8);
    // Convert 8 hex chars (32-bit value) to an unsigned integer for the patch segment.
    patchVersion = parseInt(hashHex, 16) >>> 0; // clamp to [0, 4294967295]
    // Chrome version segments must be ≤ 65535 — reduce to 16-bit range.
    patchVersion = patchVersion & 0xFFFF;
  }

  const [major, minor] = (manifestData.version || '1.0.0').split('.').map(Number);
  const newVersion = `${major || 1}.${minor || 0}.${patchVersion}`;

  if (manifestData.version !== newVersion) {
    manifestData.version = newVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2) + '\n');
    console.log(`\x1b[32m[Weavetab]\x1b[0m Extension manifest version bumped to ${newVersion} (background.js hash: ${patchVersion.toString(16)}).`);
    console.log(`\x1b[33m[NOTE]\x1b[0m Chrome will evict the stale SW cache on next launch and load the updated background.js.`);
  } else {
    console.log(`\x1b[32m[Weavetab]\x1b[0m Extension manifest version unchanged at ${newVersion} (background.js unchanged).`);
  }
} catch (error) {
  console.error(`\x1b[31m[Weavetab]\x1b[0m Failed to update manifest.json:`, error);
  process.exit(1);
}
