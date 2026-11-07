const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const bsvModule = require('bsv');
const bsv = bsvModule.default || bsvModule;
const { getWalletDataEncryptionKey } = require('./vault.cjs');

const DATA_VERSION = 1;
const TXID_RE = /^[0-9a-f]{64}$/i;
const MAX_ADMIN_INDEX_TRANSACTIONS = 5000;
const MAX_ADMIN_INDEX_PENDING_TRANSACTIONS = 1000;
const MAX_ADMIN_INDEX_TX_BYTES = 4 * 1024 * 1024;
const UTXO_STORE_PAGE_SIZE = 20;
const writeQueues = new Map();

function addressHash(address) {
  if (!bsv.Address.isValid(address, 'livenet')) throw new Error('The active wallet address is invalid.');
  return crypto.createHash('sha256').update(address).digest('hex');
}

function dataPath(address) {
  return path.join(app.getPath('userData'), 'wallet-data', `${addressHash(address)}.enc`);
}

function emptyData(address) {
  return {
    version: DATA_VERSION,
    address,
    importedTokens: [],
    tokenLocks: [],
    activities: [],
    transactions: [],
    proofs: [],
    bsvUtxos: [],
    tokenUtxos: [],
    observedBsvUtxos: [],
    chainSnapshot: null,
    headerChain: null,
    lastActivitySyncAt: null,
    lastTransactionStatusCheckAt: null,
    lastUtxoSyncAt: null,
    historyBackfillComplete: false,
    historyCursor: null,
    historyPageCursor: 0,
    historyBackfillQueue: [],
    peerChatMessages: [],
    peerChatLastScannedTxid: null,
    peerChatSyncedAt: null,
    adminWalletTransactions: [],
    adminWalletPendingTransactions: [],
    adminWalletLastScannedTxid: null,
    adminWalletSyncedAt: null,
    adminWalletHistoryCursor: null,
    adminWalletHistoryComplete: false,
  };
}

function validateData(value, address) {
  if (!value || value.version !== DATA_VERSION || value.address !== address
    || !Array.isArray(value.importedTokens) || !Array.isArray(value.tokenLocks) || !Array.isArray(value.activities)
    || !Array.isArray(value.transactions) || !Array.isArray(value.bsvUtxos)
    || !Array.isArray(value.tokenUtxos) || !Array.isArray(value.observedBsvUtxos)) {
    throw new Error('The encrypted wallet data has an unsupported or inconsistent format.');
  }
  if (value.chainSnapshot === undefined) value.chainSnapshot = null;
  if (!Array.isArray(value.proofs)) value.proofs = [];
  if (value.headerChain === undefined) value.headerChain = null;
  if (value.lastTransactionStatusCheckAt === undefined) value.lastTransactionStatusCheckAt = null;
  if (value.lastTransactionStatusCheckAt !== null && !Number.isFinite(Date.parse(value.lastTransactionStatusCheckAt))) {
    throw new Error('The encrypted transaction status-check timestamp is invalid.');
  }
  if (value.peerChatMessages === undefined) value.peerChatMessages = [];
  if (!Array.isArray(value.peerChatMessages)) throw new Error('The encrypted peer chat cache is invalid.');
  if (value.peerChatLastScannedTxid === undefined) value.peerChatLastScannedTxid = null;
  if (value.peerChatLastScannedTxid !== null && !TXID_RE.test(String(value.peerChatLastScannedTxid))) {
    throw new Error('The encrypted peer chat scan pointer is invalid.');
  }
  if (value.peerChatSyncedAt === undefined) value.peerChatSyncedAt = null;
  if (value.peerChatSyncedAt !== null && !Number.isFinite(Date.parse(value.peerChatSyncedAt))) {
    throw new Error('The encrypted peer chat sync timestamp is invalid.');
  }
  if (value.adminWalletTransactions === undefined) value.adminWalletTransactions = [];
  if (!Array.isArray(value.adminWalletTransactions)) throw new Error('The encrypted admin-wallet index is invalid.');
  value.adminWalletTransactions = value.adminWalletTransactions.map(normalizeAdminWalletTransaction);
  if (value.adminWalletPendingTransactions === undefined) value.adminWalletPendingTransactions = [];
  if (!Array.isArray(value.adminWalletPendingTransactions)) throw new Error('The encrypted pending admin-wallet index is invalid.');
  value.adminWalletPendingTransactions = value.adminWalletPendingTransactions.map(normalizeAdminWalletTransaction);
  if (value.adminWalletLastScannedTxid === undefined) value.adminWalletLastScannedTxid = null;
  if (value.adminWalletLastScannedTxid !== null && !TXID_RE.test(String(value.adminWalletLastScannedTxid))) {
    throw new Error('The encrypted admin-wallet scan pointer is invalid.');
  }
  if (value.adminWalletSyncedAt === undefined) value.adminWalletSyncedAt = null;
  if (value.adminWalletSyncedAt !== null && !Number.isFinite(Date.parse(value.adminWalletSyncedAt))) {
    throw new Error('The encrypted admin-wallet sync timestamp is invalid.');
  }
  if (typeof value.adminWalletHistoryCursor !== 'string' || !value.adminWalletHistoryCursor
    || value.adminWalletHistoryCursor.length > 4096) value.adminWalletHistoryCursor = null;
  if (value.adminWalletHistoryComplete === undefined) value.adminWalletHistoryComplete = false;
  if (typeof value.adminWalletHistoryComplete !== 'boolean') {
    throw new Error('The encrypted admin-wallet history status is invalid.');
  }
  if (typeof value.historyCursor !== 'string' || !value.historyCursor || value.historyCursor.length > 4096) value.historyCursor = null;
  if (!Number.isSafeInteger(value.historyPageCursor) || value.historyPageCursor < 0) value.historyPageCursor = 0;
  return value;
}

async function readData(address) {
  const file = dataPath(address);
  let envelope;
  try {
    envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyData(address);
    if (error instanceof SyntaxError) throw new Error('The encrypted wallet data file is unreadable.');
    throw error;
  }
  if (envelope?.version !== DATA_VERSION || envelope.addressHash !== addressHash(address)
    || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string'
    || typeof envelope.ciphertext !== 'string') {
    throw new Error('The encrypted wallet data envelope is invalid.');
  }
  const key = getWalletDataEncryptionKey();
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return validateData(JSON.parse(plaintext), address);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The decrypted wallet data is unreadable.');
    throw new Error(`Could not decrypt local wallet data: ${error.message}`);
  } finally {
    key.fill(0);
  }
}

async function writeData(address, data) {
  const target = dataPath(address);
  const key = getWalletDataEncryptionKey();
  const iv = crypto.randomBytes(12);
  let envelope;
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(validateData(data, address)), 'utf8'),
      cipher.final(),
    ]);
    envelope = {
      version: DATA_VERSION,
      addressHash: addressHash(address),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    key.fill(0);
  }
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function getWalletData(address) {
  const file = dataPath(address);
  const queue = writeQueues.get(file);
  if (queue) await queue.catch(() => {});
  return readData(address);
}

async function deleteWalletData(address) {
  const file = dataPath(address);
  const queue = writeQueues.get(file);
  if (queue) await queue.catch(() => {});
  await fs.rm(file, { force: true });
  return { deleted: true };
}

