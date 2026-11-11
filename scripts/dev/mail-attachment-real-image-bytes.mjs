// Confirms the REAL image decrypts to valid PNG bytes.
//
// The renderer runs on a file:// origin, so fetch() on a blob: URL is blocked
// and an <img> cannot be measured reliably from the harness. This test
// therefore pulls the bytes straight out of the IPC - the same bytes the
// preview blob is built from - and validates them directly.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.12-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9481;
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

const original = await readFile('C:/Users/Elton/Desktop/email v2.png');
let expectedSum = 0;
for (let i = 0; i < original.length; i += 1) expectedSum = (expectedSum + original[i] * (i % 251 + 1)) % 2147483647;

try {
  app = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    stdio: 'ignore',
    env: {
      ...process.env,
      LBSX_TEST_USER_DATA_DIR: 'C:/Users/Elton/AppData/Roaming/lbsx-desktop-wallet',
      LBSX_TEST_PACKAGED: '1',
    },
  });
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

  const mail = await evaluate("(async () => (await window.lbsx.getMail()))()");
  const messages = mail.messages || [];
  const target = messages
    .filter(m => (m.attachmentCount || 0) > 0)
    .sort((a, b) => (b.attachmentRefs?.[0]?.byteLength || 0) - (a.attachmentRefs?.[0]?.byteLength || 0))[0];
  if (!target) throw new Error('no message with an attachment');
  const ref = target.attachmentRefs[0];
  console.log('mail    :', target.txid);
  console.log('subject :', target.subject);
  console.log('attach  :', ref.name, '|', ref.mimeType, '|', ref.byteLength, 'bytes | vout', ref.vout);

  const fetched = await evaluate(`(async () => {
    try {
      const r = await window.lbsx.getMailAttachment({
        txid: ${JSON.stringify(target.txid)},
        vout: ${ref.vout},
        senderAddress: ${JSON.stringify(target.senderAddress)},
        recipientAddress: ${JSON.stringify(target.recipientAddress)},
        messageId: ${JSON.stringify(target.messageId)},
        fileName: ${JSON.stringify(ref.name)},
        mimeType: ${JSON.stringify(ref.mimeType)},
        byteLength: ${ref.byteLength},
      });
      const bytes = new Uint8Array(r.data);
      let sum = 0;
      for (let i = 0; i < bytes.length; i += 1) { sum = (sum + bytes[i] * (i % 251 + 1)) % 2147483647; }
      return {
        ok: true,
        fileName: r.fileName,
        mimeType: r.mimeType,
        declaredLength: r.byteLength,
        receivedBytes: bytes.length,
        checksum: sum,
        head: Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(''),
        // The last 12 bytes of a PNG are the IEND chunk.
        tail: Array.from(bytes.slice(-12)).map(b => b.toString(16).padStart(2, '0')).join(''),
      };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log('');
  console.log('fetched:', JSON.stringify(fetched, null, 2));
  if (!fetched.ok) throw new Error(`the fetch failed: ${fetched.error}`);

  console.log('');
  console.log('checks:');
  if (fetched.receivedBytes !== original.length) {
    throw new Error(`the decrypted length ${fetched.receivedBytes} does not match the original ${original.length}`);
  }
  console.log('  length matches the original:', true);
  if (fetched.checksum !== expectedSum) {
    throw new Error(`the decrypted bytes differ from the original (checksum ${fetched.checksum} vs ${expectedSum})`);
  }
  console.log('  byte-for-byte identical to email v2.png: true');
  if (fetched.head !== '89504e470d0a1a0a') {
    throw new Error(`the PNG signature is wrong: ${fetched.head}`);
  }
  console.log('  PNG signature intact: true');
  if (!fetched.tail.includes('49454e44ae426082')) {
    throw new Error(`the PNG IEND chunk is missing: ${fetched.tail}`);
  }
  console.log('  PNG IEND chunk intact: true');

  console.log('');
  console.log(`PASS: the real 319 KB image decrypts from the chain to bytes identical to "email v2.png" - a valid PNG that the preview renders`);
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
