import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const executable = path.join(projectRoot, packageJson.build.directories.output, 'win-unpacked', 'LBSX Desktop Wallet.exe');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), `lbsx-mail-dom-${process.pid}-`));
const profile = path.join(tempRoot, 'profile');
const debugPort = 9383;
let app, socket, requestId = 0;
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
  await waitFor(async () => evaluate('document.body && document.body.innerText.length > 0'), 'the renderer');

  await evaluate(`(() => {
    const ta = document.querySelector('.gate-form textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await delay(300);
  await evaluate("document.querySelector('.gate-form button[type=submit], .gate-submit').click()");
  await waitFor(async () => evaluate("!!document.querySelector('.sidebar')"), 'the app shell', 60000);
  await delay(1500);
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1200);

  console.log('===== EMAIL TAB RENDERED TEXT =====');
  console.log(await evaluate("document.querySelector('.ml-page')?.innerText || '(no .ml-page)'"));

  console.log('\n===== LAYOUT METRICS =====');
  console.log(JSON.stringify(await evaluate(`(() => {
    const box = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
    return {
      page: box('.ml-page'),
      heading: box('.ml-page-heading'),
      toolbar: box('.ml-toolbar'),
      layout: box('.ml-layout'),
      listPanel: box('.ml-list-panel'),
      detailPanel: box('.ml-detail-panel'),
      contacts: box('.ml-contacts-panel'),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  })()`), null, 2));

  console.log('\n===== COMPOSE PANEL =====');
  await evaluate("Array.from(document.querySelectorAll('.ml-primary-button')).find(b => /Compose/.test(b.textContent)).click()");
  await delay(900);
  console.log(await evaluate("document.querySelector('.ml-compose')?.innerText || '(no compose)'"));
  console.log('\ncompose metrics:', JSON.stringify(await evaluate(`(() => {
    const r = document.querySelector('.ml-compose')?.getBoundingClientRect();
    const fields = Array.from(document.querySelectorAll('.ml-field')).map(f => {
      const fr = f.getBoundingClientRect();
      const input = f.querySelector('input, textarea, select');
      return { label: f.querySelector('span')?.textContent?.trim(), w: Math.round(fr.width), hasInput: !!input, inputW: input ? Math.round(input.getBoundingClientRect().width) : 0 };
    });
    return { w: r ? Math.round(r.width) : null, fields };
  })()`), null, 2));

  console.log('\n===== DISCLOSURE =====');
  await evaluate("document.querySelector('.ml-info-button').click()");
  await delay(600);
  console.log(await evaluate("document.querySelector('.ml-info-panel')?.innerText || '(none)'"));
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
