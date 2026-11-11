// Verifies the INBOX shows the attachment, end to end, in the packaged app.
//
// The receiver's vault lives in a different app data directory. The wallet
// supports LBSX_TEST_USER_DATA_DIR for exactly this, so the same build can be
// pointed at the receiver's wallet and decrypt the attachment for real.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.12-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9460;
const userDataDir = 'C:/Users/Elton/AppData/Roaming/lbsx-desktop-wallet';
const RECEIVER = '1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE';
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
      LBSX_TEST_USER_DATA_DIR: userDataDir,
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

  const wallet = await evaluate("(async () => (await window.lbsx.walletSummary()))()");
  console.log('receiver wallet:', wallet.address);
  if (wallet.address !== RECEIVER) throw new Error(`wrong wallet loaded: ${wallet.address}`);

  // Sync the wallet so the activity rows are refreshed from the chain, then
  // sync the mailbox.
  console.log('');
  console.log('syncing the wallet activity (this refreshes the mail rows)...');
  await evaluate("(async () => { await window.lbsx.syncWalletActivity(); })()");
  await delay(6000);
  console.log('syncing the mailbox...');
  const syncResult = await evaluate("(async () => { const r = await window.lbsx.syncMail(); return { discovered: r.discovered, total: (r.messages||[]).length }; })()");
  console.log('mail sync:', JSON.stringify(syncResult));
  await delay(2000);

  const mail = await evaluate("(async () => (await window.lbsx.getMail()))()");
  const messages = mail.messages || [];
  console.log('');
  console.log('mailbox:');
  for (const m of messages.slice(-8)) {
    console.log(`  ${m.direction.padEnd(9)} ${m.txid.slice(0, 14)} ${String(m.status).padEnd(9)} att=${m.attachmentCount ?? 0}  ${JSON.stringify(m.subject || '').slice(0, 42)}`);
  }

  const withAttachment = messages.find(m => (m.attachmentCount || 0) > 0);
  if (!withAttachment) {
    throw new Error('no message in the INBOX has an attachment - the fix did not work');
  }
  console.log('');
  console.log('found a received mail with an attachment:', withAttachment.txid);
  console.log('  attachment refs:', JSON.stringify(withAttachment.attachmentRefs));

  // Now open it in the UI and confirm the attachment section renders.
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1500);
  const opened = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.ml-row'));
    const match = rows.find(r => r.innerText.includes(${JSON.stringify(withAttachment.subject || '')}));
    if (!match) return { found: false, sample: rows.slice(0, 4).map(r => r.innerText.replace(/\\n/g, ' | ')) };
    match.click();
    return { found: true };
  })()`);
  console.log('opened in the UI:', JSON.stringify(opened).slice(0, 200));
  if (!opened.found) throw new Error('the received mail could not be opened in the UI');
  await delay(1500);

  const detail = await evaluate(`(() => ({
    hasAttachments: !!document.querySelector('.ml-attachments'),
    head: document.querySelector('.ml-attachments-head')?.textContent?.trim() || null,
    rows: Array.from(document.querySelectorAll('.ml-attach-list-detail li')).map(r => r.innerText.replace(/\\n/g, ' | ')),
    buttons: Array.from(document.querySelectorAll('.ml-attach-list-detail li button')).map(b => b.textContent.trim()),
  }))()`);
  console.log('');
  console.log('detail view:', JSON.stringify(detail, null, 2));
  if (!detail.hasAttachments) throw new Error('the inbox detail view shows no attachment section');
  if (!detail.rows.length) throw new Error('the attachment list is empty');
  if (!detail.buttons.includes('Open')) throw new Error('the Open button is missing');

  // Click Open and confirm the image renders.
  await evaluate("Array.from(document.querySelectorAll('.ml-attach-list-detail li button')).find(b => b.textContent.trim() === 'Open').click()");
  await delay(4000);
  const preview = await evaluate(`(async () => {
    const img = document.querySelector('.ml-attach-preview img');
    if (!img) return { hasPreview: false };
    // Wait for the decode to settle.
    if (!img.complete) { try { await img.decode(); } catch (e) { /* decode error below */ } }
    const blob = await (await fetch(img.src)).blob();
    return {
      hasPreview: true,
      isBlob: img.src.startsWith('blob:'),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      blobType: blob.type,
      blobSize: blob.size,
      head: Array.from(new Uint8Array(await blob.slice(0, 8).arrayBuffer())).map(b => b.toString(16).padStart(2, '0')).join(''),
      error: document.querySelector('.ml-attach-error')?.textContent || null,
    };
  })()`);
  console.log('');
  console.log('preview:', JSON.stringify(preview));
  if (preview.error) throw new Error(`the attachment failed to open: ${preview.error}`);
  if (!preview.hasPreview) throw new Error('no image preview appeared');
  if (preview.naturalWidth < 1) throw new Error('the image did not decode');

  console.log('');
  console.log(`PASS: the INBOX shows the attachment, and Open decrypts and renders the image at ${preview.naturalWidth}x${preview.naturalHeight}`);
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
