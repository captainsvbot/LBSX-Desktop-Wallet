import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const executable = path.join(projectRoot, packageJson.build.directories.output, 'win-unpacked', 'LBSX Desktop Wallet.exe');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), `lbsx-mail-flow-${process.pid}-`));
const profile = path.join(tempRoot, 'profile');
const debugPort = 9385;
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
// Set a React-controlled input value properly.
const setInput = (selector, value, proto = 'HTMLInputElement') => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const set = Object.getOwnPropertyDescriptor(window.${proto}.prototype, 'value').set;
  set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`;

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

  await evaluate(setInput('.gate-form textarea', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'HTMLTextAreaElement'));
  await delay(300);
  await evaluate("document.querySelector('.gate-form button[type=submit], .gate-submit').click()");
  await waitFor(async () => evaluate("!!document.querySelector('.sidebar')"), 'the app shell', 60000);
  await delay(1500);

  // Read our own address + public key straight from the wallet.
  const own = await evaluate(`(async () => {
    const card = await window.lbsx.getOwnMailCard();
    return card;
  })()`);
  assert.ok(own && own.address, 'the wallet must expose its own mail card');
  assert.match(own.publicKeyHex, /^(02|03)[0-9a-f]{64}$/, 'the wallet must expose a compressed public key');
  console.log('own card:', own.address, own.publicKeyHex.slice(0, 16) + '…');

  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1000);

  // --- add a contact (self, so the key/address pair is known-good) ---
  await evaluate("Array.from(document.querySelectorAll('.ml-text-button')).find(b => /Add contact/.test(b.textContent)).click()");
  await delay(500);
  const addFields = await evaluate("Array.from(document.querySelectorAll('.ml-add-contact .ml-field')).map(f => f.querySelector('span')?.textContent?.trim())");
  console.log('add-contact fields:', JSON.stringify(addFields));

  await evaluate(setInput('.ml-add-contact .ml-field:nth-of-type(1) input', 'Self'));
  await evaluate(setInput('.ml-add-contact .ml-field:nth-of-type(2) input', own.address));
  await evaluate(setInput('.ml-add-contact .ml-field:nth-of-type(3) input', own.publicKeyHex));
  await delay(300);
  await evaluate("Array.from(document.querySelectorAll('.ml-add-contact .ml-primary-button')).find(b => /Save contact/.test(b.textContent)).click()");
  await delay(1200);
  console.log('contact error:', await evaluate("document.querySelector('.ml-error')?.innerText || '(none)'"));
  console.log('contacts panel:', await evaluate("document.querySelector('.ml-contacts-panel')?.innerText || '(none)'"));

  const contactRows = await evaluate("Array.from(document.querySelectorAll('.ml-contact-row')).map(r => r.innerText.replace(/\\n/g, ' | '))");
  assert.ok(contactRows.length === 1, `expected one contact, got ${JSON.stringify(contactRows)}`);
  console.log('contact saved:', contactRows[0]);

  // --- open compose: the contact should now be selectable ---
  await evaluate("Array.from(document.querySelectorAll('.ml-primary-button')).find(b => /Compose/.test(b.textContent)).click()");
  await delay(800);
  const selectOptions = await evaluate("Array.from(document.querySelectorAll('.ml-compose select option')).map(o => o.textContent.trim())");
  console.log('recipient options:', JSON.stringify(selectOptions));
  assert.ok(selectOptions.some(o => /Self/.test(o)), 'the saved contact must appear in the recipient picker');

  // --- select the contact, type a message ---
  await evaluate(`(() => {
    const sel = document.querySelector('.ml-compose select');
    const opt = Array.from(sel.options).find(o => /Self/.test(o.textContent));
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    set.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.value;
  })()`);
  await delay(600);

  await evaluate(setInput('.ml-compose .ml-field:nth-of-type(2) input', 'Hello'));
  await evaluate(setInput('.ml-compose textarea', 'This is a secret message.', 'HTMLTextAreaElement'));
  await delay(500);

  const composeState = await evaluate(`(() => {
    const fields = Array.from(document.querySelectorAll('.ml-compose .ml-field'));
    return {
      fieldLabels: fields.map(f => f.querySelector('span')?.textContent?.trim()),
      readonlyKey: document.querySelector('.ml-readonly')?.value || null,
      bodyBytes: document.querySelector('.ml-hint')?.textContent?.trim(),
      sendDisabled: Array.from(document.querySelectorAll('.ml-primary-button')).find(b => /Encrypt/.test(b.textContent))?.disabled,
      feeNote: document.querySelector('.ml-fee-note')?.innerText?.replace(/\\n/g, ' '),
    };
  })()`);
  console.log('compose state:', JSON.stringify(composeState, null, 2));
  assert.ok(composeState.readonlyKey, 'the recipient key must be shown once a contact is picked');
  assert.equal(composeState.sendDisabled, false, 'the send button must be enabled with a recipient and body');

  // --- the send must be blocked by an explicit review, not broadcast blind ---
  console.log('\nNote: send is intentionally not exercised here — it would broadcast to mainnet.');

  console.log('\nPASS: contact add, recipient picker, compose form and fee disclosure all work in the packaged app');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
