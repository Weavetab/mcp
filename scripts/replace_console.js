import * as fs from 'fs';
import * as path from 'path';

function walk(dir, callback) {
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      if (!filePath.includes('node_modules') && !filePath.includes('cli')) {
        walk(filePath, callback);
      }
    } else {
      if (filePath.endsWith('.ts') && !filePath.endsWith('index.ts')) {
        callback(filePath);
      }
    }
  }
}

let modifiedFiles = 0;
walk(path.join(process.cwd(), 'src'), (filePath) => {
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.includes('console.error(')) {
    // Only add import if we replace something
    let original = content;
    content = content.replace(/console\.error\(/g, 'logDebug(');
    
    if (content !== original) {
      if (!content.includes('import { logDebug } from')) {
        // Add import to top
        const depth = filePath.split(path.sep).length - process.cwd().split(path.sep).length - 1;
        let relativePath = depth === 1 ? './audit/logger.js' : 
                           depth === 2 ? '../audit/logger.js' : 
                           depth === 3 ? '../../audit/logger.js' : 
                           depth === 4 ? '../../../audit/logger.js' : '';
        
        if (filePath.replace(/\\/g, '/').includes('/audit/logger.ts')) {
          // Do not import logDebug in logger.ts itself!
          content = original;
        } else if (relativePath) {
          content = `import { logDebug } from "${relativePath}";\n` + content;
        }
      }
      if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        modifiedFiles++;
      }
    }
  }
});
console.log(`Modified ${modifiedFiles} files.`);
