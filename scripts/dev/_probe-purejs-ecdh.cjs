const { app } = require('electron');
const bsvModule = require('bsv');

const bsv = bsvModule.default || bsvModule;

function compressSec1(buffer) {
  if (buffer.length === 33) return buffer;
  if (buffer.length !== 65 || buffer[0] !== 0x04) throw new Error('bad point');
  const x = buffer.subarray(1, 33);
  const y = buffer.subarray(33, 65);
  return Buffer.concat([Buffer.from([(y[31] & 1) === 0 ? 0x02 : 0x03]), x]);
}

function pointFromBytes(bytes) {
  if (bytes.length === 33) return bsv.crypto.Point.pointFromCompressed(bytes);
  // uncompressed
  const x = bsv.crypto.BN.fromBuffer(bytes.subarray(1, 33));
  const y = bsv.crypto.BN.fromBuffer(bytes.subarray(33, 65));
  const p = bsv.crypto.Point.fromX(y.testn(1) ? true : false, x);
  return p;
}

function ecdhShared(privBytes, peerPubBytes) {
  const priv = bsv.crypto.BN.fromBuffer(privBytes, 32);
  const point = pointFromBytes(peerPubBytes);
  const result = point.mul(priv);
  if (result.isInfinity()) throw new Error('ECDH produced the point at infinity.');
  return result.toBuffer();
}

app.whenReady().then(() => {
  console.log('=== ELECTRON PURE-JS ECDH ===');
  const G = bsv.crypto.Point.getG();
  const priv = Buffer.alloc(32, 0x42);
  const privBn = bsv.crypto.BN.fromBuffer(priv, 32);
  const expected = G.mul(privBn).toBuffer();
  const recompressed = compressSec1(expected);
  console.log('G*priv recompressed matches:', bsv.crypto.Point.pointFromCompressed(recompressed).toBuffer().toString('hex') === expected.toString('hex'));

  const aPriv = Buffer.alloc(32, 0x11);
  const bPriv = Buffer.alloc(32, 0x22);
  const aPub = compressSec1(G.mul(bsv.crypto.BN.fromBuffer(aPriv, 32)).toBuffer());
  const bPub = compressSec1(G.mul(bsv.crypto.BN.fromBuffer(bPriv, 32)).toBuffer());
  const s1 = ecdhShared(aPriv, bPub);
  const s2 = ecdhShared(bPriv, aPub);
  console.log('shared secrets match:', s1.toString('hex') === s2.toString('hex'));
  console.log('shared secret len:', s1.length);

  try {
    const crypto = require('node:crypto');
    const e = crypto.createECDH('secp256k1');
    e.setPrivateKey(aPriv);
    const nodeShared = e.computeSecret(bPub);
    console.log('matches Node ECDH:', nodeShared.toString('hex') === s1.toString('hex'));
  } catch (error) {
    console.log('Node ECDH unavailable (expected in Electron):', error.message.slice(0, 50));
  }

  const crypto = require('node:crypto');
  const key = Buffer.from(crypto.hkdfSync('sha256', s1, Buffer.alloc(0), Buffer.from('lbsx-mail-v1'), 32));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.alloc(12));
  cipher.setAAD(Buffer.from('aad'));
  const ct = Buffer.concat([cipher.update(Buffer.from('secret')), cipher.final()]);
  console.log('AES-GCM with pure-JS shared secret: OK', ct.length);

  app.quit();
});
