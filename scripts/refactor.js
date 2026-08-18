const fs = require('fs');
const files = ['ext-dist/background.js', 'ext-dist/content.js', 'ext-dist/dashboard.html'];
files.forEach(f => {
  let code = fs.readFileSync(f, 'utf8');
  if (!code.includes('const browserAPI')) {
    let replacedCode;
    if (f.endsWith('.html')) {
        replacedCode = code.replace(/chrome\./g, 'browserAPI.');
        // Add the polyfill inside a script tag
        replacedCode = replacedCode.replace('<script>', '<script>\n    const browserAPI = typeof browser !== "undefined" ? browser : chrome;\n');
    } else {
        replacedCode = 'const browserAPI = typeof browser !== "undefined" ? browser : chrome;\n' + code.replace(/chrome\./g, 'browserAPI.');
    }
    
    // In dashboard.html we also need to fix XSS
    if (f === 'ext-dist/dashboard.html') {
        replacedCode = replacedCode.replace(/contentArea\.innerHTML\s*=\s*result\[`branch_\$\{branch\}_html`\];/, 'contentArea.textContent = result[`branch_${branch}_html`]; // XSS fixed');
    }
    
    fs.writeFileSync(f, replacedCode);
    console.log('Updated ' + f);
  }
});
