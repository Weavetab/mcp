import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extDir = path.join(__dirname, '..', 'ext-dist');
const manifestPath = path.join(extDir, 'manifest.json');
const assetFiles = [
  'background.js',
  'content.js',
  'main_world.js',
  'dashboard.js',
  'styles.css',
  'hud/hud.js',
];

try {
  const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const hasher = createHash('sha256');
  let hashedCount = 0;
  for (const rel of assetFiles) {
    const filePath = path.join(extDir, rel);
    if (fs.existsSync(filePath)) {
      hasher.update(rel);
      hasher.update(fs.readFileSync(filePath));
      hashedCount++;
    }
  }

  let patchVersion = 0;
  if (hashedCount > 0) {
    const hashHex = hasher.digest('hex').slice(0, 8);
    patchVersion = (parseInt(hashHex, 16) >>> 0) & 0xFFFF;
  }

  const [major, minor, prevPatchRaw] = (manifestData.version || '1.0.0').split('.').map(Number);
  const prevPatch = Number.isFinite(prevPatchRaw) ? prevPatchRaw : 0;
  if (patchVersion < prevPatch) {
    patchVersion = Math.min(65535, prevPatch + 1);
  }

  const newVersion = `${major || 1}.${minor || 0}.${patchVersion}`;

  if (manifestData.version !== newVersion) {
    manifestData.version = newVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2) + '\n');
    console.log(`\x1b[32m[Weavetab]\x1b[0m Extension manifest version bumped to ${newVersion} (bundle hash: ${patchVersion.toString(16)}).`);
  } else {
    console.log(`\x1b[32m[Weavetab]\x1b[0m Extension manifest version unchanged at ${newVersion}.`);
  }
} catch (error) {
  console.error(`\x1b[31m[Weavetab]\x1b[0m Failed to update manifest.json:`, error);
  process.exit(1);
}