async function updateWalletData(address, updater) {
  const file = dataPath(address);
  const previous = writeQueues.get(file) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const data = await readData(address);
    const result = await updater(data);
    await writeData(address, data);
    return result;
  });
  writeQueues.set(file, operation);
  try {
    return await operation;
  } finally {
    if (writeQueues.get(file) === operation) writeQueues.delete(file);
  }
}

function normalizeActivity(activity = {}) {
  const type = String(activity.type || 'wallet-activity');
  const txid = TXID_RE.test(String(activity.txid || '')) ? String(activity.txid).toLowerCase() : null;
  const id = txid || String(activity.id || '');
  if (!id || id.length > 256) throw new Error('The wallet activity record is invalid.');
  return {
    id,
    txid,
    type,
    title: String(activity.title || type.replace(/[-_]/g, ' ')).slice(0, 120),
    status: String(activity.status || 'local'),
    timestamp: String(activity.timestamp || new Date().toISOString()),
    amountSats: activity.amountSats != null && Number.isSafeInteger(Number(activity.amountSats)) ? Number(activity.amountSats) : null,
    recipient: String(activity.recipient || '').slice(0, 128) || null,
    tokenId: String(activity.tokenId || '').slice(0, 96) || null,
    tokenAmount: /^\d+$/.test(String(activity.tokenAmount || '')) ? String(activity.tokenAmount) : null,
    symbol: String(activity.symbol || '').slice(0, 32) || null,
    blockHeight: Number.isSafeInteger(Number(activity.blockHeight)) ? Number(activity.blockHeight) : 0,
    confirmations: Number.isSafeInteger(Number(activity.confirmations)) ? Number(activity.confirmations) : 0,
    details: activity.details && typeof activity.details === 'object' ? activity.details : {},
    source: activity.source === 'chain' ? 'chain' : 'local',
  };
}

function upsertActivity(data, activity) {
  const normalized = normalizeActivity(activity);
  const index = data.activities.findIndex(row => row.id === normalized.id
    || (normalized.txid && row.txid === normalized.txid));
  if (index < 0) data.activities.push(normalized);
  else data.activities[index] = { ...data.activities[index], ...normalized, details: { ...data.activities[index].details, ...normalized.details } };
}

function tokenFromScript(scriptHex, txid, vout) {
  try {
    const chunks = bsv.Script.fromHex(scriptHex).chunks;
    for (const chunk of chunks) {
      const text = chunk.buf?.toString('utf8');
      if (!text || !text.startsWith('{')) continue;
      let value;
      try { value = JSON.parse(text); } catch { continue; }
      const protocol = String(value.p || '').toLowerCase();
      const operation = String(value.op || '').toLowerCase();
      const tokenId = String(value.id || value.token_id || value.tokenId || '');
      const amount = String(value.amt ?? value.amount ?? '');
      if (!['bsv-20', 'bsv-21'].includes(protocol)
        || !['transfer', 'deploy+mint'].includes(operation)
        || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) continue;
      if (operation === 'deploy+mint') {
        if (!TXID_RE.test(String(txid || '')) || !Number.isInteger(Number(vout))) continue;
        return { tokenId: `${String(txid).toLowerCase()}_${Number(vout)}`, amount };
      }
      if (!/^[0-9a-f]{64}(?:_[0-9]+)?$/i.test(tokenId)) continue;
      return { tokenId: tokenId.includes('_') ? tokenId.toLowerCase() : `${tokenId.toLowerCase()}_1`, amount };
    }
  } catch {}
  return null;
}

function isTimelockedOutput(output) {
  return output?.script?.chunks?.some(chunk => chunk.opcodenum === 0xb1) === true;
}

function outpoint(txid, vout) {
  return `${String(txid).toLowerCase()}.${Number(vout)}`;
}

function normalizeOutpoint(value) {
  const match = String(value || '').match(/^([0-9a-f]{64})[._:]([0-9]+)$/i);
  if (!match) throw new Error('A wallet transaction contains an invalid input outpoint.');
  return outpoint(match[1], Number(match[2]));
}

function getInputOutpoints(tx, supplied) {
  if (Array.isArray(supplied)) return [...new Set(supplied.map(normalizeOutpoint))];
  return tx.inputs.map(input => outpoint(input.prevTxId.toString('hex'), input.outputIndex));
}

function transactionOutputs(rawHex, txid, address, status, excludedTokenVouts = []) {
  const tx = new bsv.Transaction(rawHex);
  const ownScript = bsv.Script.buildPublicKeyHashOut(address).toHex();
  const excluded = new Set(excludedTokenVouts.map(Number));
  const outputs = [];
  tx.outputs.forEach((output, vout) => {
    const scriptHex = output.script.toHex();
    const token = tokenFromScript(scriptHex, txid, vout);
    if (scriptHex === ownScript) {
      outputs.push({
        outpoint: outpoint(txid, vout), txid, vout, kind: 'bsv',
        satoshis: output.satoshis, scriptHex, rawTxHex: rawHex,
        state: status, verified: true, spvVerified: false, proofStatus: 'pending-local',
      });
    } else if (token && !excluded.has(vout) && !isTimelockedOutput(output) && scriptHex.endsWith(ownScript)) {
      outputs.push({
        outpoint: outpoint(txid, vout), txid, vout, kind: 'token',
        tokenId: token.tokenId, amount: token.amount,
        satoshis: output.satoshis, scriptHex, rawTxHex: rawHex,
        state: status, verified: true, spvVerified: false, proofStatus: 'pending-local',
      });
    }
  });
  return outputs;
}

function mergeUtxo(target, row) {
  const index = target.findIndex(item => item.outpoint === row.outpoint);
  if (index < 0) target.push(row);
  else {
    const current = target[index];
    const protectedState = ['spent', 'reserved', 'broadcasting', 'uncertain', 'orphaned'].includes(current.state);
    const recoveredProof = current.state === 'orphaned' && row.spvVerified === true;
    target[index] = { ...current, ...row, state: recoveredProof ? row.state : protectedState ? current.state : row.state };
  }
}

function utxoProofFields(row) {
  const blockHeight = Number(row.blockHeight);
  const blockHash = String(row.blockHash || '').toLowerCase();
  const verified = row.spvVerified === true && Number.isSafeInteger(blockHeight)
    && blockHeight >= 0 && TXID_RE.test(blockHash);
  return {
    spvVerified: verified,
    proofHeight: verified ? blockHeight : null,
    proofBlockHash: verified ? blockHash : null,
    proofStatus: verified ? 'verified' : 'required',
  };
}

function validateCachedOutput(row, satoshis = Number(row?.satoshis)) {
  const txid = String(row?.txid || '').toLowerCase();
  const vout = Number(row?.vout);
  const rawTxHex = String(row?.rawTxHex || '');
  const scriptHex = String(row?.scriptHex || '').toLowerCase();
  let transaction;
  try { transaction = new bsv.Transaction(rawTxHex); }
  catch { throw new Error('The cached wallet output contains invalid parent transaction bytes.'); }
  const output = transaction.outputs[vout];
  if (transaction.id.toLowerCase() !== txid || !output || output.satoshis !== satoshis
    || output.script.toHex().toLowerCase() !== scriptHex) {
    throw new Error('The cached wallet output does not match its parent transaction and outpoint.');
  }
}

