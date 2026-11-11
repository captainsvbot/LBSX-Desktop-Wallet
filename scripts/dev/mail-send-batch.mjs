// Sends a batch of real encrypted emails through the packaged app's own IPC
// path - the exact `window.lbsx.sendMail(...)` call the Compose panel makes.
//
// Every message is encrypted to the recipient's public key, broadcast to the
// Bitcoin SV mainnet and anchored on chain by the real wallet code.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(projectRoot, 'release-windows-2.1.15-check', 'win-unpacked', 'LBSX Desktop Wallet.exe');
const debugPort = 9494;
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

// Ten distinct, positive announcements. Each one is a real message - not a
// duplicate - so the mailbox shows a genuine trail of activity.
const MESSAGES = [
  {
    subject: 'Encrypted email is live — LBSX Desktop Wallet 2.1.15',
    body: `Hey Jordan —

This message is the proof. It was encrypted to your public key, broadcast on Bitcoin SV mainnet, and decrypted by your wallet alone. No server, no login, no cloud inbox.

LBSX Desktop Wallet now ships encrypted email, and it is the real thing: AES-256-GCM to your public key, anchored on chain, decrypted locally.

WHAT YOU CAN DO NOW

• Spam tab — file a sender's mail away from your inbox for good
• Pin — keep what matters at the top
• Trusted contacts — a verified mark that follows a name everywhere
• Delete — clear a message in one click
• Encrypted attachments — scanned before you save, never rendered in the app

Your keys never leave your device. Not once. Not for any of this.

— Captain`,
  },
  {
    subject: 'Your keys never leave your device — here is what that means',
    body: `Hey Jordan —

A quick one about the part that matters most.

Self-custody is not a badge. It means your seed phrase and private keys never leave your machine. Not for sending mail. Not for receiving mail. Not for syncing balances. Not for anything.

When you receive a message, it is decrypted locally, by your key, in your process. There is no backend that could be compelled to hand over a plaintext copy, because there is never a plaintext copy anywhere else.

When you send one, the encryption happens before the transaction is built. The bytes that hit the chain are ciphertext.

The honest caveat: the metadata is public. Who talked to whom, when, and roughly how much. Treat the timing and size of your mail as public. The contents are yours.

— Captain`,
  },
  {
    subject: 'Mail on a chain cannot be quietly edited',
    body: `Hey Jordan —

Here is one of the quieter wins of anchoring mail on Bitcoin SV.

Any message you receive was a transaction. That means it cannot be quietly rewritten after the fact. Nobody can edit what you read, because what you read is a hash in a block that thousands of nodes agree on.

Compare that to ordinary email, where the server in the middle can change a message before it reaches you and you would never know.

Not censorship. Not rewrites. Not a friendly server quietly editing the record.

Mail that says what it says, or it says nothing at all.

— Captain`,
  },
  {
    subject: 'New: mark a sender as spam once, forget them',
    body: `Hey Jordan —

Small feature, big quality of life.

Mark a sender as spam once and their mail files itself away from your inbox — every message they have already sent, and every one they send next. It is keyed on their public key, so it covers every address they control, not just the one they wrote from.

And when you are done with them, unmark it and every message they sent comes straight back to your inbox. Nothing is destroyed in the meantime. It is a filing decision, not a deletion.

— Captain`,
  },
  {
    subject: 'New: pin the messages you cannot afford to lose',
    body: `Hey Jordan —

New in 2.1.15: Pin.

Some mail you never want to scroll past — a contract, a key rotation, a decision that matters. Pin it and it stays at the top of your list, out of reach of the scroll, until you unpin it.

The pin is local to your wallet, so it is yours and nobody else's. It survives a sync, it survives a restart, and it never touches the chain.

— Captain`,
  },
  {
    subject: 'New: trust a contact once, see it everywhere',
    body: `Hey Jordan —

New in 2.1.15: Trusted contacts.

When you know who you are talking to, mark them trusted. A blue verified mark then sits beside their name in every list — inbox, sent, spam, and in the message header itself. One click, and you never have to wonder whether you are looking at the right person.

It is keyed on the public key, so the mark follows them to every address they control.

And to be precise about what it is: it is your own local vouch. Nothing is published, no third party can verify it, and it does not change the cryptography in any way. It is you saying, on your own device, "I have confirmed this is really them."

— Captain`,
  },
  {
    subject: 'New: delete a message without deleting the record',
    body: `Hey Jordan —

New in 2.1.15: Delete.

One click and a message leaves your mailbox. Your list gets cleaner, the thing you did not want to see is gone from view.

What it does not do is pretend the transaction never existed. It cannot. The mail is anchored on Bitcoin SV and that record is permanent, because pretending otherwise would be a lie dressed up as a feature.

So Delete is honest about what it is: a local cleanup of your mailbox. The record stays, and we would rather tell you that than let the button imply something it cannot deliver.

— Captain`,
  },
  {
    subject: 'New: pending mail now flips to confirmed on its own',
    body: `Hey Jordan —

A small correctness fix that makes a real difference.

Mail used to sit on PENDING until you happened to sync somewhere else. Now, when you hit Sync in the email tab, the wallet checks the chain for anything still pending and flips it to CONFIRMED the moment it is actually mined.

Status you can trust, without leaving the page you are on.

— Captain`,
  },
  {
    subject: 'New: encrypted attachments, scanned and never rendered',
    body: `Hey Jordan —

Attachments are back, and they are handled the careful way.

Attach an image or a document and it is encrypted on chain along with the message. When it arrives, the wallet decrypts it locally and checks it against VirusTotal — by hash first, so a file VirusTotal has already seen is reported without your file ever being uploaded anywhere.

And the rule that matters most: a received attachment is never rendered inside the wallet. No inline preview, no image surface, no auto-open. You get a scan and a save. A file a stranger sent you should never get a chance to execute in the app that holds your money.

— Captain`,
  },
  {
    subject: 'Try it — send a reply and watch it come back',
    body: `Hey Jordan —

The best way to understand this is to use it.

Hit Reply on this message. It will be encrypted back to me, broadcast on chain, and it will land in the inbox as a confirmed transaction.

Then try the new features on it: mark it as spam and watch it file itself away. Unmark it and watch it come straight back. Pin it. Trust the sender. Delete it.

All of it works the moment the mail arrives, on your machine, with your keys.

That is the whole idea. There is no account to create and nothing to trust but the code.

— Captain`,
  },
];

