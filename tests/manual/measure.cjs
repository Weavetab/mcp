const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

const proc = spawn('node', ['dist/index.js']);

let startupTime = null;
let browserMapStart = null;
let browserMapTime = null;

const startTime = performance.now();

proc.stderr.on('data', (data) => {
  const str = data.toString();
  if (str.includes('Weavetab Server Ready') && startupTime === null) {
    startupTime = performance.now() - startTime;
    console.log(`Startup time: ${startupTime.toFixed(2)} ms`);

    // Now trigger browser_map
    browserMapStart = performance.now();
    const req = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'browser_map',
        arguments: {}
      }
    }) + '\n';
    proc.stdin.write(req);
  }
});

let outData = '';
proc.stdout.on('data', (data) => {
  outData += data.toString();
  if (outData.includes('"id":1')) {
    if (browserMapTime === null && browserMapStart !== null) {
      browserMapTime = performance.now() - browserMapStart;
      console.log(`browser_map time: ${browserMapTime.toFixed(2)} ms`);
      proc.kill();
    }
  }
});

proc.on('close', () => {
  console.log('Measurement complete.');
});
