const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { ADMIN_DISCOVERY_ADDRESS } = require('./constants.cjs');
const { getAdminWalletIndex, syncAdminWalletIndex } = require('./admin-wallet-index.cjs');
const { getWalletPeerChatSnapshot, saveWalletPeerChatSnapshot } = require('./wallet-data.cjs');
const { decryptPeerChatContent } = require('./peer-chat-crypto.cjs');

const MAX_MESSAGES = 150;
const ADMIN_FEE_SATS = 1000;
const TXID_RE = /^[0-9a-f]{64}$/i;

function addressValues(value) {
  if (Array.isArray(value)) return value.flatMap(addressValues);
  return typeof value === 'string' && value ? [value] : [];
}

function satoshis(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function hasIndexedAdminFee(tx) {
  return (Array.isArray(tx?.outputs) ? tx.outputs : []).some(output =>
    addressValues(output.address || output.addresses).includes(ADMIN_DISCOVERY_ADDRESS)
      && satoshis(output.value ?? output.satoshis) >= ADMIN_FEE_SATS,
  );
}

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

function parsePeerChatTransaction(txid, rawTxHex, details, indexedHeight = 0) {
  const id = String(txid || '').toLowerCase();
  if (!TXID_RE.test(id) || !/^(?:[0-9a-f]{2})+$/i.test(String(rawTxHex || ''))) return null;
  let transaction;
  try { transaction = new bsv.Transaction(rawTxHex); } catch { return null; }
  if (transaction.id.toLowerCase() !== id) return null;
  const adminScript = bsv.Script.buildPublicKeyHashOut(ADMIN_DISCOVERY_ADDRESS).toHex();
  if (!transaction.outputs.some(output => output.satoshis >= ADMIN_FEE_SATS
    && output.script.toHex() === adminScript)) return null;

  const inputAddresses = new Set((Array.isArray(details?.inputs) ? details.inputs : [])
    .flatMap(input => addressValues(input.address || input.addresses)));
  const blockHeight = Number(details?.block_height ?? details?.height ?? indexedHeight ?? 0);
  if (!Number.isSafeInteger(blockHeight) || blockHeight < 1) return null;

  for (const output of transaction.outputs) {
    const fields = extractOpReturnFields(output.script);
    if (!fields || fields.length !== 6
      || fields[0] !== 'LBSX' || !['v1', 'v2'].includes(fields[1]) || fields[2] !== 'peer_chat') continue;
    const senderAddress = fields[3];
    const payloadTimestamp = Date.parse(fields[4]);
    let content;
    try {
      content = fields[1] === 'v2' ? decryptPeerChatContent(fields[5]) : fields[5];
    } catch {
      continue;
    }
    if (!bsv.Address.isValid(senderAddress, 'livenet') || !inputAddresses.has(senderAddress)
      || !Number.isFinite(payloadTimestamp) || !content.trim()
      || content.length > 500 || Buffer.byteLength(content, 'utf8') > 2048) continue;
    const blockTime = Number(details?.block_time || 0);
    return {
      txid: id,
      senderAddress,
      content,
      isEncrypted: fields[1] === 'v2',
      timestamp: blockTime > 0 ? new Date(blockTime * 1000).toISOString() : new Date(payloadTimestamp).toISOString(),
      status: 'confirmed',
      blockHeight,
    };
  }
  return null;
}

async function syncPeerChat(address) {
  const index = await syncAdminWalletIndex(address);
  const prior = await getWalletPeerChatSnapshot(address);
  const messages = [];
  for (const transaction of index.transactions) {
    const message = parsePeerChatTransaction(
      transaction.txid,
      transaction.rawTxHex,
      transaction.details,
      transaction.blockHeight,
    );
    if (message) messages.push(message);
  }
  const saved = await saveWalletPeerChatSnapshot(address, {
    messages: messages.slice(-MAX_MESSAGES),
    lastScannedTxid: index.lastScannedTxid,
    syncedAt: index.syncedAt || prior.syncedAt || new Date().toISOString(),
  });
  return {
    ...saved,
    address: ADMIN_DISCOVERY_ADDRESS,
    source: index.source,
    historyComplete: index.historyComplete,
    scannedTransactions: index.scannedTransactions,
    lookupFailures: index.lookupFailures,
    errors: index.errors,
  };
}

async function getPeerChatSnapshot(address) {
  const [snapshot, index] = await Promise.all([
    getWalletPeerChatSnapshot(address),
    getAdminWalletIndex(address),
  ]);
  return {
    ...snapshot,
    address: ADMIN_DISCOVERY_ADDRESS,
    source: index.syncedAt ? 'Encrypted local cache' : 'Not synced',
    historyComplete: index.historyComplete,
    scannedTransactions: 0,
    lookupFailures: 0,
    errors: [],
  };
}

module.exports = {
  syncPeerChat,
  getPeerChatSnapshot,
  _test: { extractOpReturnFields, hasIndexedAdminFee, parsePeerChatTransaction },
};
