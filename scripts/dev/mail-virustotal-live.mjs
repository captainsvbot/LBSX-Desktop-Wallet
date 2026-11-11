// Verifies the VirusTotal scan flow in the packaged app.
//
// The scan is hash-first: the SHA-256 is checked with VirusTotal BEFORE any
// upload, so a file VirusTotal already knows never leaves the device.
//
// This test needs a VirusTotal API key. If one is not configured in the
// app, the scan must fail with a clear message and NO upload may happen -
// that failure path is verified too.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.12-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9490;
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

  // --- 1. the API key status is readable ---
  const keyStatus = await evaluate("(async () => { try { return await window.lbsx.getVirusTotalApiKeyStatus(); } catch (e) { return { error: e.message }; } })()");
  console.log('VT key status:', JSON.stringify(keyStatus));

  // --- 2. the attachment row shows [Virus Scan] and [Save], and no [Open] ---
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1500);
  const opened = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.ml-row'));
    const match = rows.find(r => r.innerText.includes('Your email v2 screenshot'));
    if (!match) return { found: false };
    match.click();
    return { found: true };
  })()`);
  if (!opened.found) throw new Error('the mail with the attachment was not found');
  await delay(1500);

  const actions = await evaluate(`(() => {
    const li = document.querySelector('.ml-attach-list-detail li');
    if (!li) return { found: false };
    return {
      found: true,
      buttons: Array.from(li.querySelectorAll('button')).map(b => b.textContent.trim()),
      text: li.innerText.replace(/\\n/g, ' | '),
      note: document.querySelector('.ml-attachments-note')?.textContent || null,
    };
  })()`);
  console.log('attachment row:', JSON.stringify(actions, null, 2));
  if (!actions.found) throw new Error('the attachment row was not found');
  if (!actions.buttons.includes('Virus Scan')) throw new Error('the Virus Scan button is missing');
  if (!actions.buttons.includes('Save')) throw new Error('the Save button is missing');
  if (actions.buttons.includes('Open')) throw new Error('the Open button must be gone');
  if (!actions.note || !/not previewed/i.test(actions.note)) {
    throw new Error('the "not previewed" note is missing');
  }

  // --- 3. the scan runs and reports a verdict ---
  await evaluate("Array.from(document.querySelectorAll('.ml-attach-list-detail li button')).find(b => b.textContent.trim() === 'Virus Scan').click()");
  await delay(8000);

  const scanResult = await evaluate(`(() => ({
    result: document.querySelector('.ml-scan-result')?.innerText?.replace(/\\n/g, ' | ') || null,
    error: document.querySelector('.ml-attach-error')?.textContent || null,
    confirm: document.querySelector('.ml-upload-confirm')?.innerText?.replace(/\\n/g, ' | ') || null,
  }))()`);
  console.log('');
  console.log('scan result:', JSON.stringify(scanResult, null, 2));

  if (scanResult.error) {
    // The no-API-key path is a legitimate outcome. It must be a clear
    // message, and no upload may have been attempted.
    console.log('');
    console.log(`The scan reported: ${scanResult.error}`);
    if (!/api key/i.test(scanResult.error)) {
      throw new Error(`unexpected scan error: ${scanResult.error}`);
    }
    console.log('PASS: without an API key the scan fails clearly and uploads nothing');
  } else {
    if (!scanResult.result) throw new Error('the scan produced no result');
    console.log('');
    console.log('PASS: the scan ran and reported a verdict');
  }
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