async function saveImportedToken(address, token) {
  if (!token || !/^[0-9a-f]{64}_[0-9]+$/i.test(String(token.tokenId || ''))) throw new Error('Enter a valid BSV-21 token origin ID.');
  const tokenId = String(token.tokenId).toLowerCase();
  const rawIcon = String(token.icon || '').trim();
  const icon = /^_[0-9]+$/.test(rawIcon)
    ? `${tokenId.split('_')[0]}${rawIcon}`
    : /^[0-9a-f]{64}_[0-9]+$/i.test(rawIcon) ? rawIcon.toLowerCase() : null;
  const normalized = {
    tokenId,
    symbol: String(token.symbol || token.name || token.tokenId).slice(0, 32),
    name: String(token.name || token.symbol || token.tokenId).slice(0, 100),
    decimals: Number.isInteger(Number(token.decimals)) ? Math.min(18, Math.max(0, Number(token.decimals))) : 0,
    balance: /^\d+$/.test(String(token.balance || '')) ? String(token.balance) : '0',
    ...(icon ? { icon } : {}),
  };
  await updateWalletData(address, data => {
    const index = data.importedTokens.findIndex(row => row.tokenId === normalized.tokenId);
    if (index < 0) data.importedTokens.unshift(normalized);
    else data.importedTokens[index] = normalized;
    upsertActivity(data, {
      id: `import:${normalized.tokenId}`,
      type: 'token-import',
      title: `Imported ${normalized.symbol}`,
      status: 'saved locally',
      tokenId: normalized.tokenId,
      symbol: normalized.symbol,
      timestamp: new Date().toISOString(),
      source: 'local',
    });
  });
  return normalized;
}

async function getWalletTokenLocks(address) {
  return (await getWalletData(address)).tokenLocks;
}

async function saveWalletTokenLocks(address, rows) {
  if (!Array.isArray(rows)) throw new Error('The local token locker records must be a list.');
  return updateWalletData(address, data => { data.tokenLocks = rows; });
}

async function recordWalletActivity(address, activity) {
  return updateWalletData(address, data => {
    upsertActivity(data, activity);
    return data.activities.find(row => row.txid === String(activity.txid || '').toLowerCase()
      || row.id === String(activity.id || '')) || null;
  });
}

async function prepareWalletTransaction(address, { txid, rawHex, type, inputOutpoints: inputs, details = {}, excludeTokenVouts = [] }) {
  const id = String(txid || '').toLowerCase();
  if (!TXID_RE.test(id) || !/^(?:[0-9a-f]{2})+$/i.test(String(rawHex || ''))) {
    throw new Error('The transaction cannot be saved because its raw bytes or txid are invalid.');
  }
  const parsed = new bsv.Transaction(rawHex);
  if (parsed.id.toLowerCase() !== id) throw new Error('The transaction id does not match its serialized bytes.');
  const inputList = getInputOutpoints(parsed, inputs);
  const outputs = transactionOutputs(rawHex, id, address, 'broadcasting', excludeTokenVouts);
  const timestamp = new Date().toISOString();
  await updateWalletData(address, data => {
    const existing = data.transactions.find(row => row.txid === id);
    const trackedInputs = inputList.map(input => [...data.bsvUtxos, ...data.tokenUtxos].find(row => row.outpoint === input));
    const hasAllInputValues = inputList.length > 0 && trackedInputs.every(Boolean);
    const walletInputSats = hasAllInputValues
      ? trackedInputs.reduce((sum, row) => sum + BigInt(row.satoshis), 0n)
      : null;
    const changeSats = outputs.filter(row => row.kind === 'bsv')
      .reduce((sum, row) => sum + BigInt(row.satoshis), 0n);
    const trackedDetails = { ...(existing?.details || {}), ...details };
    if (walletInputSats !== null) {
      trackedDetails.walletInputSats = walletInputSats.toString();
      trackedDetails.changeSats = changeSats.toString();
      trackedDetails.walletNetSpentSats = (walletInputSats > changeSats ? walletInputSats - changeSats : 0n).toString();
      const hasOutputValues = parsed.outputs.every(output => Number.isSafeInteger(output.satoshis) && output.satoshis >= 0);
      const totalOutputSats = hasOutputValues
        ? parsed.outputs.reduce((sum, output) => sum + BigInt(output.satoshis), 0n)
        : null;
      if (trackedDetails.feeSats == null && totalOutputSats !== null && walletInputSats >= totalOutputSats) {
        trackedDetails.feeSats = (walletInputSats - totalOutputSats).toString();
      }
    }
    const inputStates = existing?.inputStates || Object.fromEntries(inputList.map(input => {
      const utxo = [...data.bsvUtxos, ...data.tokenUtxos].find(row => row.outpoint === input);
      return [input, utxo?.state || null];
    }));
    const transaction = {
      ...(existing || {}),
      txid: id,
      type: String(type || 'wallet-transaction'),
      status: 'broadcasting',
      timestamp,
      rawTxHex: rawHex,
      inputs: inputList,
      inputStates,
      outputOutpoints: outputs.map(row => row.outpoint),
      details: trackedDetails,
    };
    const index = data.transactions.findIndex(row => row.txid === id);
    if (index < 0) data.transactions.unshift(transaction);
    else data.transactions[index] = transaction;
    for (const row of outputs) {
      if (row.kind === 'bsv') mergeUtxo(data.bsvUtxos, row);
      else mergeUtxo(data.tokenUtxos, row);
    }
    for (const input of inputList) {
      const utxo = [...data.bsvUtxos, ...data.tokenUtxos].find(row => row.outpoint === input);
      if (utxo) utxo.state = 'reserved';
    }
    upsertActivity(data, {
      txid: id,
      type: transaction.type,
      title: transaction.details.title || transaction.type.replace(/[-_]/g, ' '),
      status: 'broadcasting',
      timestamp,
      amountSats: transaction.details.amountSats,
      recipient: transaction.details.recipient,
      tokenId: transaction.details.tokenId,
      tokenAmount: transaction.details.tokenAmount,
      symbol: transaction.details.symbol,
      details: transaction.details,
      source: 'local',
    });
  });
}

async function setWalletTransactionStatus(address, txid, status, errorMessage = null) {
  const id = String(txid || '').toLowerCase();
  const allowed = ['pending', 'confirmed', 'broadcast-uncertain', 'rejected'];
  if (!allowed.includes(status)) throw new Error('The local transaction status is invalid.');
  return updateWalletData(address, data => {
    const transaction = data.transactions.find(row => row.txid === id);
    if (!transaction) throw new Error('The local transaction record was not found.');
    transaction.status = status;
    transaction.updatedAt = new Date().toISOString();
    if (errorMessage) transaction.lastError = String(errorMessage).slice(0, 500);
    else delete transaction.lastError;
    const state = status === 'pending' ? 'pending'
      : status === 'confirmed' ? 'confirmed'
        : status === 'rejected' ? 'orphaned' : 'uncertain';
    for (const row of [...data.bsvUtxos, ...data.tokenUtxos]) {
      if (transaction.outputOutpoints.includes(row.outpoint)) {
        row.state = state;
        if (status === 'pending' && row.spvVerified !== true) row.proofStatus = 'local-pending';
        if (status === 'confirmed' && row.spvVerified !== true) row.proofStatus = 'required';
        if (status === 'rejected') {
          row.spvVerified = false;
          row.proofStatus = 'rejected';
        }
      }
      if (transaction.inputs.includes(row.outpoint)) {
        if (status === 'rejected') {
          const previousState = transaction.inputStates?.[row.outpoint];
          const parentTransaction = data.transactions.find(parent => parent.txid !== id && parent.outputOutpoints?.includes(row.outpoint));
          row.state = ['confirmed', 'pending'].includes(previousState)
            ? previousState
            : ['pending', 'broadcasting'].includes(parentTransaction?.status) ? 'pending' : 'confirmed';
        } else row.state = status === 'pending' || status === 'confirmed' ? 'spent' : 'reserved';
      }
    }
    upsertActivity(data, {
      txid: id,
      type: transaction.type,
      title: transaction.details?.title || transaction.type.replace(/[-_]/g, ' '),
      status: status === 'pending' ? 'unconfirmed' : status,
      timestamp: transaction.timestamp,
      amountSats: transaction.details?.amountSats,
      recipient: transaction.details?.recipient,
      tokenId: transaction.details?.tokenId,
      tokenAmount: transaction.details?.tokenAmount,
      symbol: transaction.details?.symbol,
      details: { ...transaction.details, ...(errorMessage ? { lastError: String(errorMessage).slice(0, 500) } : {}) },
      source: 'local',
    });
    return transaction;
  });
}

