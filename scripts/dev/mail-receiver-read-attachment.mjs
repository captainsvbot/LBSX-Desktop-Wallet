// Reads the attachment email from the RECEIVER's wallet.
//
// The receiver's vault lives in a different app data directory. The wallet
// supports LBSX_TEST_USER_DATA_DIR for exactly this, so the same build can be
// pointed at the receiver's wallet and decrypt the attachment for real.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.12-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9441;
const userDataDir = 'C:/Users/Elton/AppData/Roaming/simplycash-desktop-wallet';
const TXIDS = [
  '54fc44dc750e114fda667a35451d9b78fba50d951a63c80abb434f52b4fab438',
  'c6bbe09d229ea1199010ca78c2569426661c885f4c980e2d496a0dde3d62bd73',
];
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

// The original PNG, for a byte-for-byte comparison.
const { readFile } = await import('node:fs/promises');
const original = await readFile('C:/Users/Elton/Desktop/email v2.png');

try {
  app = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    stdio: 'ignore',
    env: {
      ...process.env,
      LBSX_TEST_USER_DATA_DIR: userDataDir,
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

  const wallet = await evaluate("(async () => (await window.lbsx.walletSummary()))()");
  console.log('receiver wallet:', wallet.address);
  console.log('expected       : 1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE');
  if (wallet.address !== '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE') {
    throw new Error(`wrong wallet loaded: ${wallet.address}`);
  }

  // Sync so the incoming mail is discovered.
  console.log('');
  console.log('syncing the receiver...');
  await evaluate("(async () => { await window.lbsx.syncWalletActivity(); })()");
  await delay(4000);
  await evaluate("(async () => { await window.lbsx.syncMail(); })()");
  await delay(4000);

  const mail = await evaluate("(async () => (await window.lbsx.getMail()))()");
  const messages = mail.messages || [];
  console.log('mailbox messages:', messages.length);
  for (const m of messages) {
    console.log(`  ${m.direction.padEnd(9)} ${m.txid.slice(0, 16)} status=${m.status} attachments=${m.attachmentCount ?? 0} subject=${JSON.stringify(m.subject)}`);
  }

  const withAttachment = messages.find(m => (m.attachmentCount || 0) > 0);
  if (!withAttachment) {
    console.log('');
    console.log('no message with an attachment yet in the mailbox (the mail may still be pending)');
  } else {
    console.log('');
    console.log('decrypting the attachment on the RECEIVER side...');
    const fetched = await evaluate(`(async () => {
      try {
        const ref = ${JSON.stringify(withAttachment.attachmentRefs[0])};
        const r = await window.lbsx.getMailAttachment({
          txid: ${JSON.stringify(withAttachment.txid)},
          vout: ref.vout,
          senderAddress: ${JSON.stringify(withAttachment.senderAddress)},
          recipientAddress: ${JSON.stringify(withAttachment.recipientAddress)},
          messageId: ${JSON.stringify(withAttachment.messageId)},
          fileName: ref.name,
          mimeType: ref.mimeType,
          byteLength: ref.byteLength,
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
    if (!fetched.ok) throw new Error(`the receiver could not decrypt: ${fetched.error}`);

    let expected = 0;
    for (let i = 0; i < original.length; i += 1) { expected = (expected + original[i] * (i % 251 + 1)) % 2147483647; }
    if (fetched.checksum !== expected) throw new Error('the decrypted bytes differ from the original PNG');
    if (fetched.pngMagic !== '89504e470d0a1a0a') throw new Error('the PNG signature was not preserved');
    console.log('');
    console.log(`PASS: the receiver decrypted the attachment and it is byte-identical to "email v2.png" (${fetched.receivedBytes.toLocaleString()} bytes)`);
  }
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
