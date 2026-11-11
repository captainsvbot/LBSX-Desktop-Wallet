// Exercises the REAL attachment fetch-and-decrypt path in the packaged app.
//
// The mail is sent from the wallet to ITSELF, so the app holds the recipient
// private key and can genuinely decrypt. This drives the exact IPC path that
// failed ("The attachment output is missing from that transaction").
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9413;
let app, socket, requestId = 0;
const pending = new Map();

const ATTACHMENT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('LIVE-DECRYPT-MARKER-'),
  Buffer.alloc(8 * 1024, 0x33),
]);

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
  const card = await evaluate("(async () => (await window.lbsx.getOwnMailCard()))()");
  console.log('wallet:', wallet.address);
  console.log('own key:', card.publicKeyHex.slice(0, 20), '...');

  // Send the mail to ourselves, carrying an attachment.
  console.log('');
  console.log('sending a self-mail with an encrypted attachment...');
  const sent = await evaluate(`(async () => {
    try {
      const r = await window.lbsx.sendMail({
        recipient: ${JSON.stringify(wallet.address)},
        recipientPublicKeyHex: ${JSON.stringify(card.publicKeyHex)},
        subject: 'Live decrypt test',
        body: 'Self-mail carrying an encrypted attachment.',
        attachments: [{
          fileName: 'live-proof.png',
          mimeType: 'image/png',
          dataBase64: ${JSON.stringify(ATTACHMENT.toString('base64'))},
        }],
      });
      return { ok: true, txid: r.txid, feeSats: r.feeSats };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log(JSON.stringify(sent, null, 2));
  if (!sent.ok) throw new Error(`the send failed: ${sent.error}`);

  // Wait for the transaction to be retrievable, then drive the fetch+decrypt.
  await delay(4000);

  // The AAD binds the message id, so the REAL id must be used - not a
  // placeholder.
  const mail = await evaluate("(async () => (await window.lbsx.getMail()))()");
  const record = (mail.messages || []).find(m => m.txid === sent.txid);
  if (!record) throw new Error('the sent mail was not found in the mailbox');
  console.log('message id:', record.messageId);
  console.log('attachment refs:', JSON.stringify(record.attachmentRefs));
  if (!record.attachmentRefs?.length) throw new Error('the sent mail has no attachment refs');

  console.log('');
  console.log('calling mail:get-attachment (the path that failed)...');
  const fetched = await evaluate(`(async () => {
    try {
      const r = await window.lbsx.getMailAttachment({
        txid: ${JSON.stringify(sent.txid)},
        vout: 3,
        senderAddress: ${JSON.stringify(wallet.address)},
        recipientAddress: ${JSON.stringify(wallet.address)},
        messageId: ${JSON.stringify(record.messageId)},
        fileName: ${JSON.stringify(record.attachmentRefs[0].name)},
        mimeType: ${JSON.stringify(record.attachmentRefs[0].mimeType)},
        byteLength: ${ATTACHMENT.length},
      });
      const bytes = new Uint8Array(r.data);
      let marker = -1;
      const needle = new TextEncoder().encode('LIVE-DECRYPT-MARKER-');
      for (let i = 0; i + needle.length <= bytes.length; i += 1) {
        let hit = true;
        for (let j = 0; j < needle.length; j += 1) { if (bytes[i + j] !== needle[j]) { hit = false; break; } }
        if (hit) { marker = i; break; }
      }
      return {
        ok: true,
        fileName: r.fileName,
        mimeType: r.mimeType,
        byteLength: r.byteLength,
        receivedBytes: bytes.length,
        markerFoundAt: marker,
        firstBytes: Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(''),
      };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log(JSON.stringify(fetched, null, 2));
  if (!fetched.ok) throw new Error(`the fetch failed: ${fetched.error}`);
  if (fetched.markerFoundAt < 0) throw new Error('the decrypted attachment does not contain the marker');
  if (fetched.receivedBytes !== ATTACHMENT.length) throw new Error('the decrypted length does not match');
  if (fetched.firstBytes !== '89504e470d0a1a0a') throw new Error('the PNG signature was not preserved');

  console.log('');
  console.log('PASS: the live app fetched the attachment from the chain and decrypted it correctly (PNG signature and marker intact)');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