async function cacheVerifiedBsvUtxos(address, rows) {
  if (!Array.isArray(rows)) throw new Error('The verified BSV UTXO cache must be a list.');
  return updateWalletData(address, data => {
    for (const row of rows) {
      if (!TXID_RE.test(String(row.txid || '')) || !Number.isInteger(Number(row.vout))
        || !Number.isSafeInteger(Number(row.satoshis)) || Number(row.satoshis) < 1
        || !/^(?:[0-9a-f]{2})+$/i.test(String(row.scriptHex || ''))
        || !/^(?:[0-9a-f]{2})+$/i.test(String(row.rawTxHex || ''))) continue;
      validateCachedOutput(row, Number(row.satoshis));
      mergeUtxo(data.bsvUtxos, {
        outpoint: outpoint(row.txid, row.vout),
        txid: String(row.txid).toLowerCase(),
        vout: Number(row.vout),
        kind: 'bsv',
        satoshis: Number(row.satoshis),
        scriptHex: row.scriptHex,
        rawTxHex: row.rawTxHex,
        ...utxoProofFields(row),
        state: 'confirmed',
        verified: true,
      });
    }
  });
}

async function cacheVerifiedTokenUtxos(address, rows) {
  if (!Array.isArray(rows)) throw new Error('The verified BSV-21 UTXO cache must be a list.');
  const normalized = rows.map(row => {
    const satoshis = Number(row?.satoshis ?? 1);
    if (!row || !TXID_RE.test(String(row.txid || '')) || !Number.isInteger(Number(row.vout))
      || !/^[0-9a-f]{64}_[0-9]+$/i.test(String(row.tokenId || ''))
      || !/^\d+$/.test(String(row.amount || '')) || BigInt(row.amount) <= 0n
      || !Number.isSafeInteger(satoshis) || satoshis < 1
      || !/^(?:[0-9a-f]{2})+$/i.test(String(row.scriptHex || ''))
      || !/^(?:[0-9a-f]{2})+$/i.test(String(row.rawTxHex || ''))) {
      throw new Error('The verified BSV-21 UTXO record is invalid.');
    }
    validateCachedOutput(row, satoshis);
    return {
      outpoint: outpoint(row.txid, row.vout),
      txid: String(row.txid).toLowerCase(),
      vout: Number(row.vout),
      kind: 'token',
      tokenId: String(row.tokenId).toLowerCase(),
      amount: String(row.amount),
      satoshis,
      scriptHex: row.scriptHex,
      rawTxHex: row.rawTxHex,
      ...utxoProofFields(row),
      state: 'confirmed',
      verified: true,
    };
  });
  if (!normalized.length) return;
  return updateWalletData(address, data => {
    for (const row of normalized) mergeUtxo(data.tokenUtxos, row);
  });
}

async function cacheVerifiedTokenUtxo(address, row) {
  return cacheVerifiedTokenUtxos(address, [row]);
}

async function cacheObservedBsvUtxos(address, rows, { complete = false } = {}) {
  if (!Array.isArray(rows)) throw new Error('The observed BSV UTXO snapshot must be a list.');
  return updateWalletData(address, data => {
    const observed = rows.flatMap(row => {
      const txid = String(row?.tx_hash || row?.txid || '').toLowerCase();
      const vout = Number(row?.tx_pos ?? row?.vout);
      const satoshis = Number(row?.value ?? row?.satoshis);
      if (!TXID_RE.test(txid) || !Number.isInteger(vout) || !Number.isSafeInteger(satoshis) || satoshis < 1) return [];
      return [{
        outpoint: outpoint(txid, vout), txid, vout, satoshis,
        height: Number(row.height ?? row.block_height ?? 0),
        observedAt: new Date().toISOString(),
      }];
    });
    data.observedBsvUtxos = observed;
    if (complete) {
      const present = new Set(observed.map(row => row.outpoint));
      for (const row of data.bsvUtxos) {
        if (row.state === 'confirmed' && !present.has(row.outpoint)) {
          row.state = 'spent';
          row.proofStatus = 'spent';
        }
      }
    }
    data.lastUtxoSyncAt = new Date().toISOString();
  });
}

async function getSpendableBsvUtxos(address) {
  const data = await getWalletData(address);
  return data.bsvUtxos.filter(row => row.verified === true
    && ['confirmed', 'pending'].includes(row.state)
    && (row.state === 'pending' || row.spvVerified === true))
    .map(({ txid, vout, satoshis, scriptHex, rawTxHex, state, spvVerified, proofHeight, proofBlockHash }) => ({
      txid, vout, satoshis, scriptHex, rawTxHex, state, spvVerified, proofHeight, proofBlockHash,
    }));
}

async function getSpendableTokenUtxos(address, tokenId) {
  const data = await getWalletData(address);
  return data.tokenUtxos.filter(row => row.verified === true && row.tokenId === String(tokenId).toLowerCase()
    && ['confirmed', 'pending'].includes(row.state)
    && (row.state === 'pending' || row.spvVerified === true))
    .map(({ txid, vout, satoshis, scriptHex, rawTxHex, tokenId: id, amount, state, spvVerified, proofHeight, proofBlockHash }) => ({
      txid, vout, satoshis, scriptHex, rawTxHex, tokenId: id, amount, state, spvVerified, proofHeight, proofBlockHash,
    }));
}

function tokenSymbolMap(data) {
  const symbols = new Map();
  const add = (tokenId, symbol) => {
    const id = String(tokenId || '').toLowerCase();
    if (!id || symbols.has(id)) return;
    const label = String(symbol || '').trim();
    if (label) symbols.set(id, label);
  };
  for (const token of data.importedTokens || []) add(token?.tokenId, token?.symbol || token?.name);
  for (const token of data.chainSnapshot?.tokens || []) add(token?.tokenId, token?.symbol || token?.name);
  return symbols;
}

function isLockedScript(scriptHex) {
  const hex = String(scriptHex || '').toLowerCase();
  if (!hex.includes('b17576a914')) return false;
  return /b17576a914[0-9a-f]{40}88ac$/.test(hex);
}

