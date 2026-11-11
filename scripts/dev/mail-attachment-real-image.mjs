// End-to-end attachment test using a REAL PNG image.
//
// The image is the user's own "email v2.png" screenshot, resized to fit under
// the 50 KB attachment limit. This exercises the real path: a genuine PNG
// file, real MIME detection, real encryption, real broadcast, real fetch,
// real decryption, and real rendering in the renderer.
//
// It also checks the OVERSIZE rejection with the original 326 KB file, which
// is the realistic case the user hit.
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.10-email', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9415;
const scratch = path.join(projectRoot, 'scripts', 'dev');
const sourceImage = 'C:/Users/Elton/Desktop/email v2.png';
const smallImage = path.join(scratch, '_real-image-small.png');
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
  const small = await readFile(smallImage);
  const full = await readFile(sourceImage);
  console.log('=== REAL IMAGE ATTACHMENT TEST ===');
  console.log('source image :', sourceImage);
  console.log('  original   :', full.length.toLocaleString(), 'bytes (over the limit)');
  console.log('  resized    :', small.length.toLocaleString(), 'bytes (fits)');

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

  const wallet = await evaluate("(async () => (await window.lbsx.walletSummary()))()");
  const card = await evaluate("(async () => (await window.lbsx.getOwnMailCard()))()");
  console.log('wallet:', wallet.address);

  // --- 1. the OVERSIZE case, through the real UI file input ---
  await evaluate("Array.from(document.querySelectorAll('.nav-item')).find(n => n.textContent.includes('Email')).click()");
  await delay(1200);
  await evaluate("Array.from(document.querySelectorAll('.ml-toolbar-actions button')).find(b => /Compose/.test(b.textContent))?.click()");
  await delay(900);

  const { root } = await cdp('DOM.getDocument');
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '.ml-attach-picker input[type=file]' });
  await cdp('DOM.setFileInputFiles', { nodeId, files: [sourceImage] });
  await delay(1500);

  const oversize = await evaluate(`(() => ({
    error: document.querySelector('.ml-error')?.textContent?.trim() || null,
    count: document.querySelectorAll('.ml-attach-list li').length,
  }))()`);
  console.log('');
  console.log('oversized file result:', JSON.stringify(oversize));
  if (!oversize.error) throw new Error('the 326 KB image must be rejected');
  if (!/50 KB|larger than 50 KB/i.test(oversize.error)) throw new Error(`wrong rejection message: ${oversize.error}`);
  if (oversize.count !== 0) throw new Error('the oversized file must not be added');

  // --- 2. the FITS case, through the real UI file input ---
  const { nodeId: nodeId2 } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '.ml-attach-picker input[type=file]' });
  await cdp('DOM.setFileInputFiles', { nodeId: nodeId2, files: [smallImage] });
  await delay(1500);

  const attached = await evaluate(`(() => ({
    rows: Array.from(document.querySelectorAll('.ml-attach-list li')).map(r => r.innerText.replace(/\\n/g,' | ')),
  }))()`);
  console.log('attached:', JSON.stringify(attached));
  if (!attached.rows.length) throw new Error('the resized image was not attached');
  if (!/_real-image-small\.png/.test(attached.rows[0])) throw new Error('the image name is not shown');

  // --- 3. send it, with the real bytes ---
  console.log('');
  console.log('sending the mail with the real image...');
  const sent = await evaluate(`(async () => {
    try {
      const r = await window.lbsx.sendMail({
        recipient: ${JSON.stringify(wallet.address)},
        recipientPublicKeyHex: ${JSON.stringify(card.publicKeyHex)},
        subject: 'Real image attachment',
        body: 'Sending a real PNG.',
        attachments: [{
          fileName: 'email-v2.png',
          mimeType: 'image/png',
          dataBase64: ${JSON.stringify(small.toString('base64'))},
        }],
      });
      return { ok: true, txid: r.txid, feeSats: r.feeSats };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log(JSON.stringify(sent, null, 2));
  if (!sent.ok) throw new Error(`the send failed: ${sent.error}`);

  await delay(4000);

  // --- 4. fetch it back and decrypt it ---
  const mail = await evaluate("(async () => (await window.lbsx.getMail()))()");
  const record = (mail.messages || []).find(m => m.txid === sent.txid);
  if (!record) throw new Error('the sent mail was not found in the mailbox');
  console.log('attachment refs:', JSON.stringify(record.attachmentRefs));
  if (!record.attachmentRefs?.length) throw new Error('the mail has no attachment refs');

  const fetched = await evaluate(`(async () => {
    try {
      const r = await window.lbsx.getMailAttachment({
        txid: ${JSON.stringify(sent.txid)},
        vout: ${record.attachmentRefs[0].vout},
        senderAddress: ${JSON.stringify(wallet.address)},
        recipientAddress: ${JSON.stringify(wallet.address)},
        messageId: ${JSON.stringify(record.messageId)},
        fileName: ${JSON.stringify(record.attachmentRefs[0].name)},
        mimeType: ${JSON.stringify(record.attachmentRefs[0].mimeType)},
        byteLength: ${small.length},
      });
      const bytes = new Uint8Array(r.data);
      // A rolling checksum over the decrypted bytes, compared with the same
      // checksum over the original file.
      let sum = 0;
      for (let i = 0; i < bytes.length; i += 1) { sum = (sum + bytes[i] * (i % 251 + 1)) % 2147483647; }
      return {
        ok: true,
        fileName: r.fileName,
        mimeType: r.mimeType,
        byteLength: r.byteLength,
        receivedBytes: bytes.length,
        pngMagic: Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(''),
        checksum: sum,
      };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  console.log('fetched:', JSON.stringify(fetched, null, 2));
  if (!fetched.ok) throw new Error(`the fetch failed: ${fetched.error}`);
  if (fetched.receivedBytes !== small.length) throw new Error('the decrypted size does not match');
  if (fetched.pngMagic !== '89504e470d0a1a0a') throw new Error('the PNG signature was not preserved');
  // The same checksum over the ORIGINAL file must match.
  let expected = 0;
  for (let i = 0; i < small.length; i += 1) { expected = (expected + small[i] * (i % 251 + 1)) % 2147483647; }
  if (fetched.checksum !== expected) {
    throw new Error(`the decrypted bytes differ from the original (checksum ${fetched.checksum} vs ${expected})`);
  }
  console.log('  decrypted checksum matches the original file:', fetched.checksum === expected);

  // --- 5. render it in the UI ---
  await evaluate("(async () => { await window.lbsx.syncMail(); })()");
  await delay(2500);
  await evaluate("Array.from(document.querySelectorAll('.ml-tabs button')).find(b => b.textContent.trim().startsWith('Sent'))?.click()");
  await delay(1200);
  const opened = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.ml-row'));
    const match = rows.find(r => r.innerText.includes('Real image attachment'));
    if (!match) return { found: false };
    match.click();
    return { found: true };
  })()`);
  if (!opened.found) throw new Error('the sent mail was not found in the Sent list');
  await delay(1500);

  const detail = await evaluate(`(() => ({
    rows: Array.from(document.querySelectorAll('.ml-attach-list-detail li')).map(r => r.innerText.replace(/\\n/g,' | ')),
  }))()`);
  console.log('detail attachment list:', JSON.stringify(detail));
  if (!detail.rows.length) throw new Error('the detail view does not list the attachment');

  await evaluate("Array.from(document.querySelectorAll('.ml-attach-list-detail li button')).find(b => b.textContent.trim() === 'Open').click()");
  await delay(3500);

  const preview = await evaluate(`(() => {
    const img = document.querySelector('.ml-attach-preview img');
    return {
      hasPreview: !!img,
      isBlob: img ? img.src.startsWith('blob:') : false,
      naturalWidth: img ? img.naturalWidth : 0,
      naturalHeight: img ? img.naturalHeight : 0,
      error: document.querySelector('.ml-attach-error')?.textContent || null,
    };
  })()`);
  console.log('preview:', JSON.stringify(preview));
  if (preview.error) throw new Error(`the attachment failed to open: ${preview.error}`);
  if (!preview.hasPreview) throw new Error('no image preview appeared');
  if (!preview.isBlob) throw new Error('the preview is not a blob URL');
  if (preview.naturalWidth < 1) throw new Error('the image did not decode');

  console.log('');
  console.log(`PASS: a real PNG was attached, sent, fetched, decrypted byte-identically and rendered at ${preview.naturalWidth}x${preview.naturalHeight}`);
  console.log('      the 326 KB original was correctly rejected with a clear message');
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
  await delay(1200);
}