try {
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

  const contacts = await evaluate('window.lbsx.getMailContacts()');
  const contact = (contacts || []).find(row => row.address === RECIPIENT);
  if (!contact) throw new Error(`No contact for ${RECIPIENT}`);

  console.log(`sending ${MESSAGES.length} encrypted mails to ${RECIPIENT}`);
  console.log('recipient key:', contact.publicKeyHex.slice(0, 12) + '…');
  console.log('');

  let sent = 0;
  let failed = 0;
  for (const [index, message] of MESSAGES.entries()) {
    try {
      const result = await evaluate(`window.lbsx.sendMail(${JSON.stringify({
        recipient: RECIPIENT,
        recipientPublicKeyHex: contact.publicKeyHex,
        subject: message.subject,
        body: message.body,
      })})`);
      const txid = result?.txid || result?.hash || '(no txid in response)';
      sent += 1;
      console.log(`[${String(index + 1).padStart(2)}/${MESSAGES.length}] SENT  ${txid.slice(0, 16)}…  ${message.subject.slice(0, 52)}`);
    } catch (error) {
      failed += 1;
      console.log(`[${String(index + 1).padStart(2)}/${MESSAGES.length}] FAILED ${message.subject.slice(0, 52)} -> ${error.message}`);
    }
    // Space the broadcasts so the node accepts them cleanly.
    await delay(2500);
  }

  console.log('');
  console.log(`sent=${sent} failed=${failed}`);
} catch (error) {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch (_) {}
}