async function getWalletUtxoStore(address, { query = '', page = 1, pageSize = UTXO_STORE_PAGE_SIZE } = {}) {
  const data = await getWalletData(address);
  const symbols = tokenSymbolMap(data);
  const rows = new Map();

  for (const row of data.observedBsvUtxos || []) {
    if (!row?.outpoint) continue;
    rows.set(row.outpoint, {
      txid: String(row.txid || '').toLowerCase(),
      vout: Number(row.vout),
      satoshis: Number(row.satoshis),
      height: Number.isSafeInteger(Number(row.height)) && Number(row.height) > 0 ? Number(row.height) : null,
      scriptHex: null,
      tokenId: null,
      state: 'observed',
      verified: false,
    });
  }
  for (const row of data.bsvUtxos || []) {
    if (!row?.outpoint) continue;
    const existing = rows.get(row.outpoint);
    rows.set(row.outpoint, {
      ...(existing || {}),
      txid: String(row.txid || existing?.txid || '').toLowerCase(),
      vout: Number(row.vout),
      satoshis: Number(row.satoshis),
      height: Number.isSafeInteger(Number(row.proofHeight)) && Number(row.proofHeight) > 0
        ? Number(row.proofHeight)
        : (existing?.height ?? null),
      scriptHex: row.scriptHex || existing?.scriptHex || null,
      tokenId: null,
      state: String(row.state || 'confirmed'),
      verified: row.verified === true,
    });
  }
  for (const row of data.tokenUtxos || []) {
    if (!row?.outpoint) continue;
    const existing = rows.get(row.outpoint);
    rows.set(row.outpoint, {
      ...(existing || {}),
      txid: String(row.txid || existing?.txid || '').toLowerCase(),
      vout: Number(row.vout),
      satoshis: Number(row.satoshis),
      height: Number.isSafeInteger(Number(row.proofHeight)) && Number(row.proofHeight) > 0
        ? Number(row.proofHeight)
        : (existing?.height ?? null),
      scriptHex: row.scriptHex || existing?.scriptHex || null,
      tokenId: String(row.tokenId || '').toLowerCase() || null,
      state: String(row.state || 'confirmed'),
      verified: row.verified === true,
    });
  }

  const list = [...rows.values()].filter(row => !['spent', 'orphaned'].includes(row.state)).map(row => {
    let type = 'unverified';
    let typeLabel = 'Unverified';
    if (row.tokenId) {
      type = 'token';
      typeLabel = symbols.get(row.tokenId) ? `Token ${symbols.get(row.tokenId)}` : 'Token';
    } else if (isLockedScript(row.scriptHex)) {
      type = 'locked';
      typeLabel = 'Locked';
    } else if (row.state === 'spent') {
      type = 'spent';
      typeLabel = 'Spent';
    } else if (row.verified === true && ['confirmed', 'pending'].includes(row.state)) {
      type = 'spendable';
      typeLabel = 'Spendable BSV';
    }
    return {
      txid: row.txid,
      vout: row.vout,
      satoshis: Number.isSafeInteger(row.satoshis) ? row.satoshis : 0,
      type,
      typeLabel,
      blockHeight: row.height,
    };
  });

  const needle = String(query || '').trim().toLowerCase();
  const filtered = needle
    ? list.filter(row => row.txid.includes(needle)
      || String(row.vout) === needle
      || row.typeLabel.toLowerCase().includes(needle)
      || (row.blockHeight != null && String(row.blockHeight) === needle))
    : list;

  filtered.sort((a, b) => {
    const heightA = a.blockHeight ?? -1;
    const heightB = b.blockHeight ?? -1;
    if (heightA !== heightB) return heightB - heightA;
    if (a.satoshis !== b.satoshis) return b.satoshis - a.satoshis;
    return a.vout - b.vout;
  });

  const size = Math.min(100, Math.max(1, Number(pageSize) || UTXO_STORE_PAGE_SIZE));
  const pageCount = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(pageCount, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  const counts = { spendable: 0, token: 0, locked: 0, spent: 0, unverified: 0 };
  for (const row of filtered) counts[row.type] = (counts[row.type] || 0) + 1;
  return {
    rows: filtered.slice(start, start + size),
    total: filtered.length,
    counts,
    page: current,
    pageSize: size,
    pageCount,
    lastSyncedAt: data.lastUtxoSyncAt || null,
  };
}

async function getWalletHeaderChain(address) {
  return (await getWalletData(address)).headerChain;
}

async function saveWalletHeaderChain(address, headerChain) {
  const normalized = {
    validationVersion: Number(headerChain?.validationVersion),
    tipHeight: Number(headerChain?.tipHeight),
    tipHash: String(headerChain?.tipHash || '').toLowerCase(),
    remoteTipHeight: Number(headerChain?.remoteTipHeight),
    staleRemoteTip: headerChain?.staleRemoteTip === true,
    chainWork: String(headerChain?.chainWork || ''),
    digest: String(headerChain?.digest || '').toLowerCase(),
  };
  if (!Number.isSafeInteger(normalized.validationVersion) || normalized.validationVersion < 1
    || !Number.isSafeInteger(normalized.tipHeight) || normalized.tipHeight < 0
    || !/^[0-9a-f]{64}$/.test(normalized.tipHash)
    || !Number.isSafeInteger(normalized.remoteTipHeight) || normalized.remoteTipHeight < 0
    || !/^\d+$/.test(normalized.chainWork)
    || !/^[0-9a-f]{64}$/.test(normalized.digest)) {
    throw new Error('The local SPV header-chain record is invalid.');
  }
  return updateWalletData(address, data => {
    data.headerChain = { ...normalized, validatedAt: new Date().toISOString() };
    return data.headerChain;
  });
}

async function getWalletTransactionProof(address, txid) {
  const id = String(txid || '').toLowerCase();
  return (await getWalletData(address)).proofs.find(row => row.txid === id && row.verified === true) || null;
}

async function saveWalletTransactionProof(address, proof) {
  const txid = String(proof?.txid || '').toLowerCase();
  const blockHeight = Number(proof?.blockHeight);
  const blockHash = String(proof?.blockHash || '').toLowerCase();
  const merkleRoot = String(proof?.merkleRoot || '').toLowerCase();
  const beefHex = String(proof?.beefHex || '').toLowerCase();
  if (!TXID_RE.test(txid) || !Number.isSafeInteger(blockHeight) || blockHeight < 0
    || !TXID_RE.test(blockHash) || !TXID_RE.test(merkleRoot)
    || !/^(?:[0-9a-f]{2})+$/i.test(beefHex) || beefHex.length > 32 * 1024 * 1024
    || proof?.verified !== true || Number(proof.validationVersion) !== 1) {
    throw new Error('The verified local BEEF proof record is invalid.');
  }
  const normalized = {
    txid, blockHeight, blockHash, merkleRoot, beefHex,
    verified: true, validationVersion: 1, verifiedAt: new Date().toISOString(),
  };
  return updateWalletData(address, data => {
    const index = data.proofs.findIndex(row => row.txid === txid);
    if (index < 0) data.proofs.unshift(normalized);
    else data.proofs[index] = normalized;
    for (const row of [...data.bsvUtxos, ...data.tokenUtxos]) {
      if (row.txid !== txid) continue;
      row.spvVerified = true;
      row.proofHeight = blockHeight;
      row.proofBlockHash = blockHash;
      row.proofStatus = 'verified';
      const source = data.transactions.find(transaction => transaction.txid === txid);
      if (row.state === 'orphaned' && source?.status !== 'rejected') row.state = 'confirmed';
    }
    return normalized;
  });
}

async function invalidateWalletProofs(address, txids) {
  if (!Array.isArray(txids)) throw new Error('Invalidated SPV transaction IDs must be a list.');
  const invalid = new Set(txids.map(txid => String(txid || '').toLowerCase()).filter(txid => TXID_RE.test(txid)));
  if (!invalid.size) return 0;
  return updateWalletData(address, data => {
    for (const proof of data.proofs) {
      if (!invalid.has(proof.txid)) continue;
      proof.verified = false;
      proof.invalidatedAt = new Date().toISOString();
    }
    for (const row of [...data.bsvUtxos, ...data.tokenUtxos]) {
      if (!invalid.has(row.txid)) continue;
      row.spvVerified = false;
      row.proofStatus = 'reorged';
      if (row.state === 'confirmed') row.state = 'orphaned';
    }
    return invalid.size;
  });
}

async function getTrackedTransactionHex(address, txid) {
  const data = await getWalletData(address);
  return data.transactions.find(row => row.txid === String(txid).toLowerCase())?.rawTxHex || null;
}

async function getWalletActivitySnapshot(address) {
  const data = await getWalletData(address);
  return {
    activities: data.activities.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))),
    importedTokens: data.importedTokens,
    chainSnapshot: data.chainSnapshot,
    headerChain: data.headerChain,
    syncedAt: data.lastActivitySyncAt,
    transactionStatusCheckedAt: data.lastTransactionStatusCheckAt,
    utxoSyncedAt: data.lastUtxoSyncAt,
    historyBackfillComplete: data.historyBackfillComplete === true,
    historyPageCursor: data.historyPageCursor || 0,
    remaining: data.historyBackfillQueue?.length || 0,
  };
}

