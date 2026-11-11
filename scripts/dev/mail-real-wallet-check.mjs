import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9391;
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

try {
  // The real wallet profile. NO LBSX_TEST_USER_DATA_DIR - this is the actual
  // wallet at %APPDATA%\lbsx-desktop-wallet.
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

  console.log('=== BOOT STATE ===');
  console.log(await evaluate("document.body.innerText.slice(0,400)"));

  // The wallet is device-mode, so it opens unlocked automatically.
  const hasShell = await evaluate("!!document.querySelector('.sidebar')");
  console.log('app shell visible:', hasShell);

  if (hasShell) {
    await waitFor(async () => evaluate("!!document.querySelector('.nav-item')"), 'the nav');
    console.log('nav items:', JSON.stringify(await evaluate("Array.from(document.querySelectorAll('.nav-item span')).map(n => n.textContent)")));

    // Wallet address (public).
    const summary = await evaluate("(async () => (await window.lbsx.walletSummary()))()");
    console.log('wallet address:', summary.address);

    // The wallet's own mail card: address + compressed public key.
    const card = await evaluate("(async () => (await window.lbsx.getOwnMailCard()))()");
    console.log('own card:', JSON.stringify(card));

    // The mail snapshot + contacts.
    const mail = await evaluate("(async () => (await window.lbsx.getMail()))()");
    console.log('mail messages:', (mail.messages || []).length, '| syncedAt:', mail.syncedAt);
    const contacts = await evaluate("(async () => (await window.lbsx.getMailContacts()))()");
    console.log('mail contacts:', JSON.stringify(contacts));

    // Navigate to the Email tab.
    await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
    await delay(1500);
    console.log('\n=== EMAIL TAB (real wallet) ===');
    console.log(await evaluate("document.querySelector('.ml-page')?.innerText || '(no page)'"));

    // Verify the real wallet's own key round-trips through contact validation.
    const validation = await evaluate(`(async () => {
      const card = await window.lbsx.getOwnMailCard();
      try {
        await window.lbsx.saveMailContact({ address: card.address, publicKeyHex: card.publicKeyHex, label: 'Self (real wallet)' });
        const list = await window.lbsx.getMailContacts();
        return { ok: true, count: list.length, contact: list[0] };
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    console.log('\nself-contact validation on the real wallet:', JSON.stringify(validation, null, 2));
  }
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1500);
}
