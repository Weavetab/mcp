const fs = require('fs');
let code = fs.readFileSync('src/server.ts', 'utf8');

// Fix 1: Stdout/Stdin aggressive check
const target1 = `    process.stdin.on("close", exitOnClose);
    process.stdin.on("end", exitOnClose);`;

const replacement1 = `    process.stdin.on("close", exitOnClose);
    process.stdin.on("end", exitOnClose);
    process.stdout.on("error", exitOnClose);
    process.stdin.on("error", exitOnClose);
    
    // Windows aggressive zombie process prevention
    setInterval(() => {
      try {
        if (process.stdin.destroyed || process.stdout.destroyed) {
          exitOnClose();
        }
      } catch (e) {
        exitOnClose();
      }
    }, 2000).unref();`;

if (code.includes(target1)) {
  code = code.replace(target1, replacement1);
  console.log("Fix 1 applied.");
} else {
  console.log("Fix 1 target not found.");
}

// Fix 2: Global uncaughtException handler
const target2 = `process.on("unhandledRejection", (reason) => {
  logDebug("[Weavetab] Unhandled rejection (non-fatal):", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  logDebug("[Weavetab] Uncaught exception (non-fatal):", err.message);
});`;

const replacement2 = `process.on("unhandledRejection", (reason) => {
  logDebug("[Weavetab] Unhandled rejection (non-fatal):", reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error && (reason.message.includes("EPIPE") || reason.message.includes("ECONNRESET") || reason.message.includes("EOF"))) {
    process.exit(0);
  }
});
process.on("uncaughtException", (err) => {
  logDebug("[Weavetab] Uncaught exception (non-fatal):", err.message);
  if (err.message.includes("EPIPE") || err.message.includes("ECONNRESET") || err.message.includes("EOF")) {
    process.exit(0);
  }
});`;

if (code.includes(target2)) {
  code = code.replace(target2, replacement2);
  console.log("Fix 2 applied.");
} else {
  console.log("Fix 2 target not found.");
}

fs.writeFileSync('src/server.ts', code, 'utf8');
console.log("Saved.");