async function setWalletTransactionStatusCheckedAt(address, timestamp = new Date().toISOString()) {
  const parsedTimestamp = new Date(timestamp);
  if (!Number.isFinite(parsedTimestamp.getTime())) throw new Error('The transaction status-check timestamp is invalid.');
  const normalizedTimestamp = parsedTimestamp.toISOString();
  return updateWalletData(address, data => {
    data.lastTransactionStatusCheckAt = normalizedTimestamp;
    return normalizedTimestamp;
  });
}

function normalizePeerChatMessage(message = {}) {
  const txid = String(message.txid || '').toLowerCase();
  const senderAddress = String(message.senderAddress || '');
  const content = String(message.content || '').trim();
  const parsedTimestamp = Date.parse(message.timestamp);
  if (!Number.isFinite(parsedTimestamp)) throw new Error('The local peer chat timestamp is invalid.');
  const timestamp = new Date(parsedTimestamp).toISOString();
  const blockHeight = Number(message.blockHeight || 0);
  if (!TXID_RE.test(txid) || !bsv.Address.isValid(senderAddress, 'livenet')
    || !content || content.length > 500 || Buffer.byteLength(content, 'utf8') > 2048
    || !['pending', 'confirmed'].includes(message.status)
    || !Number.isSafeInteger(blockHeight) || blockHeight < 0) {
    throw new Error('The local peer chat message is invalid.');
  }
  return { txid, senderAddress, content, isEncrypted: message.isEncrypted === true, timestamp, status: message.status, blockHeight };
}

function normalizeAdminWalletTransaction(record = {}) {
  const txid = String(record.txid || '').toLowerCase();
  const rawTxHex = typeof record.rawTxHex === 'string' && record.rawTxHex
    ? record.rawTxHex.toLowerCase()
    : null;
  const blockHeight = Number(record.blockHeight);
  const blockTime = Number(record.blockTime || 0);
  const confirmed = record.confirmed === true;
  if (!TXID_RE.test(txid) || (rawTxHex !== null && (!/^(?:[0-9a-f]{2})+$/i.test(rawTxHex)
    || rawTxHex.length > MAX_ADMIN_INDEX_TX_BYTES * 2))
    || !Number.isSafeInteger(blockHeight) || (confirmed ? blockHeight < 1 : blockHeight !== 0)
    || !Number.isSafeInteger(blockTime) || blockTime < 0) {
    throw new Error('The encrypted admin-wallet transaction record is invalid.');
  }
  const details = record.details && typeof record.details === 'object' ? record.details : {};
  const inputs = Array.isArray(details.inputs) ? details.inputs.slice(0, 2000).map(input => ({
    address: typeof input?.address === 'string' ? input.address.slice(0, 128) : '',
  })) : [];
  const outputs = Array.isArray(details.outputs) ? details.outputs.slice(0, 2000).map(output => {
    const index = Number(output?.index ?? output?.vout);
    const value = String(output?.value ?? output?.satoshis ?? '0');
    const parsedBsv21 = output?.parsed?.bsv21 ?? output?.bsv21;
    const bsv21 = parsedBsv21 && typeof parsedBsv21 === 'object' ? {
      valid: parsedBsv21.valid === true,
      op: String(parsedBsv21.op || '').slice(0, 32),
      id: String(parsedBsv21.id ?? parsedBsv21.token_id ?? parsedBsv21.tokenId ?? '').slice(0, 100),
      amt: String(parsedBsv21.amt ?? parsedBsv21.amount ?? '').slice(0, 80),
      sym: String(parsedBsv21.sym ?? parsedBsv21.symbol ?? '').slice(0, 32),
      dec: String(parsedBsv21.dec ?? parsedBsv21.decimals ?? '').slice(0, 2),
    } : null;
    return {
      index: Number.isSafeInteger(index) && index >= 0 ? index : -1,
      address: typeof output?.address === 'string' ? output.address.slice(0, 128) : '',
      value: /^\d+$/.test(value) ? value : '0',
      spent: output?.spent === true,
      ...(bsv21 ? { parsed: { bsv21 } } : {}),
    };
  }) : [];
  return {
    txid,
    blockHeight,
    blockTime,
    rawTxHex,
    confirmed,
    details: {
      txid,
      block_height: blockHeight,
      block_time: blockTime,
      confirmed,
      inputs,
      outputs,
    },
  };
}

async function getWalletPeerChatSnapshot(address) {
  const data = await getWalletData(address);
  return {
    messages: data.peerChatMessages.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    lastScannedTxid: data.peerChatLastScannedTxid,
    syncedAt: data.peerChatSyncedAt,
  };
}

async function saveWalletPeerChatSnapshot(address, snapshot = {}) {
  if (snapshot.messages !== undefined && !Array.isArray(snapshot.messages)) {
    throw new Error('The local peer chat message list is invalid.');
  }
  const messages = (snapshot.messages || []).map(normalizePeerChatMessage);
  let lastScannedTxid;
  if (snapshot.lastScannedTxid !== undefined) {
    lastScannedTxid = snapshot.lastScannedTxid == null ? null : String(snapshot.lastScannedTxid).toLowerCase();
    if (lastScannedTxid !== null && !TXID_RE.test(lastScannedTxid)) {
      throw new Error('The local peer chat scan pointer is invalid.');
    }
  }
  let syncedAt;
  if (snapshot.syncedAt !== undefined) {
    syncedAt = new Date(snapshot.syncedAt).toISOString();
  }
  return updateWalletData(address, data => {
    const byTxid = new Map(data.peerChatMessages.map(row => {
      const normalized = normalizePeerChatMessage(row);
      return [normalized.txid, normalized];
    }));
    for (const message of messages) {
      const previous = byTxid.get(message.txid);
      byTxid.set(message.txid, previous?.status === 'confirmed' && message.status === 'pending'
        ? previous
        : { ...previous, ...message });
    }
    data.peerChatMessages = [...byTxid.values()]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-500);
    if (snapshot.lastScannedTxid !== undefined) data.peerChatLastScannedTxid = lastScannedTxid;
    if (snapshot.syncedAt !== undefined) data.peerChatSyncedAt = syncedAt;
    return {
      messages: data.peerChatMessages.slice(),
      lastScannedTxid: data.peerChatLastScannedTxid,
      syncedAt: data.peerChatSyncedAt,
    };
  });
}

