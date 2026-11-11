import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const executable = process.env.LBSX_PACKAGED_EXE
  ? path.resolve(process.env.LBSX_PACKAGED_EXE)
  : path.join(projectRoot, packageJson.build?.directories?.output || 'release-windows', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), `lbsx-packaged-smoke-${process.pid}-`));
const profile = path.join(tempRoot, 'profile');
const debugPort = 9361;
let app;
let socket;
let requestId = 0;
const pending = new Map();

async function waitFor(check, label, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (_) {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function cdpCommand(method, params = {}) {
  const id = ++requestId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}

async function evaluate(expression) {
  const response = await cdpCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Renderer threw an exception');
  return response.result.value;
}

try {
  app = spawn(executable, [`--remote-debugging-port=${debugPort}`], { stdio: 'ignore', env: { ...process.env, LBSX_TEST_PACKAGED: '1', LBSX_TEST_SPV_ERROR: '1', LBSX_TEST_USER_DATA_DIR: profile } });
  const target = await waitFor(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return pages.find(page => page.type === 'page' && page.url.startsWith('file://'));
    } catch (_) { return null; }
  }, 'packaged file:// renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id); pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  const body = await waitFor(async () => {
    const text = await evaluate('document.body?.innerText || ""');
    return text.includes('Import your wallet') ? text : null;
  }, 'packaged import screen');
  assert(body.includes('Recovery phrase'), 'packaged first screen should ask for the existing recovery phrase');
  const assetState = await evaluate(`JSON.stringify({ url: location.href, scripts: [...document.scripts].map(s => s.src), root: document.querySelector('#root')?.children.length })`);
  assert(JSON.parse(assetState).root > 0, `packaged React app should render into #root: ${assetState}`);
  const logo = await waitFor(async () => {
    const images = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('img.brand-logo')].map(img => ({ src: img.currentSrc, loaded: img.complete && img.naturalWidth > 0 })))`));
    return images.find(image => image.loaded) || null;
  }, 'packaged wallet logo');
  assert(logo, 'packaged wallet should load its LBSX logo');
  await evaluate(`window.lbsx.importSeedPhrase({ mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', password: '' })`);
  for (let index = 1; index <= 11; index++) {
    const token = {
      tokenId: `${index.toString(16).padStart(64, '0')}_0`,
      symbol: `TST${index}`,
      name: `Test token ${index}`,
      decimals: 0,
      balance: '0',
    };
    await evaluate(`window.lbsx.saveImportedToken(${JSON.stringify(token)})`);
  }
  await evaluate('location.reload()');
  await waitFor(async () => evaluate(`(document.body?.innerText || '').includes('Good to see you.')`), 'unlocked test wallet');
  const overviewCopy = await evaluate(`document.querySelector('.overview-sync-copy')?.innerText || ''`);
  assert(
    overviewCopy.includes('Balances sync from BananaBlocks')
      && overviewCopy.includes('Your recovery phrase and private keys never leave this device.'),
    'Overview should explain sync data sources, local protection, and secret handling',
  );
  assert(
    await evaluate(`(() => { const heading = document.querySelector('.overview-heading'); const copy = document.querySelector('.overview-sync-copy'); return Boolean(heading && copy && heading.scrollWidth <= heading.clientWidth && copy.scrollWidth <= copy.clientWidth); })()`),
    'Overview sync explanation should wrap without horizontal overflow',
  );
  const navOrder = await evaluate(`JSON.stringify([...document.querySelectorAll('button.nav-item')].map(button => button.innerText.trim()))`);
  const navLabels = JSON.parse(navOrder);
  assert(navLabels.indexOf('Send') < navLabels.indexOf('Receive')
    && navLabels.indexOf('Receive') < navLabels.indexOf('Assets')
    && navLabels.indexOf('BSV-21 Tools') < navLabels.indexOf('Peer Chat'),
  'Send, Receive, Assets, and Peer Chat should appear in the requested navigation order');
  await waitFor(async () => evaluate(`(() => { const image = document.querySelector('.bsv-coin img.bsv-logo'); return Boolean(image?.complete && image.naturalWidth > 0); })()`), 'packaged BSV balance logo');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.innerText.includes('Sync balances')); if (!button) return false; button.click(); return true; })()`), 'packaged wallet should expose balance sync');
  await waitFor(async () => evaluate(`(() => { const image = document.querySelector('.token-icon img.token-image'); return Boolean(image?.complete && image.naturalWidth > 0); })()`), 'Overview token image from the cached icon outpoint');
  const assetsButton = await evaluate(`(() => { const button = [...document.querySelectorAll('button.nav-item')].find(item => item.innerText.includes('Assets')); if (!button) return false; button.click(); return true; })()`);
  assert(assetsButton, 'packaged wallet should have an Assets navigation item');
  assert(await evaluate(`(() => [...document.querySelectorAll('.token-repair-panel button')].some(button => button.innerText.includes('Repair token verification')))()`),
    'Assets should offer a repair action when local SPV token verification fails');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('.token-repair-panel button')].find(item => item.innerText.includes('Repair token verification')); if (!button) return false; button.click(); return true; })()`),
    'the token verification repair action should retry balance and token verification sync');
  await waitFor(async () => evaluate(`document.querySelector('.page-heading .secondary-button')?.innerText.includes('Syncing…')`), 'token recovery sync to start');
  await waitFor(async () => evaluate(`document.querySelector('.token-repair-panel button')?.innerText.includes('Repair token verification')`), 'token recovery sync to complete');
  await waitFor(async () => evaluate(`(() => { const image = document.querySelector('.token-row .token-icon img.token-image'); return Boolean(image?.complete && image.naturalWidth > 0); })()`), 'Assets token image');
  const assetReference = await evaluate(`(() => { const ref = document.querySelector('.token-row .token-reference'); return ref ? { value: ref.dataset.referenceValue, label: ref.querySelector('.explorer-reference-link')?.innerText, kind: ref.dataset.referenceKind } : null; })()`);
  assert(assetReference?.value === `${'11'.repeat(32)}_1` && assetReference.label === assetReference.value && assetReference.kind === 'token', 'Assets should display the full token ID as an explorer link');
  assert(await evaluate(`(() => { const button = document.querySelector('.token-row .token-reference .explorer-reference-copy'); if (!button) return false; button.click(); return true; })()`), 'Asset token ID should expose a copy control');
  await waitFor(async () => evaluate(`document.querySelector('.token-row .token-reference .explorer-reference-copy')?.getAttribute('aria-label') === 'token ID copied'`), 'copied full asset token ID');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('.token-row .token-actions button')].find(item => item.innerText.includes('Send')); if (!button) return false; button.click(); return true; })()`), 'Assets should open the token-send dialog');
  await waitFor(async () => evaluate(`document.querySelector('.token-modal #token-modal-title')?.innerText === 'Send TEST'`), 'token-send dialog');
  assert(await evaluate(`(() => { const form = document.querySelector('.token-modal form'); if (!form) return false; const [recipient, amount] = form.querySelectorAll('input'); const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setValue.call(recipient, '1TestRecipientAddress'); recipient.dispatchEvent(new Event('input', { bubbles: true })); setValue.call(amount, '1'); amount.dispatchEvent(new Event('input', { bubbles: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return true; })()`), 'token-send review should open');
  await waitFor(async () => evaluate(`document.querySelector('.token-modal')?.innerText.includes('Review before broadcast')`), 'token-send review');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('.token-modal button')].find(item => item.innerText.includes('Broadcast transfer')); if (!button) return false; button.click(); return true; })()`), 'token-send review should allow the mocked failure to reach the error state');
  await waitFor(async () => evaluate(`document.querySelector('.token-modal .sync-error')?.innerText.includes('local SPV header-chain record is invalid')`), 'token-send SPV error');
  assert(await evaluate(`(() => [...document.querySelectorAll('.token-modal .token-repair-panel button')].some(button => button.innerText.includes('Repair token verification')))()`),
    'token-send SPV errors should offer local token verification repair');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('.token-modal .token-repair-panel button')].find(item => item.innerText.includes('Repair token verification')); if (!button) return false; button.click(); return true; })()`),
    'token-send repair should retry balance and token verification sync without broadcasting');
  await waitFor(async () => evaluate(`document.querySelector('.token-modal .token-repair-panel button')?.innerText.includes('Repairing token outputs…')`), 'token-send repair to start');
  await waitFor(async () => evaluate(`document.querySelector('.token-modal .token-repair-panel button')?.innerText.includes('Repair token verification')`), 'token-send repair to complete');
  assert(await evaluate(`(() => { const button = document.querySelector('.token-modal button[aria-label="Close"]'); if (!button) return false; button.click(); return true; })()`), 'token-send dialog should close after repair');
  const receiveButton = await evaluate(`(() => { const button = [...document.querySelectorAll('button.nav-item')].find(item => item.innerText.includes('Receive')); if (!button) return false; button.click(); return true; })()`);
  assert(receiveButton, 'packaged wallet should have a Receive navigation item');
  await waitFor(async () => evaluate(`(() => { const image = document.querySelector('.receive-symbol img.bsv-logo'); return Boolean(image?.complete && image.naturalWidth > 0); })()`), 'packaged receive BSV logo');
  const tradingButton = await evaluate(`(() => { const button = [...document.querySelectorAll('button.nav-item')].find(item => item.innerText.includes('Trading')); if (!button) return false; button.click(); return true; })()`);
  assert(tradingButton, 'packaged wallet should have a Trading navigation item');
  await waitFor(async () => evaluate(`(() => { const image = document.querySelector('.market-token-mark img.token-image'); return Boolean(image?.complete && image.naturalWidth > 0); })()`), 'Trading token image');
  const toolsButton = await evaluate(`(() => { const button = [...document.querySelectorAll('button.nav-item')].find(item => item.innerText.includes('BSV-21 Tools')); if (!button) return false; button.click(); return true; })()`);
  assert(toolsButton, 'packaged wallet should have a BSV-21 Tools navigation item');
  await waitFor(async () => evaluate(`(document.body?.innerText || '').includes('Mint A Token')`), 'packaged BSV-21 mint tool');
  const peerChatButton = await evaluate(`(() => { const button = [...document.querySelectorAll('button.nav-item')].find(item => item.innerText.includes('Peer Chat')); if (!button) return false; button.click(); return true; })()`);
  assert(peerChatButton, 'packaged wallet should have a Peer Chat navigation item');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('.pc-composer'))`), 'packaged Peer Chat page');
  const peerChatFeatures = await evaluate(`document.querySelector('.pc-feature-cards')?.innerText || ''`);
  assert(peerChatFeatures.includes('Wallet community')
    && peerChatFeatures.includes('Publicly reversible')
    && peerChatFeatures.includes('encrypted for this wallet')
    && peerChatFeatures.includes('1,000 sats to the admin wallet, plus the miner fee'),
  'Peer Chat should show compact community, encoding, and posting-cost cards');
  assert(await evaluate(`(() => {
    const row = document.createElement('article');
    row.className = 'pc-message-row is-mine';
    row.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px';
    const avatar = document.createElement('span');
    avatar.className = 'pc-avatar-spacer';
    const stack = document.createElement('div');
    stack.className = 'pc-message-stack';
    const bubble = document.createElement('div');
    bubble.className = 'pc-message-bubble is-mine';
    bubble.textContent = 'Outgoing message';
    stack.append(bubble);
    row.append(avatar, stack);
    document.body.append(row);
    const alignedRight = getComputedStyle(row).justifyContent === 'flex-end'
      && getComputedStyle(stack).alignItems === 'flex-end'
      && Math.abs(bubble.getBoundingClientRect().right - row.getBoundingClientRect().right) < 1;
    row.remove();
    return alignedRight;
  })()`), 'own Peer Chat message bubbles should align to the right');
  assert(await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.pc-feature-card')];
    return cards.length === 3 && cards.every(card => {
      const style = getComputedStyle(card);
      return card.getBoundingClientRect().height < 80 && parseFloat(style.paddingTop) <= 8;
    });
  })()`), 'Peer Chat feature cards should fit their text with minimal top spacing');
  assert(await evaluate(`(() => {
    const main = document.querySelector('.main-area');
    const topbar = document.querySelector('.topbar');
    return getComputedStyle(main).backgroundImage === 'none'
      && getComputedStyle(topbar).backgroundColor === 'rgba(11, 16, 17, 0.82)';
  })()`), 'Peer Chat should use the same page and top-bar background as other tabs');
  assert(await evaluate(`(() => { const panel = document.querySelector('.pc-panel'); const composer = document.querySelector('.pc-composer'); const list = document.querySelector('.pc-message-list'); return Boolean(panel && composer && list && Math.abs(panel.getBoundingClientRect().height - 520) < 2 && getComputedStyle(document.querySelector('.pc-chat-body')).flexDirection === 'column'); })()`),
    'Peer Chat should render a centered 520px chat panel with the composer below the message list');
  assert(await evaluate(`(() => { const panel = document.querySelector('.pc-panel'); const section = document.querySelector('.pc-pending-transactions'); return Boolean(panel && section && (panel.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING) && !document.querySelector('.peer-chat-broadcast')); })()`),
    'pending Peer Chat transactions should appear below the chat without the old broadcast banner');
  assert(await evaluate(`(() => { const section = document.querySelector('.pc-pending-transactions'); const status = section?.querySelector('.pc-pending-status'); return Boolean(section?.innerText.includes('Pending Transactions') && section.innerText.includes('7 pending') && document.querySelectorAll('.pc-pending-row').length === 5 && getComputedStyle(status).color === 'rgb(250, 204, 21)'); })()`),
    'pending transactions should use a yellow status treatment and show five recent rows per page');
  assert((await evaluate(`document.querySelector('.pc-pending-transactions .activity-pagination')?.innerText || ''`)).includes('Showing 1–5 of 7 pending'),
    'the first pending-transaction page should report its row range');
  assert(await evaluate(`(() => { const button = document.querySelector('.pc-pending-transactions .activity-page-button[aria-label="Next page"]'); if (!button || button.disabled) return false; button.click(); return true; })()`),
    'pending Peer Chat transactions should allow moving to the next page');
  await waitFor(async () => evaluate(`document.querySelectorAll('.pc-pending-row').length === 2`), 'second Peer Chat transaction page');
  assert((await evaluate(`document.querySelector('.pc-pending-transactions .activity-pagination')?.innerText || ''`)).includes('Showing 6–7 of 7 pending'),
    'the second pending-transaction page should report its row range');
  assert(await evaluate(`(() => { const button = document.querySelector('.pc-pending-transactions .activity-page-button[aria-label="Previous page"]'); if (!button || button.disabled) return false; button.click(); return true; })()`),
    'pending Peer Chat transactions should allow returning to the previous page');
  await waitFor(async () => evaluate(`document.querySelectorAll('.pc-pending-row').length === 5`), 'first Peer Chat transaction page after returning');
  assert(await evaluate(`Boolean(document.querySelector('.pc-page-heading .pc-live-badge') && document.querySelector('.pc-header-actions .pc-dex-button'))`),
    'Peer Chat should use the compact title and Token DEX action layout');
  assert(await evaluate(`(() => { const link = document.querySelector('.pc-message-meta .pc-on-chain-link'); return Boolean(link?.querySelector('.explorer-reference-link')?.innerText.includes('on-chain') && !link.querySelector('.explorer-reference-copy')); })()`),
    'Peer Chat messages should use the compact on-chain link instead of a transaction ID and copy control');
  if (process.env.LBSX_PACKAGED_SCREENSHOT) {
    const screenshot = await cdpCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.resolve(process.env.LBSX_PACKAGED_SCREENSHOT), Buffer.from(screenshot.data, 'base64'));
  }
  assert(await evaluate(`(() => { const button = document.querySelector('.pc-header-actions button[aria-label="Members"]'); if (!button) return false; button.click(); return true; })()`), 'Peer Chat should expose its members drawer');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('.pc-members-drawer'))`), 'Peer Chat members drawer');
  assert(await evaluate(`document.querySelectorAll('.pc-member-row').length === 2`), 'members drawer should list locally indexed wallet addresses');
  assert(await evaluate(`(() => { const button = document.querySelector('.pc-members-drawer button[aria-label="Close members"]'); if (!button) return false; button.click(); return true; })()`), 'members drawer should close');
  assert(await evaluate(`(() => { const button = document.querySelector('.pc-header-actions button[aria-label="About Peer Chat"]'); if (!button) return false; button.click(); return true; })()`), 'Peer Chat should expose its information panel');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('.pc-info-popover[role="dialog"]'))`), 'Peer Chat information panel');
  const peerChatInfo = await evaluate(`document.querySelector('.pc-info-popover')?.innerText || ''`);
  assert(peerChatInfo.includes('anyone can reverse it')
    && peerChatInfo.includes('1,000 sats to the admin wallet plus a miner fee'),
  'Peer Chat information should explain public reversibility and the cost of posting');
  assert(await evaluate(`(() => { const button = document.querySelector('.pc-info-popover button[aria-label="Close about Peer Chat"]'); if (!button) return false; button.click(); return true; })()`), 'Peer Chat information panel should close');
  assert(await evaluate(`(() => { const button = document.querySelector('.pc-composer button[aria-label="Add emoji"]'); if (!button) return false; button.click(); return true; })()`), 'Peer Chat should expose its emoji picker');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('.pc-emoji-picker[role="dialog"]'))`), 'Peer Chat emoji picker');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('.pc-emoji-picker button')].find(item => item.innerText === '😊'); if (!button) return false; button.click(); return true; })()`), 'emoji picker should accept an emoji selection');
  await waitFor(async () => evaluate(`document.querySelector('#peer-chat-message')?.value === '😊'`), 'emoji insertion into the composer');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('.pc-composer button')].find(item => item.innerText.includes('Tip Token')); if (!button) return false; button.click(); return true; })()`), 'Peer Chat should expose its token-tip flow');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('.pc-tip-dialog[role="dialog"]'))`), 'token-tip dialog');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('.pc-tip-option')].find(item => item.innerText.includes('TEST')); if (!button) return false; button.click(); return true; })()`), 'token-tip dialog should list the test token balance');
  await waitFor(async () => evaluate(`document.querySelector('.pc-tip-dialog')?.innerText.includes('Select a Peer')`), 'token-tip peer selection');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('.pc-tip-option')].find(item => item.innerText.includes('1BoatSLRHt')); if (!button) return false; button.click(); return true; })()`), 'token-tip dialog should list an indexed peer recipient');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('.pc-tip-amount-stage'))`), 'token-tip amount entry');
  assert(await evaluate(`(() => { const input = document.querySelector('.pc-tip-amount-input input'); if (!input) return false; const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setValue.call(input, '1.25'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), 'token-tip dialog should accept a decimal amount');
  assert(await evaluate(`(() => { const button = [...document.querySelectorAll('.pc-tip-primary')].find(item => item.innerText.includes('Review Tip')); if (!button || button.disabled) return false; button.click(); return true; })()`), 'token-tip dialog should allow reviewing a valid amount');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('.pc-tip-review'))`), 'token-tip review');
  assert((await evaluate(`document.querySelector('.pc-tip-review')?.innerText || ''`)).includes('1.25 TEST'), 'token-tip review should show the selected peer, token, and exact amount');
  assert(await evaluate(`(() => { const button = document.querySelector('.pc-tip-dialog button[aria-label="Close tip"]'); if (!button) return false; button.click(); return true; })()`), 'token-tip review should close without broadcasting');
  const activityButton = await evaluate(`(() => { const button = [...document.querySelectorAll('button.nav-item')].find(item => item.innerText.includes('Activity')); if (!button) return false; button.click(); return true; })()`);
  assert(activityButton, 'packaged wallet should have an Activity navigation item');
  await waitFor(async () => evaluate(`(document.body?.innerText || '').includes('CURRENT BSV BALANCE') && (document.body?.innerText || '').includes('LOCAL WALLET HISTORY')`), 'packaged activity ledger and BSV balance');
  assert(await evaluate(`(() => [...document.querySelectorAll('.activity-heading-actions button')].some(button => button.innerText.includes('Check pending')))()`),
    'Activity should expose the pending-only status check separately from a full history refresh');
  await waitFor(async () => evaluate(`document.querySelectorAll('.activity-row').length === 6`), 'six-row activity page');
  assert(await evaluate(`Boolean(document.querySelector('.activity-page-number[aria-current="page"]'))`), 'activity page should mark its current page');
  assert(await evaluate(`(() => { const button = document.querySelector('.activity-page-button[aria-label="Next page"]'); if (!button || button.disabled) return false; button.click(); return true; })()`), 'activity ledger should expose Next when more local entries exist');
  await waitFor(async () => evaluate(`document.querySelectorAll('.activity-row').length === 5`), 'second activity page');
  assert((await evaluate(`document.querySelector('.activity-pagination')?.innerText || ''`)).includes('Showing 7–11 of 11 loaded'), 'second page should show the correct loaded range');
  assert(await evaluate(`(() => { const button = document.querySelector('.activity-page-button[aria-label="Previous page"]'); if (!button || button.disabled) return false; button.click(); return true; })()`), 'activity ledger should allow returning to the previous page');
  await waitFor(async () => evaluate(`document.querySelectorAll('.activity-row').length === 6`), 'first activity page after returning');
  console.log('PASS: packaged Windows app loads token assets, validates navigation and Peer Chat controls/tip review/pending-transaction pagination, repairs local SPV, and renders Activity pagination');
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await Promise.race([cdpCommand('Browser.close').catch(() => {}), delay(1000)]);
  }
  try { socket?.close(); } catch (_) {}
  if (app?.pid && app.exitCode === null) {
    const exited = new Promise(resolve => app.once('exit', () => resolve(true)));
    const didExit = await Promise.race([exited, delay(5000).then(() => false)]);
    if (!didExit) {
      try { app.kill(); } catch (_) {}
      await Promise.race([exited, delay(5000)]);
    }
    await waitFor(async () => {
      try { await fetch(`http://127.0.0.1:${debugPort}/json/list`); return false; }
      catch (_) { return true; }
    }, 'packaged app shutdown', 10000).catch(() => {});
  }
  const safeTempRoot = path.resolve(tempRoot);
  const requiredPrefix = path.resolve(os.tmpdir(), `lbsx-packaged-smoke-${process.pid}-`);
  if (safeTempRoot.startsWith(requiredPrefix)) await rm(safeTempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
}
