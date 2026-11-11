import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9395;
let app, socket, requestId = 0;
const pending = new Map();

async function waitFor(check, label, timeoutMs = 60000) {
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

const RECIPIENT = '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut';
const SUBJECT = 'LBSX encrypted mail test';
const BODY = 'This message is end-to-end encrypted to your public key. Only the holder of your private key can read it.\n\n- LBSX Desktop Wallet 2.1.10';

try {
  app = spawn(executable, [`--remote-debugging-port=${debugPort}`], { stdio: 'ignore', env: { ...process.env } });
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
  await waitFor(async () => evaluate('document.body && document.body.innerText.length > 0'), 'the renderer');
  await waitFor(async () => evaluate("!!document.querySelector('.sidebar')"), 'the app shell');

  const sender = await evaluate("(async () => (await window.lbsx.walletSummary()))()");
  console.log('sender   :', sender.address);

  const recipientKey = (await readFile(path.join(projectRoot, '.recipient-pubkey.txt'), 'utf8')).trim();
  console.log('recipient:', RECIPIENT);
  console.log('recipient key:', recipientKey);

  // Add the recipient as a contact through the real IPC path.
  const saved = await evaluate(`(async () => {
    try {
      const c = await window.lbsx.saveMailContact({ address: ${JSON.stringify(RECIPIENT)}, publicKeyHex: ${JSON.stringify(recipientKey)}, label: 'Test Recipient' });
      const list = await window.lbsx.getMailContacts();
      return { ok: true, saved: c, count: list.length };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log('contact saved:', JSON.stringify(saved));
  if (!saved.ok) throw new Error(`contact save failed: ${saved.error}`);

  // Send the mail through the real send path (this broadcasts to mainnet).
  console.log('\nSENDING (broadcasts to BSV mainnet)...');
  const sent = await evaluate(`(async () => {
    try {
      const r = await window.lbsx.sendMail({
        recipient: ${JSON.stringify(RECIPIENT)},
        recipientPublicKeyHex: ${JSON.stringify(recipientKey)},
        subject: ${JSON.stringify(SUBJECT)},
        body: ${JSON.stringify(BODY)},
      });
      return { ok: true, result: r };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log(JSON.stringify(sent, null, 2));
  if (!sent.ok) throw new Error(`send failed: ${sent.error}`);

  // Confirm it landed in the local mailbox as pending.
  await delay(1500);
  const mailbox = await evaluate("(async () => (await window.lbsx.getMail()))()");
  console.log('\nmailbox messages:', (mailbox.messages || []).length);
  for (const m of mailbox.messages || []) {
    console.log(`  [${m.status}] ${m.direction} -> ${m.recipientAddress} | ${m.subject} | txid ${m.txid}`);
  }

  console.log('\nPASS: the test mail was encrypted, signed and broadcast to mainnet');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1500);
}
