// Captures the attachment list with the VirusTotal scan flow.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.12-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9495;
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

  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1500);
  await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.ml-row'));
    const match = rows.find(r => r.innerText.includes('Your email v2 screenshot'));
    if (match) match.click();
  })()`);
  await delay(1500);

  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const out = path.join(projectRoot, 'docs', 'screenshots', 'email-attachment-scan.png');
  await (await import('node:fs/promises')).mkdir(path.dirname(out), { recursive: true });
  await (await import('node:fs/promises')).writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', out);

  const state = await evaluate(`(() => ({
    buttons: Array.from(document.querySelectorAll('.ml-attach-list-detail li button')).map(b => b.textContent.trim()),
    note: document.querySelector('.ml-attachments-note')?.textContent || null,
    hasPreview: !!document.querySelector('.ml-attach-preview'),
  }))()`);
  console.log('state:', JSON.stringify(state));
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
