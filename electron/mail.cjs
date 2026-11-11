// Encrypted mail for the LBSX Desktop Wallet.
//
// A mail message is an on-chain transaction carrying an encrypted payload in an
// OP_RETURN output. The payload is encrypted to the recipient's public key, so
// only the recipient can read it.
//
// On-chain format (8 pushes), matching the live 2.1.00 `bsv_send` shape:
//
//   ['LBSX', 'v2', 'mail', <sender>, <recipient>, <message id>, <timestamp>, <envelope>]
//
// The transaction pays two outputs:
//
//   1 sat     -> the recipient          discovery: makes the message findable in
//                                          the recipient's own address history
//   1000 sats -> the discovery address  service fee, matching Peer Chat
//
// The recipient discovers mail by scanning their own address history. Address
// history includes both sent and received transactions, so the sender also finds
// their own sent mail the same way.

const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { ADMIN_DISCOVERY_ADDRESS } = require('./constants.cjs');
const { broadcastTrackedTransaction } = require('./transaction-tracker.cjs');
const {
  encryptMailMessage,
  decryptMailMessage,
  buildMailAad,
  randomMessageId,
  addressFromPublicKeyBytes,
  parsePublicKeyHex,
  publicKeyBytes,
  startMailKeyExchange,
} = require('./mail-crypto.cjs');
const {
  resolvePublicKeyForAddress,
  publicKeyFromScriptSig: resolverPublicKeyFromScriptSig,
} = require('./public-key-resolver.cjs');
const {
  encryptAttachment,
  decryptAttachment,
  deriveRecipientKey,
  buildAttachmentScript,
  parseAttachmentOutput,
  findAttachmentOutputs,
  readPushes,
  buildAttachmentAad,
  sanitizeFilename,
  normalizeMimeType,
  validateAttachmentType,
  detectImageMimeType,
  canRenderInline,
  formatSize,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
} = require('./mail-attachments.cjs');
const {
  getWalletMailSnapshot,
  saveWalletMailSnapshot,
  getWalletMailContacts,
  saveWalletMailContacts,
  getWalletMailDrafts,
  saveWalletMailDraft,
  deleteWalletMailDraft,
  deleteMailMessage,
  markMailSenderSpam,
  unmarkMailSenderSpam,
  getWalletMailSpamKeys,
  setMailPinned,
  setMailContactTrusted,
  getWalletMailTrustedKeys,
} = require('./wallet-data.cjs');

const BB_API = 'https://bananablocks.com/api/v1';
const MAIL_SERVICE_FEE_SATS = 1000;
// Rough size estimates used to budget the miner fee before the transaction is
// built. The mail data output is small; the attachments dominate.
const MAIL_OUTPUT_ESTIMATE_BYTES = 1024;
const TX_OVERHEAD_ESTIMATE_BYTES = 512;
// The recipient anchor. 3 sats = 0.00000003 BSV. It is paid to the
// recipient's own address so the message appears in their address history,
// which is how a recipient discovers incoming mail.
const MAIL_ANCHOR_SATS = 3;
const TXID_RE = /^[0-9a-f]{64}$/i;
const MAX_CONTACTS = 200;

// ---------------------------------------------------------------------------
// OP_RETURN payload helpers
// ---------------------------------------------------------------------------

// Parses the pushes of an OP_RETURN script. Returns null when the script is not
// a data carrier or cannot be decoded.
function extractOpReturnFields(script) {
  const chunks = script?.chunks || [];
  const markerIndex = chunks.findIndex(chunk => chunk.opcodenum === 0x6a);
  if (markerIndex < 0) return null;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return chunks.slice(markerIndex + 1).map(chunk => {
      if (chunk.buf) return decoder.decode(Buffer.from(chunk.buf));
      if (chunk.opcodenum === 0) return '';
      return null;
    });
  } catch {
    return null;
  }
}

// Builds the 8-push mail payload.
function buildMailPayload({ sender, recipient, messageId, timestamp, envelope }) {
  if (!bsv.Address.isValid(sender, 'livenet')) throw new Error('The mail sender address is invalid.');
  if (!bsv.Address.isValid(recipient, 'livenet')) throw new Error('The mail recipient address is invalid.');
  if (!/^[0-9a-f]{64}$/i.test(String(messageId || ''))) throw new Error('The mail message id is invalid.');
  const stamp = new Date(timestamp || Date.now()).toISOString();
  const envelopeJson = JSON.stringify(envelope);
  return ['LBSX', 'v2', 'mail', sender, recipient, String(messageId).toLowerCase(), stamp, envelopeJson];
}

// Parses a mail payload from a transaction's OP_RETURN outputs. Returns null
// when the output is not a mail payload.
function parseMailPayload(fields) {
  if (!Array.isArray(fields) || fields.length !== 8) return null;
  if (fields[0] !== 'LBSX' || fields[1] !== 'v2' || fields[2] !== 'mail') return null;
  const sender = String(fields[3] || '');
  const recipient = String(fields[4] || '');
  const messageId = String(fields[5] || '').toLowerCase();
  const timestamp = Date.parse(fields[6]);
  if (!bsv.Address.isValid(sender, 'livenet') || !bsv.Address.isValid(recipient, 'livenet')) return null;
  if (!/^[0-9a-f]{64}$/.test(messageId)) return null;
  if (!Number.isFinite(timestamp)) return null;
  let envelope;
  try {
    envelope = JSON.parse(String(fields[7] || ''));
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object' || !envelope.e || !envelope.i || !envelope.t || !envelope.c) {
    return null;
  }
  return { sender, recipient, messageId, timestamp: new Date(timestamp).toISOString(), envelope };
}

