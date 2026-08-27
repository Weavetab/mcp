const fs = require('fs');
const file = 'c:/Users/fy2ne/Music/Weavetab/MCP/src/cli/plugin.ts';
let code = fs.readFileSync(file, 'utf-8');

// 1. Patch runPluginInit
const initStartStr = 'export async function runPluginInit(';
const initEndStr = '// 8. ENTERPRISE BUILD';

const initStartIndex = code.indexOf(initStartStr);
const initEndIndex = code.indexOf(initEndStr);

const newInit = "export async function runPluginInit(args: string[] = []): Promise<void> {\n  const pc = (await import(\"picocolors\")).default;\n  console.log(pc.yellow(\"Warning: 'weavetab init' has been moved to the @weavetab/sdk package.\"));\n  console.log(pc.cyan(\"Please use 'npx weavetab-plugin init' instead.\"));\n}\n\n";

if(initStartIndex > -1 && initEndIndex > -1) {
  code = code.substring(0, initStartIndex) + newInit + code.substring(initEndIndex);
}

// 2. Patch runPluginBuild
const buildStartStr = 'export async function runPluginBuild(';
const buildEndStr = '// 9. MAIN ROUTER';

const buildStartIndex = code.indexOf(buildStartStr);
const buildEndIndex = code.indexOf(buildEndStr);

const newBuild = "export async function runPluginBuild(args: string[] = []): Promise<void> {\n  const pc = (await import(\"picocolors\")).default;\n  console.log(pc.yellow(\"Warning: 'weavetab build' has been moved to the @weavetab/sdk package.\"));\n  console.log(pc.cyan(\"Please use 'npx weavetab-plugin build' instead.\"));\n}\n\n";

if(buildStartIndex > -1 && buildEndIndex > -1) {
  code = code.substring(0, buildStartIndex) + newBuild + code.substring(buildEndIndex);
}

fs.writeFileSync(file, code, 'utf-8');
console.log('CLI patched successfully!');
