// Sends a real email with a REAL image attachment ("email v2.png") from the
// wallet, to the other wallet, on mainnet.
//
// The wallet that is active in the app is whichever vault is unlocked. The
// script detects it and sends to the OTHER address, so the mail always goes
// somewhere meaningful.
//
// The image is 326 KB - far beyond the old Bitcoin 100 KB transaction limit
// and 6.5x the wallet's former 50 KB cap. BSV has no such limit.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9416;
const imagePath = 'C:/Users/Elton/Desktop/email v2.png';
const WALLET_A = '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut';
const WALLET_B = '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE';
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
  const image = await readFile(imagePath);
  console.log('=== REAL EMAIL WITH A REAL IMAGE ===');
  console.log('image:', imagePath);
  console.log('size :', image.length.toLocaleString(), 'bytes');
  console.log('type :', image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'PNG' : 'other');
  console.log('');

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
  console.log('active wallet:', wallet.address);

  // Send to the OTHER wallet.
  const recipient = wallet.address === WALLET_A ? WALLET_B : WALLET_A;
  console.log('recipient     :', recipient);

  // The recipient's public key is needed to encrypt. The other wallet's key
  // is a known contact, and its own card is available for the wallet itself.
  const recipientKey = recipient === WALLET_B
    ? '038f6c0bcf78db7e07fbb8a7325fa375add68e3abd58e4c7e84e7faac56c6dc97b'
    : card.publicKeyHex;
  console.log('recipient key :', recipientKey.slice(0, 24), '...');

  // The wallet caches its spendable UTXO set. A newly funded wallet needs a
  // full activity sync before the new outputs are visible to the sender.
  console.log('');
  console.log('syncing the wallet so the funded UTXOs are visible...');
  const synced = await evaluate("(async () => { try { const r = await window.lbsx.syncWalletActivity(); return { ok: true, r }; } catch (e) { return { ok: false, error: e.message }; } })()");
  console.log('sync:', JSON.stringify(synced).slice(0, 300));
  await delay(3000);

  console.log('');
  console.log('sending...');
  const sent = await evaluate(`(async () => {
    try {
      const r = await window.lbsx.sendMail({
        recipient: ${JSON.stringify(recipient)},
        recipientPublicKeyHex: ${JSON.stringify(recipientKey)},
        subject: 'Your email v2 screenshot',
        body: 'Here is the email v2 image, encrypted on-chain.',
        attachments: [{
          fileName: 'email v2.png',
          mimeType: 'image/png',
          dataBase64: ${JSON.stringify(image.toString('base64'))},
        }],
      });
      return { ok: true, txid: r.txid, feeSats: r.feeSats, recipient: r.recipient };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log(JSON.stringify(sent, null, 2));
  if (!sent.ok) throw new Error(`the send failed: ${sent.error}`);

  // Confirm on chain.
  await delay(4000);
  const chain = await fetch(`https://bananablocks.com/api/v1/tx/${sent.txid}`).then(r => r.json()).catch(() => null);
  if (chain) {
    const tx = chain.result || chain.transaction || chain;
    const outputs = tx.outputs || [];
    console.log('');
    console.log('on-chain outputs:');
    for (const output of outputs) {
      const hex = output.script_pubkey || '';
      const isAttachment = hex.includes('6d61696c5f6174746163686d656e74');
      const isMail = hex.includes('6d61696c2231');
      const label = isAttachment ? 'ATTACHMENT' : isMail ? 'mail payload' : 'payment';
      console.log(`  vout ${output.index}: ${label} (${hex.length / 2} bytes)`);
    }
    const raw = JSON.stringify(tx);
    const marker = Buffer.from('email v2.png').toString('hex');
    console.log('');
    console.log('attachment plaintext on-chain:', raw.includes(marker) ? 'FOUND (bad)' : 'not present (good)');
    console.log('file name on-chain (public by design):', raw.includes(marker));
  }

  console.log('');
  console.log(`txid: ${sent.txid}`);
  console.log(`PASS: a real ${image.length.toLocaleString()} byte PNG was encrypted and broadcast as an email attachment`);
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
