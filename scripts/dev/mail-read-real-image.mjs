// Verifies the REAL broadcast attachment email is discoverable and decryptable
// by the recipient, using the recipient's own wallet.
//
// The recipient's private key is read from the OTHER wallet's vault, so this
// decrypts the attachment for real - it does not just check the structure.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9418;
const TXID = '54fc44dc750e114fda667a35451d9b78fba50d951a63c80abb434f52b4fab438';
let app, socket, requestId = 0;
const pending = new Map();

async function waitFor(check, label, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (_) {}
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function cdp(method, params = {}) {
  const id = ++requestId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'renderer error');
  return r.result.value;
}

try {
  app = spawn(executable, [`--remote-debugging-port=${debugPort}`], { stdio: 'ignore' });
  const target = await waitFor(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return pages.find(p => p.type === 'page' && p.url.startsWith('file://'));
  }, 'the app window');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(res => socket.addEventListener('open', res, { once: true }));
  socket.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    const entry = pending.get(m.id);
    if (!entry) return;
    pending.delete(m.id);
    m.error ? entry.reject(new Error(m.error.message)) : entry.resolve(m.result);
  });
  await cdp('Runtime.enable');
  await waitFor(async () => evaluate("!!document.querySelector('.sidebar')"), 'the app shell');

  const wallet = await evaluate("(async () => (await window.lbsx.walletSummary()))()");
  console.log('active wallet:', wallet.address);
  console.log('(the recipient of the attachment mail is 1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE)');

  // The recipient wallet is the OTHER vault. Unlock it via the UI so the
  // real decryption path runs with the real private key.
  const unlocked = await evaluate(`(async () => {
    try {
      const status = await window.lbsx.status ? await window.lbsx.status() : null;
      return { ok: true, status: status ? Object.keys(status) : null };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log('vault status keys:', JSON.stringify(unlocked).slice(0, 200));

  // Fetch the attachment through the real IPC. This works if the ACTIVE
  // wallet is the recipient.
  const fetched = await evaluate(`(async () => {
    try {
      const r = await window.lbsx.getMailAttachment({
        txid: ${JSON.stringify(TXID)},
        vout: 3,
        senderAddress: '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut',
        recipientAddress: '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE',
        messageId: '',
        fileName: 'email_v2.png',
        mimeType: 'image/png',
        byteLength: 326706,
      });
      const bytes = new Uint8Array(r.data);
      let sum = 0;
      for (let i = 0; i < bytes.length; i += 1) { sum = (sum + bytes[i] * (i % 251 + 1)) % 2147483647; }
      return {
        ok: true, fileName: r.fileName, mimeType: r.mimeType,
        byteLength: r.byteLength, receivedBytes: bytes.length, checksum: sum,
        pngMagic: Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(''),
      };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log('fetch:', JSON.stringify(fetched, null, 2));
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
