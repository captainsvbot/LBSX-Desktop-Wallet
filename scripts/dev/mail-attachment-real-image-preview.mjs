// Confirms the REAL image renders in the preview.
//
// The earlier detail test used a synthetic attachment (PNG magic bytes but not
// a real PNG), so the browser could not decode it and naturalWidth was 0.
// This test opens the mail that carries the user's actual "email v2.png"
// (a real PNG) and checks that the browser actually decodes it.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.12-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9480;
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

  // Open the mail that carries the user's real image.
  const opened = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.ml-row'));
    const match = rows.find(r => r.innerText.includes('Your email v2 screenshot'));
    if (!match) return { found: false, sample: rows.slice(0, 5).map(r => r.innerText.replace(/\\n/g, ' | ')) };
    match.click();
    return { found: true, row: match.innerText.replace(/\\n/g, ' | ') };
  })()`);
  console.log('opened:', JSON.stringify(opened).slice(0, 200));
  if (!opened.found) throw new Error('the mail carrying the real image was not found');
  await delay(1500);

  const detail = await evaluate(`(() => ({
    rows: Array.from(document.querySelectorAll('.ml-attach-list-detail li')).map(r => r.innerText.replace(/\\n/g, ' | ')),
  }))()`);
  console.log('attachment row:', JSON.stringify(detail.rows));
  if (!detail.rows.length) throw new Error('the real attachment is not listed');
  if (!/319\.0 KB/.test(detail.rows[0])) {
    throw new Error(`unexpected attachment size: ${detail.rows[0]}`);
  }

  // Open it and wait for the browser to actually decode the image.
  await evaluate("Array.from(document.querySelectorAll('.ml-attach-list-detail li button')).find(b => b.textContent.trim() === 'Open').click()");
  await delay(5000);

  const preview = await evaluate(`(async () => {
    const img = document.querySelector('.ml-attach-preview img');
    if (!img) return { hasPreview: false, error: document.querySelector('.ml-attach-error')?.textContent || null };
    if (!img.complete) { try { await img.decode(); } catch (e) { /* reported below */ } }

    // Pull the bytes straight out of the blob so the actual content can be
    // inspected, not just the decode result.
    let blobInfo = null;
    try {
      const response = await fetch(img.src);
      const blob = await response.blob();
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      blobInfo = {
        type: blob.type,
        size: blob.size,
        head: Array.from(head).map(b => b.toString(16).padStart(2, '0')).join(''),
      };
    } catch (e) {
      blobInfo = { fetchError: String(e) };
    }

    // Also decode the raw bytes with an ImageBitmap, which reports failures.
    let bitmap = null;
    try {
      const response = await fetch(img.src);
      const blob = await response.blob();
      const bmp = await createImageBitmap(blob);
      bitmap = { width: bmp.width, height: bmp.height };
    } catch (e) {
      bitmap = { decodeError: String(e).slice(0, 160) };
    }

    return {
      hasPreview: true,
      isBlob: img.src.startsWith('blob:'),
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      blobInfo,
      bitmap,
      error: document.querySelector('.ml-attach-error')?.textContent || null,
    };
  })()`);
  console.log('');
  console.log('preview:', JSON.stringify(preview, null, 2));
  if (preview.error) throw new Error(`the attachment failed to open: ${preview.error}`);
  if (!preview.hasPreview) throw new Error('no image preview appeared');
  if (preview.naturalWidth < 1) throw new Error(`the image did not decode (naturalWidth ${preview.naturalWidth})`);

  console.log('');
  console.log(`PASS: the real 319 KB PNG decrypts and the browser decodes it at ${preview.naturalWidth}x${preview.naturalHeight}`);
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
