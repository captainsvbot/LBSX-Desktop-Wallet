const { app } = require('electron');
const crypto = require('node:crypto');

app.whenReady().then(() => {
  console.log('=== ELECTRON CRYPTO CAPABILITY ===');
  console.log('node version:', process.versions.node, '| electron:', process.versions.electron);

  // 1. ECDH
  try {
    const e = crypto.createECDH('secp256k1');
    e.generateKeys();
    console.log('ECDH secp256k1: OK, pub len', e.getPublicKey().length);
  } catch (error) {
    console.log('ECDH secp256k1: FAIL ->', error.message);
  }

  // 2. ECDH with an explicit private key
  try {
    const e = crypto.createECDH('secp256k1');
    e.setPrivateKey(Buffer.alloc(32, 0x42));
    console.log('ECDH setPrivateKey: OK');
  } catch (error) {
    console.log('ECDH setPrivateKey: FAIL ->', error.message);
  }

  // 3. Which curves are available?
  const curves = crypto.getCurves ? crypto.getCurves() : [];
  console.log('getCurves available:', curves.length);
  console.log('has secp256k1 in getCurves:', curves.includes('secp256k1'));
  console.log('prime256v1 (P-256):', curves.includes('prime256v1'));

  // 4. AES-GCM still fine?
  try {
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12));
    const ct = Buffer.concat([c.update(Buffer.from('x')), c.final()]);
    console.log('AES-256-GCM: OK', ct.length);
  } catch (error) {
    console.log('AES-256-GCM: FAIL ->', error.message);
  }

  // 5. HKDF
  try {
    const k = crypto.hkdfSync('sha256', Buffer.alloc(32), Buffer.alloc(0), Buffer.from('i'), 32);
    console.log('HKDF-SHA256: OK', k.length);
  } catch (error) {
    console.log('HKDF-SHA256: FAIL ->', error.message);
  }

  app.quit();
});