async function getWalletAdminIndexSnapshot(address) {
  const data = await getWalletData(address);
  return {
    transactions: data.adminWalletTransactions.slice(),
    pendingTransactions: data.adminWalletPendingTransactions.slice(),
    lastScannedTxid: data.adminWalletLastScannedTxid,
    syncedAt: data.adminWalletSyncedAt,
    historyCursor: data.adminWalletHistoryCursor,
    historyComplete: data.adminWalletHistoryComplete,
  };
}

async function saveWalletAdminIndexSnapshot(address, snapshot = {}) {
  if (snapshot.transactions !== undefined && !Array.isArray(snapshot.transactions)) {
    throw new Error('The local admin-wallet transaction list is invalid.');
  }
  const transactions = (snapshot.transactions || []).map(normalizeAdminWalletTransaction);
  if (transactions.some(row => !row.confirmed || row.blockHeight < 1)) {
    throw new Error('The local confirmed admin-wallet transaction list is invalid.');
  }
  if (snapshot.pendingTransactions !== undefined && !Array.isArray(snapshot.pendingTransactions)) {
    throw new Error('The local pending admin-wallet transaction list is invalid.');
  }
  const pendingTransactions = (snapshot.pendingTransactions || []).map(normalizeAdminWalletTransaction);
  if (pendingTransactions.some(row => row.confirmed || row.blockHeight !== 0)) {
    throw new Error('The local pending admin-wallet transaction list is invalid.');
  }
  let lastScannedTxid;
  if (snapshot.lastScannedTxid !== undefined) {
    lastScannedTxid = snapshot.lastScannedTxid == null ? null : String(snapshot.lastScannedTxid).toLowerCase();
    if (lastScannedTxid !== null && !TXID_RE.test(lastScannedTxid)) {
      throw new Error('The local admin-wallet scan pointer is invalid.');
    }
  }
  let syncedAt;
  if (snapshot.syncedAt !== undefined) {
    const parsed = Date.parse(snapshot.syncedAt);
    if (!Number.isFinite(parsed)) throw new Error('The local admin-wallet sync timestamp is invalid.');
    syncedAt = new Date(parsed).toISOString();
  }
  let historyCursor;
  if (snapshot.historyCursor !== undefined) {
    if (snapshot.historyCursor === null) historyCursor = null;
    else if (typeof snapshot.historyCursor === 'string' && snapshot.historyCursor.length <= 4096) {
      historyCursor = snapshot.historyCursor || null;
    } else throw new Error('The local admin-wallet history cursor is invalid.');
  }
  if (snapshot.historyComplete !== undefined && typeof snapshot.historyComplete !== 'boolean') {
    throw new Error('The local admin-wallet history status is invalid.');
  }
  return updateWalletData(address, data => {
    const byTxid = new Map(data.adminWalletTransactions.map(row => {
      const normalized = normalizeAdminWalletTransaction(row);
      return [normalized.txid, normalized];
    }));
    for (const transaction of transactions) byTxid.set(transaction.txid, transaction);
    data.adminWalletTransactions = [...byTxid.values()]
      .sort((a, b) => b.blockHeight - a.blockHeight || b.blockTime - a.blockTime)
      .slice(0, MAX_ADMIN_INDEX_TRANSACTIONS);
    if (snapshot.pendingTransactions !== undefined) {
      const confirmedTxids = new Set(data.adminWalletTransactions.map(row => row.txid));
      const pendingByTxid = new Map();
      for (const transaction of pendingTransactions) {
        if (!confirmedTxids.has(transaction.txid)) pendingByTxid.set(transaction.txid, transaction);
      }
      data.adminWalletPendingTransactions = [...pendingByTxid.values()]
        .slice(0, MAX_ADMIN_INDEX_PENDING_TRANSACTIONS);
    } else {
      const confirmedTxids = new Set(transactions.map(row => row.txid));
      data.adminWalletPendingTransactions = data.adminWalletPendingTransactions
        .filter(row => !confirmedTxids.has(row.txid));
    }
    if (snapshot.lastScannedTxid !== undefined) data.adminWalletLastScannedTxid = lastScannedTxid;
    if (snapshot.syncedAt !== undefined) data.adminWalletSyncedAt = syncedAt;
    if (snapshot.historyCursor !== undefined) data.adminWalletHistoryCursor = historyCursor;
    if (snapshot.historyComplete !== undefined) data.adminWalletHistoryComplete = snapshot.historyComplete;
    return {
      transactions: data.adminWalletTransactions.slice(),
      pendingTransactions: data.adminWalletPendingTransactions.slice(),
      lastScannedTxid: data.adminWalletLastScannedTxid,
      syncedAt: data.adminWalletSyncedAt,
      historyCursor: data.adminWalletHistoryCursor,
      historyComplete: data.adminWalletHistoryComplete,
    };
  });
}

function normalizeChainSnapshot(address, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.address !== address) {
    throw new Error('The local chain snapshot does not match the active wallet.');
  }
  const balance = snapshot.balance == null ? null : {
    confirmed: String(snapshot.balance.confirmed ?? ''),
    unconfirmed: String(snapshot.balance.unconfirmed ?? ''),
    ...(snapshot.balance.spendableBsvSats != null ? { spendableBsvSats: String(snapshot.balance.spendableBsvSats) } : {}),
    ...(snapshot.balance.pendingLocalBsvSats != null ? { pendingLocalBsvSats: String(snapshot.balance.pendingLocalBsvSats) } : {}),
  };
  if (balance && (!/^\d+$/.test(balance.confirmed) || !/^\d+$/.test(balance.unconfirmed)
    || (balance.spendableBsvSats != null && !/^\d+$/.test(balance.spendableBsvSats))
    || (balance.pendingLocalBsvSats != null && !/^\d+$/.test(balance.pendingLocalBsvSats)))) {
    throw new Error('The local BSV balance snapshot is invalid.');
  }
  const tokens = Array.isArray(snapshot.tokens) ? snapshot.tokens.flatMap(token => {
    const tokenId = String(token?.tokenId || '');
    const amount = String(token?.balance ?? '0');
    if (!/^[0-9a-f]{64}(?:_[0-9]+)?$/i.test(tokenId) || !/^\d+$/.test(amount)) return [];
    const decimals = Number(token.decimals ?? 0);
    return [{
      tokenId: tokenId.toLowerCase(),
      symbol: String(token.symbol || token.name || tokenId).slice(0, 32),
      name: String(token.name || token.symbol || tokenId).slice(0, 100),
      decimals: Number.isInteger(decimals) ? Math.min(18, Math.max(0, decimals)) : 0,
      balance: amount,
      ...(typeof token.icon === 'string' && /^[0-9a-f]{64}_[0-9]+$/i.test(token.icon) ? { icon: token.icon.toLowerCase() } : {}),
      ...(token.locallyMinted === true ? { locallyMinted: true } : {}),
    }];
  }) : [];
  const errors = {};
  for (const key of ['bsv', 'tokens', 'utxos', 'activity']) errors[key] = snapshot.errors?.[key] ? String(snapshot.errors[key]).slice(0, 500) : null;
  return {
    address,
    balance,
    tokens,
    errors,
    utxoCount: snapshot.utxoCount != null && Number.isSafeInteger(Number(snapshot.utxoCount)) && Number(snapshot.utxoCount) >= 0
      ? Number(snapshot.utxoCount) : null,
    syncedAt: String(snapshot.syncedAt || new Date().toISOString()),
    balanceSyncedAt: snapshot.balanceSyncedAt ? String(snapshot.balanceSyncedAt) : null,
    tokensSyncedAt: snapshot.tokensSyncedAt ? String(snapshot.tokensSyncedAt) : null,
    utxoSyncedAt: snapshot.utxoSyncedAt ? String(snapshot.utxoSyncedAt) : null,
    source: String(snapshot.source || 'Local wallet cache').slice(0, 64),
  };
}

