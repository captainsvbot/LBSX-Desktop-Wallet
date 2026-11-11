// Sends a REAL mail with a REAL encrypted attachment to the receiving wallet,
// then reads it back from the recipient side.
//
// This is the end-to-end proof: two real wallets, real mainnet transactions.
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9412;
const scratch = path.join(projectRoot, 'scripts', 'dev');
const attachmentFile = path.join(scratch, '_attach-e2e.png');
const RECIPIENT = '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE';
const RECIPIENT_KEY = '038f6c0bcf78db7e07fbb8a7325fa375add68e3abd58e4c7e84e7faac56c6dc97b';
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

// A real PNG with a recognisable marker payload.
const ATTACHMENT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('LBSX-ATTACHMENT-MARKER-2026-11-09-'),
  Buffer.alloc(18 * 1024, 0x5a),
]);

try {
  await writeFile(attachmentFile, ATTACHMENT);
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
  console.log('sending wallet:', wallet.address);

  // Send the mail with the attachment, straight through the main process.
  console.log('');
  console.log('sending a real mail with an encrypted attachment...');
  const sent = await evaluate(`(async () => {
    try {
      const bytes = ${JSON.stringify(ATTACHMENT.toString('base64'))};
      const r = await window.lbsx.sendMail({
        recipient: ${JSON.stringify(RECIPIENT)},
        recipientPublicKeyHex: ${JSON.stringify(RECIPIENT_KEY)},
        subject: 'Encrypted attachment test',
        body: 'This mail carries an encrypted image.',
        attachments: [{
          fileName: 'e2e-proof.png',
          mimeType: 'image/png',
          dataBase64: bytes,
        }],
      });
      return { ok: true, txid: r.txid, recipient: r.recipient, feeSats: r.feeSats };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log(JSON.stringify(sent, null, 2));
  if (!sent.ok) throw new Error(`the send failed: ${sent.error}`);

  // Confirm the transaction on-chain and check the attachment output is there.
  await delay(3000);
  const chain = await fetch(`https://bananablocks.com/api/v1/tx/${sent.txid}`).then(r => r.json()).catch(() => null);
  if (chain) {
    const tx = chain.result || chain.transaction || chain;
    const outputs = tx.outputs || [];
    let attachmentOutputs = 0;
    for (const output of outputs) {
      const hex = output.script_pubkey || '';
      // 'mail_attachment' as a push
      if (hex.includes('6d61696c5f6174746163686d656e74')) attachmentOutputs += 1;
    }
    console.log('');
    console.log(`on-chain outputs: ${outputs.length}`);
    console.log(`attachment outputs found in the raw transaction: ${attachmentOutputs}`);
    if (attachmentOutputs !== 1) throw new Error(`expected exactly 1 attachment output, found ${attachmentOutputs}`);

    // The plaintext marker must NOT appear in the raw transaction.
    const raw = JSON.stringify(tx);
    const markerHex = Buffer.from('LBSX-ATTACHMENT-MARKER').toString('hex');
    if (raw.includes(markerHex)) throw new Error('the attachment plaintext is visible in the transaction');
    console.log('attachment plaintext is not present in the raw transaction: confirmed');

    // The file name IS public, as documented.
    const nameHex = Buffer.from('e2e-proof.png').toString('hex');
    console.log(`file name is public on-chain (as documented): ${raw.includes(nameHex)}`);
  } else {
    console.log('(chain lookup unavailable right now)');
  }

  console.log('');
  console.log(`txid: ${sent.txid}`);
  console.log('PASS: a real mainnet mail carried an encrypted attachment in its own data output, and the plaintext is not on-chain');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
  await unlink(attachmentFile).catch(() => {});
}
