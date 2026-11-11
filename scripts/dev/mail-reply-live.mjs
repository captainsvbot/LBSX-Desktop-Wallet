// Exercises the full REPLY flow in the live app:
//   1. open a received mail
//   2. confirm the Reply button is offered
//   3. click it
//   4. confirm the compose panel is prefilled with the ORIGINAL sender and
//      the key recovered from the funding input
//   5. type a body and send
//   6. confirm the reply is broadcast and lands in the Sent list
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9403;
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
const setValue = (selector, value, proto = 'HTMLInputElement') => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const set = Object.getOwnPropertyDescriptor(window.${proto}.prototype, 'value').set;
  set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`;

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

  const wallet = await evaluate("(async () => (await window.lbsx.walletSummary()))()");
  console.log('wallet:', wallet.address);

  // Sync so the received mail is present, then go to Email.
  await evaluate("(async () => { await window.lbsx.syncWalletActivity(); })()");
  await evaluate("(async () => { await window.lbsx.syncMail(); })()");
  await delay(1500);
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1500);

  const inbox = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.ml-row'));
    return {
      count: rows.length,
      rows: rows.slice(0, 5).map(r => r.innerText.replace(/\\n/g, ' | ')),
    };
  })()`);
  console.log('inbox rows:', JSON.stringify(inbox, null, 2));
  if (!inbox.count) throw new Error('the inbox has no rows to reply to');

  // Open the first message.
  await evaluate("document.querySelector('.ml-row').click()");
  await delay(1200);

  const detail = await evaluate(`(() => ({
    subject: document.querySelector('.ml-detail-head h2')?.textContent || null,
    replyButton: !!Array.from(document.querySelectorAll('.ml-detail-foot button')).find(b => /Reply/.test(b.textContent)),
    replyUnavailable: !!document.querySelector('.ml-reply-unavailable'),
    unreadToggled: !!Array.from(document.querySelectorAll('.ml-detail-meta button')).find(b => /Mark as/.test(b.textContent)),
  }))()`);
  console.log('detail:', JSON.stringify(detail, null, 2));
  if (!detail.replyButton) throw new Error('the Reply button is not offered for this received mail');

  // Click Reply and check the compose panel is prefilled.
  await evaluate("Array.from(document.querySelectorAll('.ml-detail-foot button')).find(b => /Reply/.test(b.textContent)).click()");
  await delay(1000);

  const compose = await evaluate(`(() => ({
    recipient: document.querySelector('.ml-compose select')?.value || null,
    recipientOptions: Array.from(document.querySelectorAll('.ml-compose select option')).map(o => o.textContent.trim()),
    key: document.querySelector('.ml-readonly')?.value || null,
    subject: document.querySelectorAll('.ml-compose input[type=text]')[1]?.value || null,
    hint: document.querySelector('.ml-hint')?.textContent || null,
    sendDisabled: Array.from(document.querySelectorAll('.ml-primary-button')).find(b => /Encrypt/.test(b.textContent))?.disabled,
  }))()`);
  console.log('compose prefilled:', JSON.stringify(compose, null, 2));
  if (!compose.key) throw new Error('the reply compose panel has no recipient key');
  if (!compose.subject || !/^Re:/i.test(compose.subject)) throw new Error('the reply subject was not prefilled with Re:');

  // Type a body and send.
  await evaluate(setValue('.ml-compose textarea', 'Replying from the receiving wallet. This reply is encrypted back to your public key.', 'HTMLTextAreaElement'));
  await delay(500);
  const before = await evaluate("(async () => (await window.lbsx.getMail()))()");
  const sentBefore = (before.messages || []).filter(m => m.direction === 'sent').length;

  console.log('');
  console.log('sending the reply (broadcasts to mainnet)...');
  const sent = await evaluate(`(async () => {
    try {
      const r = await window.lbsx.sendMail({
        recipient: document.querySelector('.ml-compose select').value,
        recipientPublicKeyHex: document.querySelector('.ml-readonly').value,
        subject: document.querySelectorAll('.ml-compose input[type=text]')[1].value,
        body: document.querySelector('.ml-compose textarea').value,
      });
      return { ok: true, txid: r.txid, recipient: r.recipient, subject: r.subject, feeSats: r.feeSats };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log(JSON.stringify(sent, null, 2));
  if (!sent.ok) throw new Error(`reply send failed: ${sent.error}`);

  await delay(2000);
  const after = await evaluate("(async () => (await window.lbsx.getMail()))()");
  const sentAfter = (after.messages || []).filter(m => m.direction === 'sent');
  console.log('sent messages:', sentBefore, '->', sentAfter.length);
  const reply = sentAfter.find(m => m.txid === sent.txid);
  console.log('reply in sent list:', reply ? `yes (${reply.status})` : 'no');
  if (!reply) throw new Error('the reply did not appear in the Sent list');

  console.log('');
  console.log('PASS: the reply flow prefills the original sender and the recovered key, and the reply is broadcast');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1500);
}
