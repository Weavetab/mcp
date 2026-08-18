import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverTs = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');

const regex = /server\.tool\(\s*["']([^"']+)["']/g;
let match;
const tools = [];
while ((match = regex.exec(serverTs)) !== null) {
  tools.push(match[1]);
}

console.log('Total server.tool registrations:', tools.length);
tools.forEach((t, i) => console.log(`${i + 1}. ${t}`));
