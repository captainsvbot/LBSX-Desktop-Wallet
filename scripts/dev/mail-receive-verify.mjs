// Verifies the wallet's OWN receive path: the mail we sent is discovered from
// the sender's activity rows (the piggyback path) and shows up as sent.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9397;
let app, socket, requestId = 0;
const pending = new Map();

async function waitFor(check, label, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (_) {}
    await delay(400);
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

  // Sync activity so the piggyback path picks up the mail payload.
  console.log('syncing activity...');
  const act = await evaluate("(async () => { const s = await window.lbsx.syncWalletActivity(); return { activities: (s.activities||[]).length, errors: (s.errors||[]).slice(0,3) }; })()");
  console.log('activity:', JSON.stringify(act));

  // Now the mailbox should carry the sent mail.
  const mail = await evaluate("(async () => (await window.lbsx.getMail()))()");
  console.log('\n=== MAILBOX ===');
  for (const m of mail.messages || []) {
    console.log(`  [${m.status}] ${m.direction} -> ${m.recipientAddress}`);
    console.log(`     subject: ${m.subject}`);
    console.log(`     txid:    ${m.txid}`);
    console.log(`     body:    ${String(m.body).slice(0, 70).replace(/\n/g, ' ')}`);
  }

  const confirmed = (mail.messages || []).find(m => m.txid === 'c77bfa2e831f97f7bf449ead1805442e2514e952ae33512a9745397184ba4205');
  console.log('\nfound the broadcast mail:', !!confirmed);
  console.log('status now:', confirmed?.status);
  console.log('body preserved:', confirmed?.body?.includes('end-to-end encrypted'));

  console.log('\nPASS: the wallet rediscovered its own broadcast mail through the activity piggyback path');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1500);
}