// Finds the mail payload inside a transaction's outputs.
function extractMailFromTransaction(transaction) {
  for (const output of transaction?.outputs || []) {
    const fields = extractOpReturnFields(output.script);
    if (!fields) continue;
    const payload = parseMailPayload(fields);
    if (payload) return payload;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

// Validates a contact card. The public key must derive the claimed address,
// which is what makes the contact list self-authenticating rather than a
// trust-on-first-use blob.
function validateContact(contact = {}) {
  const address = String(contact.address || '').trim();
  const publicKeyHex = String(contact.publicKeyHex || '').trim().toLowerCase();
  const label = String(contact.label || '').trim();
  if (!bsv.Address.isValid(address, 'livenet')) throw new Error('That contact address is not a valid BSV mainnet address.');
  if (label.length > 60) throw new Error('A contact name must be 60 characters or less.');
  const publicKey = parsePublicKeyHex(publicKeyHex);
  if (addressFromPublicKeyBytes(publicKey) !== address) {
    throw new Error('That contact public key does not match the address.');
  }
  return { address, publicKeyHex, label };
}

// Builds the wallet's own contact card for sharing.
function buildOwnContactCard(address, publicKeyHex, label = '') {
  return { address, publicKeyHex: String(publicKeyHex || '').toLowerCase(), label: String(label || '').trim() };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

// Validates and normalises the attachment list supplied by the renderer.
// The renderer sends { fileName, mimeType, dataBase64 }; the bytes are
// decoded here, in the main process, and never touch the network in clear.
function normalizeAttachments(input) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) return [];
  if (list.length > MAX_ATTACHMENTS) {
    throw new Error(`You can attach at most ${MAX_ATTACHMENTS} files to one mail.`);
  }
  let total = 0;
  return list.map((item, index) => {
    const fileName = sanitizeFilename(item?.fileName);
    const mimeType = normalizeMimeType(item?.mimeType);
    let data;
    try {
      data = Buffer.from(String(item?.dataBase64 || ''), 'base64');
    } catch {
      throw new Error(`The attachment "${fileName}" could not be read.`);
    }
    if (!data.length) throw new Error(`The attachment "${fileName}" is empty.`);
    // The budget is on the WHOLE mail, so each file is checked against what
    // is left of it rather than against a separate per-file limit.
    if (data.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`"${fileName}" is larger than ${formatSize(MAX_ATTACHMENT_BYTES)}.`);
    }
    // An image's real type must match the type it claims, so a file cannot be
    // rendered as an image when it is not one.
    validateAttachmentType({ data, mimeType });
    total += data.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`The mail and its attachments together must stay under ${formatSize(MAX_TOTAL_ATTACHMENT_BYTES)}.`);
    }
    return { fileName, mimeType, data };
  });
}

// The RECIPIENT PAYMENT, in satoshis.
//
// It is dynamic. The default (3 sats) is a tiny anchor whose only job is to
// make the message appear in the recipient's address history so their wallet
// discovers it. A sender can pay MORE so the recipient holds enough BSV to
// answer - their own service fee, their network fee and the anchor for their
// own reply.
//
// It is capped so a mistake cannot drain the wallet, and floored at the
// anchor minimum so the message is always discoverable.
const MIN_ANCHOR_SATS = 3;
const MAX_ANCHOR_SATS = 10000000; // 0.1 BSV

function normalizeAnchorSats(value) {
  if (value === undefined || value === null || value === '') return MAIL_ANCHOR_SATS;
  const sats = Number(value);
  if (!Number.isFinite(sats) || !Number.isInteger(sats)) {
    throw new Error('The recipient payment must be a whole number of satoshis.');
  }
  if (sats < MIN_ANCHOR_SATS) {
    throw new Error(`The recipient payment must be at least ${MIN_ANCHOR_SATS} satoshis.`);
  }
  if (sats > MAX_ANCHOR_SATS) {
    throw new Error(`The recipient payment must be ${MAX_ANCHOR_SATS.toLocaleString()} satoshis or less.`);
  }
  return sats;
}

// Estimates what a mail will cost, in satoshis.
//
// The estimate is the same arithmetic the send path uses, so the number the
// user is shown is the number they are charged. It covers the recipient
// payment, the service fee and the network fee for the size of the message.
function estimateMailCost({ anchorSats, attachmentBytes = 0 } = {}) {
  const anchor = anchorSats === undefined || anchorSats === null
    ? MAIL_ANCHOR_SATS
    : Math.max(MIN_ANCHOR_SATS, Math.min(MAX_ANCHOR_SATS, Math.floor(Number(anchorSats) || 0)));
  const networkFeeSats = Math.ceil(
    (Number(attachmentBytes || 0) + MAIL_OUTPUT_ESTIMATE_BYTES + TX_OVERHEAD_ESTIMATE_BYTES) / 1000,
  ) + 1000;
  return {
    anchorSats: anchor,
    serviceFeeSats: MAIL_SERVICE_FEE_SATS,
    networkFeeSats,
    totalSats: anchor + MAIL_SERVICE_FEE_SATS + networkFeeSats,
  };
}

