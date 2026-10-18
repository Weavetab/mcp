import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const mcpJsonPath = resolve(root, 'mcp.json');
const docsDir = resolve(root, 'docs');
const toolsMdPath = resolve(docsDir, 'TOOLS.md');

console.log('[Weavetab Docs Generator] Auto-generating documentation from mcp.json...');

if (!existsSync(mcpJsonPath)) {
  console.error(`[Weavetab Docs Failed] mcp.json not found at ${mcpJsonPath}`);
  process.exit(1);
}

const mcp = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
const tools = mcp.capabilities?.tools || {};
const toolEntries = Object.entries(tools);

let markdown = `# Weavetab MCP Tool Reference\n\n`;
markdown += `> **Version:** ${mcp.version || '2.5.1'} | **Total Tools:** ${toolEntries.length} | **Architecture:** Layer 0 Direct CDP\n\n`;
markdown += `Weavetab provides ${toolEntries.length} production-grade MCP tools organized into functional categories.\n\n`;
markdown += `| Tool Name | Category | Description | Key Features |\n`;
markdown += `| :--- | :--- | :--- | :--- |\n`;

for (const [name, info] of toolEntries) {
  const category = info.category || 'general';
  const desc = (info.description || '').replace(/\n/g, ' ');
  const features = (info.features || []).slice(0, 3).join(', ');
  markdown += `| \`${name}\` | \`${category}\` | ${desc} | ${features || 'Native CDP'} |\n`;
}

markdown += `\n---\n\n`;
markdown += `*Auto-generated via \`npm run docs:generate\` on ${new Date().toISOString().split('T')[0]}.*\n`;

if (!existsSync(docsDir)) {
  mkdirSync(docsDir, { recursive: true });
}

writeFileSync(toolsMdPath, markdown, 'utf8');
console.log(`[Weavetab Docs Generator] Documentation written to docs/TOOLS.md (${toolEntries.length} tools documented).\n`);
