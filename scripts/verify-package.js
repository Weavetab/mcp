import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkgPath = resolve(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

console.log('[Weavetab Package Check] Verifying build output & publishing bundle...');

const entryFile = resolve(root, pkg.main || 'dist/index.js');
if (!existsSync(entryFile)) {
  console.error(`[Weavetab Verify Failed] Entry point missing: ${entryFile}. Run "npm run build" first.`);
  process.exit(1);
}

const entryStats = statSync(entryFile);
if (entryStats.size < 100) {
  console.error(`[Weavetab Verify Failed] Entry point ${entryFile} is empty or invalid (${entryStats.size} bytes).`);
  process.exit(1);
}

console.log(`  [OK] Entry point verified: ${pkg.main} (${(entryStats.size / 1024).toFixed(1)} KB)`);

let missingCount = 0;
const filesList = pkg.files || [];

for (const filePattern of filesList) {
  if (filePattern.startsWith('!')) continue;
  const filePath = resolve(root, filePattern);
  if (!existsSync(filePath)) {
    console.error(`  [ERROR] Missing required package file: ${filePattern}`);
    missingCount++;
  } else {
    console.log(`  [OK] Bundle asset verified: ${filePattern}`);
  }
}

if (missingCount > 0) {
  console.error(`\n[Weavetab Verify Failed] ${missingCount} required release assets are missing.`);
  process.exit(1);
}

console.log('[Weavetab Package Check Passed] NPM package bundle is complete and ready for release.\n');