async function sendMail(privateKey, payload = {}) {
  const address = privateKey.toAddress().toString();
  const recipient = String(payload.recipient || '').trim();
  const recipientPublicKeyHex = String(payload.recipientPublicKeyHex || '').trim().toLowerCase();
  if (!bsv.Address.isValid(recipient, 'livenet')) throw new Error('Enter a valid BSV mainnet recipient address.');
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(recipientPublicKeyHex)) {
    throw new Error('The recipient public key is required to encrypt this mail.');
  }

  let recipientPublicKey;
  try {
    recipientPublicKey = parsePublicKeyHex(recipientPublicKeyHex);
  } catch (error) {
    throw new Error(error.message || 'The recipient public key could not be read.');
  }
  if (addressFromPublicKeyBytes(recipientPublicKey) !== recipient) {
    throw new Error('The recipient public key does not match the recipient address.');
  }

  // The RECIPIENT PAYMENT. It is dynamic: the default is a tiny anchor so the
  // message shows up in the recipient's address history, but the sender can
  // pay MORE so the recipient has BSV on hand to reply with - covering their
  // own service fee, network fee and the anchor for their own answer.
  const anchorSats = normalizeAnchorSats(payload.anchorSats);

  const subject = String(payload.subject || '').trim();
  const body = String(payload.body || '');
  const messageId = randomMessageId();
  const timestamp = new Date().toISOString();

  // The THREAD ROOT. A brand new mail starts its own thread, so its root is
  // its own message id. A reply carries the root of the thread it belongs to,
  // which is how both sides end up grouping the same conversation together.
  const requestedThreadRoot = String(payload.threadRootId || '').trim().toLowerCase();
  let threadRootId;
  if (requestedThreadRoot) {
    if (!/^[0-9a-f]{64}$/.test(requestedThreadRoot)) {
      throw new Error('The mail thread id is invalid.');
    }
    threadRootId = requestedThreadRoot;
  } else {
    threadRootId = messageId;
  }

  // Attachments share ONE key exchange with the mail body, so the recipient
  // derives a single shared secret for the whole message. Each attachment
  // still gets its own random IV and its own AAD.
  const attachments = normalizeAttachments(payload.attachments);
  const exchange = startMailKeyExchange({ recipientPublicKey });
  const { envelope, aad } = encryptMailMessage({
    recipientPublicKey,
    subject,
    body,
    sender: address,
    recipient,
    messageId,
    exchange,
    threadRootId,
  });
  const payloadPushes = buildMailPayload({ sender: address, recipient, messageId, timestamp, envelope });

  // Each attachment becomes its own data output carrying raw ciphertext.
  const attachmentOutputs = attachments.map(attachment => {
    const encrypted = encryptAttachment({
      key: exchange.key,
      data: attachment.data,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sender: address,
      recipient,
      messageId,
    });
    return {
      attachment: encrypted,
      script: buildAttachmentScript(encrypted, messageId),
    };
  });

  // The miner fee scales with the transaction size, and an attachment is
  // carried in the transaction itself. At feePerKb(1000) the fee is roughly
  // one satoshi per kilobyte, so the attachment bytes must be budgeted for
  // explicitly - otherwise a large attachment would be signed with too few
  // inputs and the send would fail.
  const attachmentBytes = attachmentOutputs.reduce(
    (sum, output) => sum + output.attachment.ciphertext.length,
    0,
  );
  // The cost estimate is the SAME arithmetic the transaction uses, so the
  // number shown in the compose window is the number actually charged.
  const cost = estimateMailCost({ anchorSats: anchorSats, attachmentBytes });
  const requiredSats = cost.totalSats;

  const { fetchCashInputs } = require('./token-wallet.cjs');
  const inputs = await fetchCashInputs(address, requiredSats);

  const tx = new bsv.Transaction().from(inputs)
    .to(recipient, anchorSats)
    .to(ADMIN_DISCOVERY_ADDRESS, MAIL_SERVICE_FEE_SATS)
    .addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildSafeDataOut(payloadPushes),
      satoshis: 0,
    }));
  for (const output of attachmentOutputs) {
    tx.addOutput(new bsv.Transaction.Output({ script: output.script, satoshis: 0 }));
  }
  // The output index of each attachment, as it will be on chain. The mail
  // output and the two payment outputs come first, so this cannot be assumed.
  const attachmentVouts = attachmentOutputs.map((_, index) => tx.outputs.length - attachmentOutputs.length + index);
  tx.change(address).feePerKb(1000).sign(privateKey);

  const txid = tx.id.toLowerCase();
  const rawHex = tx.toString();
  const feeSats = tx.getFee();

  await broadcastTrackedTransaction({
    address,
    txid,
    rawHex,
    type: 'mail-message',
    inputOutpoints: inputs.map(input => `${input.txid}.${input.vout}`),
    details: {
      title: 'Mail sent',
      recipient,
      subject,
      feeSats,
      serviceFeeSats: MAIL_SERVICE_FEE_SATS,
    },
    broadcast: () => broadcastRawHex(rawHex, txid),
  });

  await saveWalletMailSnapshot(address, {
    messages: [{
      txid,
      messageId,
      direction: 'sent',
      senderAddress: address,
      recipientAddress: recipient,
      recipientPublicKeyHex,
      attachmentCount: attachmentOutputs.length,
      attachmentRefs: attachmentOutputs.map((output, index) => ({
        name: output.attachment.fileName,
        mimeType: output.attachment.mimeType,
        byteLength: output.attachment.byteLength,
        vout: attachmentVouts[index],
      })),
      subject,
      body,
      timestamp,
      status: 'pending',
      blockHeight: 0,
      error: null,
      threadRootId,
    }],
    syncedAt: new Date().toISOString(),
  });

  return {
    txid,
    messageId,
    recipient,
    subject,
    timestamp,
    status: 'pending',
    feeSats,
    serviceFeeSats: MAIL_SERVICE_FEE_SATS,
    sizeBytes: rawHex.length / 2,
    threadRootId,
    // What the mail actually cost, so the UI can show the real breakdown.
    anchorSats: cost.anchorSats,
    networkFeeSats: cost.networkFeeSats,
    totalCostSats: cost.totalSats,
  };
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

