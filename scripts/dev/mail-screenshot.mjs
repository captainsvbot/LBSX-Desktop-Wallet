import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const executable = path.join(projectRoot, packageJson.build.directories.output, 'win-unpacked', 'LBSX Desktop Wallet.exe');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), `lbsx-mail-shot-${process.pid}-`));
const profile = path.join(tempRoot, 'profile');
const outDir = path.join(projectRoot, 'docs', 'screenshots');
const debugPort = 9381;
let app;
let socket;
let requestId = 0;
const pending = new Map();

async function waitFor(check, label, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (_) {}
    await delay(250);
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
  app = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    stdio: 'ignore',
    env: { ...process.env, LBSX_TEST_PACKAGED: '1', LBSX_TEST_USER_DATA_DIR: profile },
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
  await cdp('Page.enable');
  await waitFor(async () => evaluate('document.body && document.body.innerText.length > 0'), 'the renderer');

  await evaluate(`(() => {
    const textarea = document.querySelector('.gate-form textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await delay(300);
  await evaluate("document.querySelector('.gate-form button[type=submit], .gate-submit').click()");
  await waitFor(async () => evaluate("!!document.querySelector('.sidebar')"), 'the app shell', 60000);
  await delay(1500);

  // Email tab
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1200);
  await evaluate("window.resizeTo && window.resizeTo(1500, 1000)");
  await delay(400);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(outDir, 'email-tab.png'), Buffer.from(shot.data, 'base64'));

  // Open the disclosure panel
  await evaluate("document.querySelector('.ml-info-button').click()");
  await delay(700);
  const shot2 = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(outDir, 'email-disclosure.png'), Buffer.from(shot2.data, 'base64'));

  // Open compose
  await evaluate("document.querySelector('.ml-info-button').click()");
  await delay(300);
  await evaluate("Array.from(document.querySelectorAll('.ml-primary-button')).find(b => /Compose/.test(b.textContent)).click()");
  await delay(900);
  const shot3 = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(outDir, 'email-compose.png'), Buffer.from(shot3.data, 'base64'));

  console.log('screenshots written to', outDir);
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
