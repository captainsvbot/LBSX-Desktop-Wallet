// Runs the mail crypto suite inside Electron, where secp256k1 is NOT available
// to OpenSSL and the pure-JS ECDH path must be used.
const { app } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

app.whenReady().then(async () => {
  console.log('=== MAIL CRYPTO UNDER ELECTRON ===');
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, 'mail-crypto-smoke.mjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
  console.log(result.out.trim());
  console.log('exit code:', result.code);
  app.quit();
});
