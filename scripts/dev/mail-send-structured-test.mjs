// Sends a real test email through the packaged app's own IPC path.
//
// This drives `window.lbsx.sendMail(...)` in the renderer - the exact call the
// Compose panel makes - so the mail is encrypted, broadcast and anchored on
// chain by the real wallet code, not by a simulation.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.15-check', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9492;
const RECIPIENT = '1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut';

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

// The email body. It is deliberately long and structured - headings, lists,
// a table, a quote and a signature - so the rendering of a real-world message
// can be judged, not just a one-liner.
const SUBJECT = 'LBSX Desktop Wallet — Email feature test (2.1.15)';
const BODY = `Hello Jordan,

This is a structured test message for the LBSX Desktop Wallet email feature. It is intentionally long so the layout, the spacing and the typographic hierarchy can be judged against real content rather than a placeholder.

WHAT THIS MESSAGE IS FOR

This message exercises the whole encrypted mail path in LBSX Desktop Wallet 2.1.15. It is sent from the wallet itself, encrypted to your public key and anchored on-chain, so it proves the following in one go:

  1. Composition - the body is encrypted with AES-256-GCM to the recipient's public key.
  2. Delivery - the transaction is broadcast to the Bitcoin SV mainnet.
  3. Discovery - the recipient's wallet finds the message in its own address history.
  4. Decryption - the recipient's wallet decrypts it using the private key that never leaves their device.
  5. Rendering - the message is displayed with its structure intact.

WHY IT MATTERS

Encryption without correct rendering is a half-built feature. A mail client that can secure a message but cannot show a bulleted list, a heading or a quote is not finished. This message therefore leans on structure rather than on length alone.

  • The body is longer than a typical note, so the message panel has to scroll.
  • It mixes plain paragraphs with structured content.
  • It includes punctuation, numbers and a link, because those are where naive renderers break.
  • It ends with a sign-off, so the bottom margin can be checked.

A SHORT NOTE ON PRIVACY

The body of this message is private. Only the holder of the matching private key can read it - not the author of the app, not the indexer, and not anyone watching the chain.

The metadata is not private. The sender address, the recipient address, the timestamp and the message size are written on-chain and stay visible permanently. Treat the timing and the size of your mail as public information.

There is no forward secrecy. If the recipient's private key is ever compromised, every message ever sent to them can be decrypted from the public chain.

WHAT TO CHECK WHEN YOU RECEIVE IT

  1. Does the body render with its headings, lists and quote intact?
  2. Does the message panel scroll cleanly from the first line to the sign-off?
  3. Does the status show as CONFIRMED rather than PENDING?
  4. Do the reply, pin, spam and delete actions all respond correctly?
  5. Is the sender shown with the verified badge if you have trusted this contact?

A FEW LINES OF FILLER, TO GIVE THE SCROLL SOMETHING TO DO

The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump! The five boxing wizards jump quickly. Sphinx of black quartz, judge my vow. Two driven jocks help fax my big quiz in. Waltz, bad nymph, for quick jigs vex. Waltz, nymph, for quick jigs vex! Waltz, nymph, for quick jigs vex. Bright vixens jump; dozy fowl quack. Quick zephyrs blow, vexing daft Jim. Quick wafting zephyrs vex bold Jim. Sphinx of black quartz, judge my vow. Jackdaws love my big sphinx of quartz. How vexingly quick daft zebras jump.

  1. First numbered item - a numbered list should keep its numbering even when it is long enough to wrap.
  2. Second numbered item - the indent should stay consistent between items.
  3. Third numbered item - and the spacing after the list should be the same as before it.
  4. Fourth numbered item - so the block reads as a list and not as a run-on paragraph.

And a quotation, because quotes are set in their own block and must not run into the paragraph above or below it:

  "The message body is private. The metadata is public. Those are two different statements and a wallet that blurs them is not telling you the truth."

CLOSING

If this message arrives intact, encrypted, and readable, the mail feature is doing its job. If anything looks wrong - the body is garbled, the status stays pending, or a button does nothing - that is the report I need.

Thanks for testing,

Captain
LBSX Desktop Wallet

—
Sent from LBSX Desktop Wallet 2.1.15 on Bitcoin SV mainnet.
This message is end-to-end encrypted. Only the recipient's private key can read it.`;

try {
  app = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    stdio: 'ignore',
    env: {
      ...process.env,
      LBSX_TEST_USER_DATA_DIR: 'C:/Users/Elton/AppData/Roaming/lbsx-desktop-wallet',
    },
  });

  const target = await waitFor(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return pages.find(page => page.type === 'page' && page.webSocketDebuggerUrl);
  }, 'the renderer target');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });

  await waitFor(async () => evaluate('typeof window.lbsx === "object" && !!window.lbsx.sendMail'), 'the lbsx bridge');

  // The wallet must be unlocked, otherwise the send fails with "Wallet is
  // locked." The vault unlocks on launch when it is already open.
  const unlocked = await waitFor(async () => evaluate(
    'window.lbsx.getWalletSummary ? window.lbsx.getWalletSummary() : null'
  ), 'the wallet summary');
  console.log('sending from:', unlocked?.address || unlocked);

  // Resolve the recipient's public key from the local contact list - the same
  // key the Compose panel uses to encrypt.
  const contacts = await evaluate('window.lbsx.getMailContacts()');
  const contact = (contacts || []).find(row => row.address === RECIPIENT);
  if (!contact) throw new Error(`No contact for ${RECIPIENT}. Contacts: ${(contacts || []).map(c => c.address).join(', ')}`);
  console.log('recipient key:', contact.publicKeyHex.slice(0, 12) + '…');

  const result = await evaluate(`window.lbsx.sendMail(${JSON.stringify({
    recipient: RECIPIENT,
    recipientPublicKeyHex: contact.publicKeyHex,
    subject: SUBJECT,
    body: BODY,
  })})`);

  console.log('\n=== SEND RESULT ===');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nsubject length:', SUBJECT.length);
  console.log('body length:', BODY.length);
  console.log('body lines:', BODY.split('\n').length);
} catch (error) {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch (_) {}
  try { app?.kill(); } catch (_) {}
}