// Recovers a public key from a P2PKH script_sig. A P2PKH input publishes the
// spender's compressed public key in the signature push, so anyone can read it
// from the chain. This is how a received message learns the key it must reply
// to: the key is taken from the input that FUNDED the mail, so it is bound to
// the same party that paid for it.
//
// The parsing is delegated to the shared resolver, which walks the pushes
// structurally. A local string-match on a fixed "2102" marker is WRONG: the
// key's push opcode depends on the length of the DER signature before it, and
// a key whose curve parity byte is 0x03 is missed entirely.
function publicKeyFromScriptSig(scriptSig) {
  return resolverPublicKeyFromScriptSig(scriptSig);
}

// Finds the public key of the input that funded the given address.
function senderPublicKeyFromInputs(inputs, senderAddress) {
  for (const input of Array.isArray(inputs) ? inputs : []) {
    const address = input?.address
      || (Array.isArray(input?.addresses) ? input.addresses[0] : null);
    if (String(address || '').toLowerCase() !== String(senderAddress || '').toLowerCase()) continue;
    const publicKeyHex = publicKeyFromScriptSig(input?.script_sig ?? input?.scriptSig);
    if (publicKeyHex) return publicKeyHex;
  }
  return '';
}

// Decrypts a received mail payload. Returns a message row; undecryptable
// payloads are kept as 'undecryptable' rather than dropped, so a user can see
// that something arrived even if it was not addressed to this wallet's key.
function decryptReceivedMail({ privateKey, payload, txid, blockHeight, status, senderPublicKeyHex, attachmentRefs }) {
  const aad = buildMailAad({
    sender: payload.sender,
    recipient: payload.recipient,
    messageId: payload.messageId,
  });
  const base = {
    txid,
    messageId: payload.messageId,
    direction: 'received',
    senderAddress: payload.sender,
    recipientAddress: payload.recipient,
    // The key needed to REPLY to this message - the sender's public key,
    // recovered from the input that funded the mail.
    senderPublicKeyHex: senderPublicKeyHex || '',
    subject: '',
    body: '',
    timestamp: payload.timestamp,
    status: status || 'confirmed',
    blockHeight: Number(blockHeight || 0),
    error: null,
    attachmentCount: (attachmentRefs || []).length,
    attachmentRefs: attachmentRefs || [],
    // The thread this message belongs to. Until the body is decrypted it is
    // unknown, so it falls back to the message's own id - which is exactly
    // what a first message of a thread would carry.
    threadRootId: payload.messageId,
  };
  try {
    const opened = decryptMailMessage({
      recipientPrivateKey: Buffer.isBuffer(privateKey)
        ? privateKey
        : privateKey.toBuffer(),
      envelope: payload.envelope,
      aad,
    });
    return {
      ...base,
      subject: opened.subject,
      body: opened.body,
      // The thread root travels inside the encrypted envelope, so the
      // recipient learns which conversation this message continues.
      threadRootId: opened.threadRootId || base.threadRootId,
    };
  } catch (error) {
    return { ...base, status: 'undecryptable', error: error.message };
  }
}

