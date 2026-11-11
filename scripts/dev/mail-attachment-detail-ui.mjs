// Exercises the attachment UI in the DETAIL view against a real attachment:
// the Open button must fetch, decrypt and preview the image.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9414;
let app, socket, requestId = 0;
const pending = new Map();

const ATTACHMENT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('UI-PREVIEW-MARKER-'),
  Buffer.alloc(6 * 1024, 0x44),
]);

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

  const wallet = await evaluate("(async () => (await window.lbsx.walletSummary()))()");
  const card = await evaluate("(async () => (await window.lbsx.getOwnMailCard()))()");

  // Reuse a mail that was already sent, rather than spending more coins. The
  // wallet's unconfirmed balance is currently locked by earlier test sends.
  console.log('looking for an existing mail with an attachment...');

  // Open the Email tab and find the sent mail.
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1500);
  await evaluate("(async () => { await window.lbsx.syncMail(); })()");
  await delay(2500);
  await evaluate("(async () => { await window.lbsx.syncMail(); })()");
  await delay(2500);

  // Switch to Sent and open the mail.
  await evaluate("Array.from(document.querySelectorAll('.ml-tabs button')).find(b => b.textContent.trim().startsWith('Sent'))?.click()");
  await delay(1200);

  const opened = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.ml-row'));
    // Any sent mail that carries an attachment will do.
    const match = rows.find(r => /Live decrypt test|UI preview test/.test(r.innerText));
    if (!match) return { found: false, sample: rows.slice(0,3).map(r => r.innerText.replace(/\\n/g,' | ')) };
    match.click();
    return { found: true };
  })()`);
  console.log('mail row:', JSON.stringify(opened));
  if (!opened.found) throw new Error('the sent mail was not found in the Sent list');
  await delay(1200);

  // The detail view must list the attachment.
  const detail = await evaluate(`(() => ({
    hasAttachments: !!document.querySelector('.ml-attachments'),
    head: document.querySelector('.ml-attachments-head')?.textContent?.trim() || null,
    rows: Array.from(document.querySelectorAll('.ml-attach-list-detail li')).map(r => r.innerText.replace(/\\n/g,' | ')),
    buttons: Array.from(document.querySelectorAll('.ml-attach-list-detail li button')).map(b => b.textContent.trim()),
  }))()`);
  console.log('detail:', JSON.stringify(detail, null, 2));
  if (!detail.hasAttachments) throw new Error('the detail view does not list the attachment');
  if (!detail.rows.length) throw new Error('the attachment row is missing');
  if (!/ui-preview\.png/.test(detail.rows[0])) throw new Error('the attachment name is wrong');
  if (!detail.buttons.includes('Open')) throw new Error('the Open button is missing');
  if (!detail.buttons.includes('Save')) throw new Error('the Save button is missing');

  // Click Open and confirm the image preview appears.
  await evaluate("Array.from(document.querySelectorAll('.ml-attach-list-detail li button')).find(b => b.textContent.trim() === 'Open').click()");
  await delay(3000);

  const preview = await evaluate(`(() => {
    const img = document.querySelector('.ml-attach-preview img');
    return {
      hasPreview: !!img,
      src: img ? img.src.slice(0, 30) : null,
      naturalWidth: img ? img.naturalWidth : null,
      error: document.querySelector('.ml-attach-error')?.textContent || null,
    };
  })()`);
  console.log('preview:', JSON.stringify(preview, null, 2));
  if (preview.error) throw new Error(`the attachment failed to open: ${preview.error}`);
  if (!preview.hasPreview) throw new Error('no image preview appeared');
  if (!preview.src.startsWith('blob:')) throw new Error('the preview is not a blob URL');

  console.log('');
  console.log('PASS: the detail view lists the attachment, and Open fetches, decrypts and previews the image');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
