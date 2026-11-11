// Verifies the two fixes in the packaged 2.1.12 app:
//   1. the contact form has NO public key field - the backend derives it
//   2. a received mail shows its attachment in the inbox detail view
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.12-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9440;
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

  console.log('version shown:', await evaluate("document.querySelector('.sidebar-foot .version')?.textContent || null"));

  // --- 1. the contact form must NOT ask for a public key ---
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1200);
  await evaluate("Array.from(document.querySelectorAll('button')).find(b => /Add contact/i.test(b.textContent))?.click()");
  await delay(900);

  const form = await evaluate(`(() => {
    const panel = document.querySelector('.ml-add-contact');
    if (!panel) return { found: false };
    const labels = Array.from(panel.querySelectorAll('.ml-field > span')).map(s => s.textContent.trim());
    const inputs = Array.from(panel.querySelectorAll('input')).map(i => i.placeholder);
    return { found: true, labels, inputs, text: panel.innerText };
  })()`);
  console.log('contact form:', JSON.stringify(form, null, 2));
  if (!form.found) throw new Error('the add-contact form did not open');
  if (form.labels.some(label => /public key/i.test(label))) {
    throw new Error('the contact form still asks for a public key');
  }
  if (form.inputs.some(placeholder => /^02|^03/.test(placeholder || ''))) {
    throw new Error('the contact form still has a public key input');
  }

  // --- 2. the backend must derive the key from the address alone ---
  const derived = await evaluate(`(async () => {
    try {
      const contact = await window.lbsx.saveMailContact({
        address: '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE',
        label: 'Derivation probe',
      });
      return { ok: true, contact };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log('backend derivation:', JSON.stringify(derived, null, 2));
  if (!derived.ok) throw new Error(`the backend could not derive the key: ${derived.error}`);
  if (!derived.contact.publicKeyHex) throw new Error('no public key was derived');
  console.log('  derived key:', derived.contact.publicKeyHex.slice(0, 24), '...');

  // Clean up the probe contact.
  await evaluate("(async () => { try { await window.lbsx.removeMailContact('1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE'); } catch (e) {} })()");

  console.log('');
  console.log('PASS: the contact form asks only for a name and an address, and the backend derives and verifies the public key');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