// Builds a mail message row from a transaction that carries a mail payload.
function mailMessageFromTransaction({ privateKey, txid, transaction, details, blockHeight }) {
  const payload = extractMailFromTransaction(transaction);
  if (!payload) return null;
  const inputAddresses = new Set((Array.isArray(details?.inputs) ? details.inputs : [])
    .flatMap(input => {
      const value = input?.address || input?.addresses;
      return Array.isArray(value) ? value : (value ? [value] : []);
    }));
  // The claimed sender must have funded the transaction. This binds the payload
  // to a real spender rather than to an arbitrary address string.
  if (!inputAddresses.has(payload.sender)) return null;

  // Discover any attachment outputs carried by the same transaction.
  const attachmentRefs = findAttachmentOutputs(details, payload.messageId).map(attachment => ({
    name: attachment.fileName,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    vout: attachment.vout,
  }));

  return decryptReceivedMail({
    privateKey,
    payload,
    txid,
    blockHeight: Number(blockHeight || details?.block_height || 0),
    status: Number(blockHeight || details?.block_height || 0) > 0 ? 'confirmed' : 'pending',
    senderPublicKeyHex: senderPublicKeyFromInputs(details?.inputs, payload.sender),
    attachmentRefs,
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

// Rebuilds the mailbox from the persisted activity records. The activity sync
// already fetches transaction details for every transaction in the wallet's own
// address history, and those details carry the OP_RETURN payload, so mail
// discovery reuses that work instead of repeating the API calls.
// Fetches one encrypted attachment from the chain and decrypts it.
//
// The bytes are fetched on demand rather than cached locally: the chain is the
// source of truth, and caching would grow the wallet-data file by the size of
// every attachment ever received.
async function fetchAndDecryptAttachment({
  privateKey,
  txid,
  vout,
  senderAddress,
  recipientAddress,
  messageId,
  fileName,
  mimeType,
  byteLength,
}) {
  if (!TXID_RE.test(String(txid || ''))) throw new Error('The attachment transaction id is invalid.');
  const { bananaBlocksFetch } = require('./bananablocks.cjs');
  const response = await bananaBlocksFetch(`${BB_API}/tx/${txid}`);
  if (!response.ok) throw new Error('The attachment could not be fetched from the chain.');
  const body = await response.json();
  const transaction = body?.result || body?.transaction || body;
  const outputs = Array.isArray(transaction?.outputs) ? transaction.outputs : [];
  // The chain API returns each output's script as a HEX STRING under
  // script_pubkey, so that field is preferred. A parsed script is also
  // accepted.
  const scriptOf = output => output?.script_pubkey ?? output?.scriptPubKey ?? output?.script;

  const output = outputs.find(row => Number(row?.index) === Number(vout)) || outputs[Number(vout)];
  if (!output || !scriptOf(output)) throw new Error('The attachment output is missing from that transaction.');

  const parsed = parseAttachmentOutput(scriptOf(output), messageId);
  if (!parsed) throw new Error('That output does not carry the expected attachment.');

  // The recipient derives the key from the ephemeral public key in the mail
  // envelope, so we need the envelope for this message.
  const mailPushes = outputs
    .map(row => readPushes(scriptOf(row)))
    .find(pushes => pushes && pushes.length === 8 && pushes[2].toString('utf8') === 'mail');
  if (!mailPushes) throw new Error('The mail envelope for this attachment is missing.');

  let envelope;
  try {
    envelope = JSON.parse(mailPushes[7].toString('utf8'));
  } catch {
    throw new Error('The mail envelope could not be read.');
  }

  const recipientPrivateKey = Buffer.isBuffer(privateKey) ? privateKey : privateKey.toBuffer();
  const key = deriveRecipientKey({
    recipientPrivateKeyBytes: recipientPrivateKey,
    ephemeralPublicKeyBytes: Buffer.from(envelope.e, 'base64'),
  });
  const aad = buildAttachmentAad({
    sender: senderAddress,
    recipient: recipientAddress,
    messageId,
    fileName,
    mimeType,
    byteLength,
  });
  const plaintext = decryptAttachment({ key, envelope: parsed, aad });

  // The RECEIVER determines the type from the decrypted bytes, never from the
  // type the sender claimed. The claim is only used for the AAD, which
  // authenticates it.
  //
  // A sender could otherwise label an SVG as a PNG and have it rendered
  // inline. An SVG can carry script, so the app renders only the raster
  // types it can verify from the bytes.
  const detectedImageType = detectImageMimeType(plaintext);
  const declaredType = normalizeMimeType(mimeType);
  let effectiveType = declaredType;
  if (detectedImageType) {
    effectiveType = detectedImageType;
  } else if (declaredType.startsWith('image/')) {
    // It claims to be an image but does not have an image signature. It is
    // not rendered inline, and the type is downgraded to binary.
    effectiveType = 'application/octet-stream';
  }
  const renderInline = canRenderInline(effectiveType);
  return {
    fileName: parsed.fileName,
    // The type the receiver determined from the bytes.
    mimeType: effectiveType,
    declaredMimeType: declaredType,
    detectedImageType,
    // Whether the app may render this inline. The renderer checks this, so a
    // sender cannot force an inline render of an unsafe type.
    renderInline,
    byteLength: parsed.byteLength,
    data: plaintext,
  };
}

// ---------------------------------------------------------------------------
// Pending status refresh
// ---------------------------------------------------------------------------

// The mail sync piggybacks on the wallet's ACTIVITY rows, which carry the
// confirmation state of every transaction the wallet touched. But an activity
// row is only refreshed when the ACTIVITY sync runs, so a mail that was
// pending when it was discovered keeps saying PENDING even after it has been
// mined.
//
// This checks the chain directly for the pending messages only, so the Email
// Sync button is honest on its own: a message that has been confirmed since
// the last sync flips to CONFIRMED.
//
// Only PENDING messages are checked. A confirmed message cannot un-confirm,
// and the whole point is to avoid re-fetching every transaction on every
// mail sync.
async function refreshPendingMailStatuses(messages) {
  const pending = messages.filter(message =>
    message?.status === 'pending' && TXID_RE.test(String(message.txid || '')));
  if (!pending.length) return { checked: 0, confirmed: 0 };

  // The SAME fetch the attachment path already uses in this module, so the
  // API key and the rate limiting behave identically.
  const { bananaBlocksFetch } = require('./bananablocks.cjs');
  let confirmed = 0;
  for (const message of pending) {
    try {
      const response = await bananaBlocksFetch(`${BB_API}/tx/${encodeURIComponent(message.txid)}`);
      if (!response.ok) continue;
      const body = await response.json();
      const transaction = body?.result || body?.transaction || body;
      const height = Number(transaction?.block_height ?? transaction?.blockHeight
        ?? transaction?.height ?? 0);
      if (!Number.isSafeInteger(height) || height <= 0) continue;
      message.status = 'confirmed';
      message.blockHeight = height;
      confirmed += 1;
    } catch {
      // A failed lookup must never break the sync - the message simply stays
      // pending until the next attempt.
    }
  }
  return { checked: pending.length, confirmed };
}

// ---------------------------------------------------------------------------
// Spam and deletion
// ---------------------------------------------------------------------------

// The spam flag is stored per SENDER PUBLIC KEY, not per message.
//
// The key is the identity: one key controls every address derived from it,
// so flagging the key catches that sender at all of its addresses. It also
// makes "unmark as spam" complete by construction - the messages were never
// destroyed or moved, they were only CLASSIFIED, so removing the flag puts
// every one of that sender's messages back where it belongs.
//
// A message is spam when its sender's recovered public key is flagged.
// Messages whose sender key could not be recovered are never spam.
function classifySpam(messages, spamKeys) {
  const flagged = new Set(spamKeys || []);
  for (const message of messages) {
    const key = String(message?.senderPublicKeyHex || '').trim().toLowerCase();
    message.isSpam = Boolean(key) && flagged.has(key);
  }
  return messages;
}

// Marks a sender's public key as spam and returns the updated mailbox.
async function markSenderAsSpam(address, { publicKeyHex, senderAddress, label } = {}) {
  const key = String(publicKeyHex || '').trim().toLowerCase();
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(key)) {
    throw new Error('The sender public key could not be read, so this sender cannot be marked as spam.');
  }
  await markMailSenderSpam(address, { publicKeyHex: key, senderAddress, label });
  return getMailbox(address);
}

// Removes a spam flag. Every message from that sender returns to the inbox.
async function unmarkSenderAsSpam(address, publicKeyHex) {
  const key = String(publicKeyHex || '').trim().toLowerCase();
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(key)) {
    throw new Error('The sender public key is invalid.');
  }
  await unmarkMailSenderSpam(address, key);
  return getMailbox(address);
}

// Deletes a message from the local mailbox record.
//
// The message remains on chain - that part is permanent. This only removes it
// from this wallet's mailbox so it stops showing up, and records the deletion
// so the next sync does not resurrect it.
async function deleteMessage(address, messageId) {
  await deleteMailMessage(address, messageId);
  return getMailbox(address);
}

// Pins or unpins a message.
//
// The pin is LOCAL: it keeps the message at the top of its list on this
// device. Nothing about the message changes on chain.
async function setMessagePinned(address, messageId, pinned = true) {
  await setMailPinned(address, messageId, pinned);
  return getMailbox(address);
}

// Marks or unmarks a contact as TRUSTED.
//
// The trust is the user's own local vouch for the contact. It is stored per
// public key, so it carries over to every address that key controls and to
// every mail row from that sender.
async function setContactTrusted(address, publicKeyHex, trusted = true) {
  await setMailContactTrusted(address, publicKeyHex, trusted);
  return getMailbox(address);
}

// Builds the mailbox view: the stored messages, classified into spam and
// non-spam, plus the spam-flagged senders, the deleted-message ids and the
// pinned-message ids.
async function getMailbox(address) {
  const snapshot = await getWalletMailSnapshot(address);
  const spamKeys = await getWalletMailSpamKeys(address);
  const trustedKeys = await getWalletMailTrustedKeys(address);
  const messages = classifySpam(snapshot.messages, spamKeys);
  return {
    messages,
    syncedAt: snapshot.syncedAt,
    spamSenders: snapshot.spamSenders || [],
    deletedMessageIds: snapshot.deletedMessageIds || [],
    pinnedMessageIds: snapshot.pinnedMessageIds || [],
    trustedKeys: [...trustedKeys],
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

// Saves an unsent mail as a draft.
//
// A draft is LOCAL ONLY. It is stored in the encrypted wallet data on this
// device and is never broadcast, so nothing about it reaches the chain and
// nobody else can read it.
async function saveDraft(address, draft = {}) {
  await saveWalletMailDraft(address, draft);
  return listDrafts(address);
}

// Lists the user's drafts.
async function listDrafts(address) {
  return { drafts: await getWalletMailDrafts(address) };
}

// Deletes a draft.
async function deleteDraft(address, draftId) {
  await deleteWalletMailDraft(address, draftId);
  return listDrafts(address);
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

// Groups messages into CONVERSATION THREADS.
//
// A thread is identified by its root message id - the id of the first message
// in the conversation. Every message in that conversation carries the same
// root, whether it was sent or received, so both sides of a conversation
// group the same messages together.
//
// Within a thread the messages are ordered OLDEST FIRST: the first message
// is where the conversation started and the newest is the latest response.
// The thread itself is placed in the list by its NEWEST message, so a thread
// with a fresh reply moves to the top.
function groupThreads(messages) {
  const byRoot = new Map();
  for (const message of messages) {
    const root = String(message?.threadRootId || message?.messageId || '').toLowerCase();
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(message);
  }
  const threads = [];
  for (const [root, rows] of byRoot) {
    // Oldest first: the conversation reads top to bottom.
    const ordered = rows.slice().sort((a, b) => {
      const timeDelta = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
      if (timeDelta !== 0) return timeDelta;
      // Two messages in the same millisecond still need a stable order.
      return String(a.messageId).localeCompare(String(b.messageId));
    });
    const latest = ordered[ordered.length - 1];
    const first = ordered[0];
    threads.push({
      threadRootId: root,
      messages: ordered,
      messageCount: ordered.length,
      // The thread is shown with the FIRST message's subject and sender, so
      // the list reads as a conversation rather than as a pile of replies.
      subject: first.subject,
      timestamp: latest.timestamp,
      latestTimestamp: latest.timestamp,
      direction: first.direction,
      senderAddress: first.senderAddress,
      recipientAddress: first.recipientAddress,
      // Any message in the thread that is unread makes the thread unread.
      unreadCount: ordered.filter(row => !row.readAt).length,
      // The thread is pinned if ANY of its messages is pinned.
      isPinned: ordered.some(row => row.pinned),
      isSpam: ordered.some(row => row.isSpam),
    });
  }
  // Newest thread first, matching the "newest first" sort of the message list.
  threads.sort((a, b) => String(b.latestTimestamp || '').localeCompare(String(a.latestTimestamp || '')));
  return threads;
}

// Decides whether a mail payload on this wallet's address history is
// actually a mail FOR this wallet.
//
// A mail transaction touches up to three addresses: the SENDER (who funds it),
// the RECIPIENT (who the mail is encrypted to, and who gets the small anchor
// payment), and the ADMIN WALLET (which is paid the service fee). Every one
// of those addresses sees the transaction in its own history.
//
// So the transaction being in this wallet's history proves NOTHING. The only
// thing that says "this mail is for you" is that the wallet IS the payload's
// recipient - that is the party the body was encrypted to.
//
// Without this check the admin wallet collects the service fee on every mail
// anyone sends, and then finds every one of those mails in its own inbox as
// "cannot decrypt", because the body was encrypted to somebody else.
//
// The transaction's own structure backs this up: the recipient anchor is
// output 0, the service fee to the admin wallet is output 1, and the mail
// payload is output 2. The recipient is the party the mail was addressed to.
function isMailForWallet(payload, walletAddress) {
  if (!payload || !walletAddress) return false;
  const recipient = String(payload.recipient || '').trim();
  if (!recipient) return false;
  // BSV addresses are base58 and are case-SENSITIVE on chain, but the same
  // address can arrive in a different case from different sources, so the
  // comparison is case-insensitive. It is still EXACT - an address that
  // merely starts with this one is a different wallet.
  return recipient.toLowerCase() === String(walletAddress).trim().toLowerCase();
}

async function syncMail(address, { privateKey } = {}) {
  if (!privateKey) throw new Error('The wallet must be unlocked to read mail.');
  const snapshot = await getWalletMailSnapshot(address);
  const messages = new Map();
  for (const message of snapshot.messages) messages.set(message.messageId, message);

  let discovered = 0;
  for (const activity of snapshot.activityRows || []) {
    const payload = activity?.details?.mailPayload;
    if (!payload) continue;
    // The transaction is in this wallet's history, but it is only a mail FOR
    // this wallet if this wallet is the recipient. A mail that merely paid
    // this address a fee is not this wallet's mail.
    if (!isMailForWallet(payload, address)) continue;
    const attachmentRefs = activity?.details?.mailAttachments || [];

    if (messages.has(payload.messageId)) {
      // The message is already stored. Its attachment refs may have been
      // discovered later than the message itself - the activity row is
      // refreshed from the chain when it carries a mail payload but no
      // attachment list, so a stored message can be missing attachments it
      // actually has. In that case the record must be re-decrypted.
      const stored = messages.get(payload.messageId);
      const storedRefs = stored?.attachmentRefs || [];
      const missingRefs = attachmentRefs.length > storedRefs.length;
      if (!missingRefs) continue;
      const refreshed = decryptReceivedMail({
        privateKey,
        payload,
        txid: activity.txid,
        blockHeight: activity.blockHeight,
        status: activity.blockHeight > 0 ? 'confirmed' : 'pending',
        senderPublicKeyHex: payload.senderPublicKeyHex,
        attachmentRefs,
      });
      // Keep the read state of the message that was already stored.
      messages.set(payload.messageId, { ...refreshed, readAt: stored.readAt || null });
      discovered += 1;
      continue;
    }

    const decrypted = decryptReceivedMail({
      privateKey,
      payload,
      txid: activity.txid,
      blockHeight: activity.blockHeight,
      status: activity.blockHeight > 0 ? 'confirmed' : 'pending',
      senderPublicKeyHex: payload.senderPublicKeyHex,
      attachmentRefs,
    });
    messages.set(payload.messageId, decrypted);
    discovered += 1;
  }

  // PURGE the mail that was wrongly discovered before this check existed.
  //
  // A wallet that was only PAID a fee for someone else's mail - the admin
  // wallet, for one - would have stored those messages as undecryptable
  // placeholders. They are not this wallet's mail, so they are removed here
  // rather than left cluttering the inbox forever.
  //
  // A SENT message is this wallet's own mail and is kept: it was addressed TO
  // the recipient, but it was sent BY this wallet. The sender check is what
  // distinguishes the two.
  let purged = 0;
  const removedMessageIds = [];
  for (const [messageId, message] of [...messages]) {
    const isOwnSentMail = message.direction === 'sent'
      && String(message.senderAddress || '').toLowerCase() === String(address).toLowerCase();
    if (isOwnSentMail) continue;
    if (isMailForWallet({ recipient: message.recipientAddress }, address)) continue;
    messages.delete(messageId);
    removedMessageIds.push(messageId);
    purged += 1;
  }

  // A stored message that was PENDING when it was discovered may have been
  // mined since. The activity rows are only refreshed by the ACTIVITY sync,
  // so the chain is checked directly for the pending messages - otherwise
  // the Email Sync button would leave them stuck on PENDING forever.
  const pendingStatus = await refreshPendingMailStatuses([...messages.values()]);

  // The mailbox is NOT capped. A mail history that quietly forgets what
  // was said is not a history, and the messages are merged by message id, so
  // the mailbox grows with the MAIL rather than with the number of syncs.
  const ordered = [...messages.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  await saveWalletMailSnapshot(address, {
    messages: ordered,
    removedMessageIds,
    syncedAt: new Date().toISOString(),
  });
  // The saved snapshot is the source of truth for the mailbox view, so the
  // spam classification is applied to it rather than to the pre-save set.
  const mailbox = await getMailbox(address);
  return { ...mailbox, discovered, purged, activityRows: undefined, ...pendingStatus };
}

// ---------------------------------------------------------------------------
// Contacts storage
// ---------------------------------------------------------------------------

async function listContacts(address) {
  return getWalletMailContacts(address);
}

// Saves a contact.
//
// The public key is DERIVED by the backend when the caller does not supply
// one. A P2PKH input publishes the spender's compressed public key, so an
// address that has ever spent reveals its key to anyone watching the chain.
// The user therefore only has to enter a name and an address.
//
// If the address has never spent, the key cannot be recovered and the caller
// must supply it.
async function saveContact(address, contact) {
  const suppliedKey = String(contact?.publicKeyHex || '').trim().toLowerCase();
  let publicKeyHex = suppliedKey;
  let derived = false;

  if (!publicKeyHex) {
    const resolved = await resolvePublicKeyForAddress(contact?.address);
    if (!resolved.publicKeyHex) {
      throw new Error(resolved.reason || 'The public key for that address could not be derived.');
    }
    publicKeyHex = resolved.publicKeyHex;
    derived = true;
  }

  const validated = validateContact({ ...contact, publicKeyHex });
  const existing = await getWalletMailContacts(address);
  const next = existing.filter(row => row.address !== validated.address);
  next.push(validated);
  next.sort((a, b) => a.label.localeCompare(b.label) || a.address.localeCompare(b.address));
  await saveWalletMailContacts(address, next.slice(0, MAX_CONTACTS));
  return { ...validated, derived };
}

async function removeContact(address, contactAddress) {
  const target = String(contactAddress || '').trim();
  const existing = await getWalletMailContacts(address);
  const next = existing.filter(row => row.address !== target);
  await saveWalletMailContacts(address, next);
  return next;
}

// ---------------------------------------------------------------------------
// Broadcast helper (mirrors token-wallet.cjs)
// ---------------------------------------------------------------------------

async function broadcastRawHex(rawHex, txid) {
  const { _market: { broadcastRawHex: broadcast } } = require('./token-wallet.cjs');
  return broadcast(rawHex, txid);
}

module.exports = {
  sendMail,
  syncMail,
  getMailbox,
  markSenderAsSpam,
  unmarkSenderAsSpam,
  deleteMessage,
  classifySpam,
  setMessagePinned,
  setContactTrusted,
  saveDraft,
  listDrafts,
  deleteDraft,
  groupThreads,
  isMailForWallet,
  estimateMailCost,
  normalizeAnchorSats,
  MIN_ANCHOR_SATS,
  MAX_ANCHOR_SATS,
  refreshPendingMailStatuses,
  fetchAndDecryptAttachment,
  normalizeAttachments,
  listContacts,
  saveContact,
  removeContact,
  validateContact,
  buildOwnContactCard,
  buildMailPayload,
  parseMailPayload,
  extractOpReturnFields,
  extractMailFromTransaction,
  decryptReceivedMail,
  MAIL_SERVICE_FEE_SATS,
  MAIL_ANCHOR_SATS,
  _test: { extractOpReturnFields, parseMailPayload, extractMailFromTransaction, validateContact },
};