async function saveWalletChainSnapshot(address, snapshot) {
  const normalized = normalizeChainSnapshot(address, snapshot);
  return updateWalletData(address, data => {
    const tokens = new Map(normalized.tokens
      .filter(token => !token.locallyMinted || snapshot.errors?.tokens)
      .map(token => [token.tokenId, token]));
    for (const transaction of data.transactions) {
      const details = transaction.details || {};
      const tokenId = String(details.tokenId || '').toLowerCase();
      if (transaction.type !== 'token-mint' || !['broadcasting', 'pending', 'broadcast-uncertain'].includes(transaction.status)
        || !/^[0-9a-f]{64}_[0-9]+$/.test(tokenId) || tokens.has(tokenId)) continue;
      tokens.set(tokenId, {
        tokenId,
        symbol: String(details.symbol || tokenId).slice(0, 32),
        name: String(details.symbol || tokenId).slice(0, 100),
        decimals: Number.isInteger(Number(details.decimals)) ? Math.min(18, Math.max(0, Number(details.decimals))) : 0,
        balance: /^\d+$/.test(String(details.tokenAmount || '')) ? String(details.tokenAmount) : '0',
        ...(typeof details.icon === 'string' && /^[0-9a-f]{64}_[0-9]+$/i.test(details.icon) ? { icon: details.icon.toLowerCase() } : {}),
        locallyMinted: true,
      });
    }
    data.chainSnapshot = { ...normalized, tokens: [...tokens.values()] };
    return data.chainSnapshot;
  });
}

async function recordMintedToken(address, token) {
  const walletData = await getWalletData(address);
  const prior = walletData.chainSnapshot || {};
  const spendableBsvUtxos = walletData.bsvUtxos.filter(row => row.verified === true
    && (row.state === 'pending' || row.state === 'confirmed' && row.spvVerified === true));
  const spendableBsvSats = spendableBsvUtxos.reduce((sum, row) => sum + BigInt(row.satoshis), 0n);
  const pendingLocalBsvSats = spendableBsvUtxos.filter(row => row.state === 'pending')
    .reduce((sum, row) => sum + BigInt(row.satoshis), 0n);
  const normalized = normalizeChainSnapshot(address, {
    ...prior,
    address,
    balance: prior.balance ? {
      ...prior.balance,
      spendableBsvSats: String(spendableBsvSats),
      pendingLocalBsvSats: String(pendingLocalBsvSats),
    } : null,
    tokens: [
      { tokenId: token.tokenId, symbol: token.symbol, name: token.name, decimals: token.decimals, balance: token.balance, icon: token.icon, locallyMinted: true },
      ...(prior.tokens || []).filter(row => row.tokenId !== token.tokenId),
    ],
  });
  await updateWalletData(address, data => { data.chainSnapshot = normalized; });
  return normalized;
}

async function mergeChainActivity(address, activities, syncedAt, {
  remaining = 0,
  errors = [],
  historyBackfillComplete = false,
  historyCursor = null,
  historyPageCursor = 0,
  historyBackfillQueue = [],
  updateHistorySyncState = true,
} = {}) {
  if (!Array.isArray(activities)) throw new Error('The synchronized activity records must be a list.');
  return updateWalletData(address, data => {
    for (const activity of activities) upsertActivity(data, { ...activity, source: 'chain' });
    if (updateHistorySyncState) {
      data.lastActivitySyncAt = syncedAt;
      data.historyBackfillComplete = historyBackfillComplete;
      data.historyCursor = typeof historyCursor === 'string' && historyCursor ? historyCursor : null;
      data.historyPageCursor = historyPageCursor;
      data.historyBackfillQueue = historyBackfillQueue;
    }
    const known = new Set(activities.map(item => String(item.txid || '').toLowerCase()));
    for (const transaction of data.transactions) {
      if (known.has(transaction.txid)) {
        const record = activities.find(item => String(item.txid || '').toLowerCase() === transaction.txid);
        if (record?.blockHeight > 0) {
          transaction.status = 'confirmed';
          for (const row of [...data.bsvUtxos, ...data.tokenUtxos]) {
            if (transaction.outputOutpoints.includes(row.outpoint)) {
              row.state = 'confirmed';
              if (row.spvVerified !== true) row.proofStatus = 'required';
            }
            if (transaction.inputs.includes(row.outpoint)) row.state = 'spent';
          }
        } else if (transaction.status === 'broadcasting') {
          transaction.status = 'pending';
        }
      }
    }
    return {
      activities: data.activities.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))),
      importedTokens: data.importedTokens,
      chainSnapshot: data.chainSnapshot,
      syncedAt: data.lastActivitySyncAt,
      transactionStatusCheckedAt: data.lastTransactionStatusCheckAt,
      utxoSyncedAt: data.lastUtxoSyncAt,
      historyBackfillComplete: data.historyBackfillComplete === true,
      historyPageCursor: data.historyPageCursor || 0,
      remaining: data.historyBackfillQueue?.length || remaining,
      remaining,
      errors,
    };
  });
}

async function getSpendableUtxoBlocklist(address) {
  const data = await getWalletData(address);
  return new Set(data.transactions
    .filter(row => ['broadcasting', 'pending', 'confirmed', 'broadcast-uncertain'].includes(row.status))
    .flatMap(row => row.inputs || []));
}

module.exports = {
  getWalletData,
  deleteWalletData,
  saveImportedToken,
  getWalletTokenLocks,
  saveWalletTokenLocks,
  recordWalletActivity,
  prepareWalletTransaction,
  setWalletTransactionStatus,
  cacheVerifiedBsvUtxos,
  cacheVerifiedTokenUtxos,
  cacheVerifiedTokenUtxo,
  cacheObservedBsvUtxos,
  getSpendableBsvUtxos,
  getSpendableTokenUtxos,
  getWalletUtxoStore,
  getSpendableUtxoBlocklist,
  getWalletHeaderChain,
  saveWalletHeaderChain,
  getWalletTransactionProof,
  saveWalletTransactionProof,
  invalidateWalletProofs,
  getTrackedTransactionHex,
  getWalletActivitySnapshot,
  setWalletTransactionStatusCheckedAt,
  getWalletPeerChatSnapshot,
  saveWalletPeerChatSnapshot,
  getWalletAdminIndexSnapshot,
  saveWalletAdminIndexSnapshot,
  saveWalletChainSnapshot,
  recordMintedToken,
  mergeChainActivity,
  _test: { tokenFromScript, transactionOutputs, normalizeActivity, isTimelockedOutput },
};
