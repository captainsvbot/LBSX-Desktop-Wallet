// Exercises the ATTACHMENT flow in the live packaged app:
//   1. open the Email tab
//   2. confirm the attachment picker is present in compose
//   3. attach a real file through the file input
//   4. confirm it appears in the compose list with its name and size
//   5. confirm the public-metadata warning is shown
//   6. confirm an oversized file is rejected
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9411;
const scratch = path.join(projectRoot, 'scripts', 'dev');
const goodFile = path.join(scratch, '_attach-test.png');
const bigFile = path.join(scratch, '_attach-test-big.bin');
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

// Writes a real PNG (8-byte signature + IHDR-ish payload) so the browser
// reports a believable image type.
function makePng(bytes) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(bytes, 0x42),
  ]);
}

try {
  await writeFile(goodFile, makePng(24 * 1024));
  await writeFile(bigFile, Buffer.alloc(60 * 1024, 0x43));

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
  await cdp('DOM.enable');
  await waitFor(async () => evaluate("!!document.querySelector('.sidebar')"), 'the app shell');

  // Go to the Email tab.
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1200);

  // Open compose.
  await evaluate("Array.from(document.querySelectorAll('button')).find(b => /New mail|Write|Compose/i.test(b.textContent))?.click()");
  await delay(900);

  const compose = await evaluate(`(() => ({
    hasPicker: !!document.querySelector('.ml-attach-picker'),
    pickerText: document.querySelector('.ml-attach-picker')?.textContent?.trim() || null,
    fileInput: !!document.querySelector('.ml-attach-picker input[type=file]'),
    hint: Array.from(document.querySelectorAll('.ml-hint')).map(h => h.textContent).find(t => /file name stays public/i.test(t)) || null,
    multiple: document.querySelector('.ml-attach-picker input[type=file]')?.multiple || false,
  }))()`);
  console.log('compose picker:', JSON.stringify(compose, null, 2));
  if (!compose.hasPicker) throw new Error('the attachment picker is missing from compose');
  if (!compose.fileInput) throw new Error('the attachment picker has no file input');
  if (!compose.hint) throw new Error('the public file-name warning is missing');

  // Attach the good file through the real file input.
  const { root } = await cdp('DOM.getDocument');
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '.ml-attach-picker input[type=file]' });
  if (!nodeId) throw new Error('could not resolve the file input node');
  await cdp('DOM.setFileInputFiles', { nodeId, files: [goodFile] });
  await delay(1200);

  const attached = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.ml-attach-list li'));
    return {
      count: rows.length,
      rows: rows.map(r => r.innerText.replace(/\\n/g, ' | ')),
      hasRemove: !!document.querySelector('.ml-attach-list li button'),
    };
  })()`);
  console.log('attached:', JSON.stringify(attached, null, 2));
  if (attached.count !== 1) throw new Error(`expected 1 attachment, found ${attached.count}`);
  if (!/_attach-test\.png/.test(attached.rows[0])) throw new Error('the attached file name is not shown');
  if (!/24\.0 KB|24 KB/.test(attached.rows[0])) throw new Error('the attachment size is not shown');

  // Now attach an oversized file and confirm it is rejected.
  const { nodeId: nodeId2 } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '.ml-attach-picker input[type=file]' });
  await cdp('DOM.setFileInputFiles', { nodeId: nodeId2, files: [bigFile] });
  await delay(1200);

  const oversized = await evaluate(`(() => ({
    error: document.querySelector('.ml-error')?.textContent?.trim() || null,
    count: document.querySelectorAll('.ml-attach-list li').length,
  }))()`);
  console.log('oversized:', JSON.stringify(oversized, null, 2));
  if (!oversized.error) throw new Error('an oversized attachment must be rejected with a message');
  if (!/50 KB or smaller|larger than 50 KB/i.test(oversized.error)) {
    throw new Error(`the rejection message is wrong: ${oversized.error}`);
  }
  if (oversized.count !== 1) throw new Error('the oversized file must not be added to the list');

  // Remove the attachment and confirm it clears.
  await evaluate("document.querySelector('.ml-attach-list li button').click()");
  await delay(500);
  const afterRemove = await evaluate("document.querySelectorAll('.ml-attach-list li').length");
  if (afterRemove !== 0) throw new Error('the remove button did not clear the attachment');

  console.log('');
  console.log('PASS: the attachment picker accepts files, shows the name and size, warns about the public file name, rejects an oversized file, and removes an attachment');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
  await unlink(goodFile).catch(() => {});
  await unlink(bigFile).catch(() => {});
}
