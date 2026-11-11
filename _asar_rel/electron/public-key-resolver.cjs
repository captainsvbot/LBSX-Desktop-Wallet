// Derives a BSV address's public key from the chain.
//
// A P2PKH input publishes the spender's compressed public key in its
// signature push, so any transaction the address has SPENT reveals its
// public key to anyone watching the chain. This is what lets the wallet
// create a contact from an address alone - the user never has to copy a
// public key by hand.
//
// The recovered key is VERIFIED against the address before it is returned:
// hash160(compressed key) must equal the address's hash160. A key that does
// not match is rejected, so a wrong key can never be stored.
//
// If the address has never spent, there is no public key to recover and the
// user must still supply it.
//
// The HTTP transport is injected so this module can be exercised outside
// Electron (the wallet's bananablocks module depends on Electron's `app`).

const bsvModule = require('bsv');

const bsv = bsvModule.default || bsvModule;

const BB_API = 'https://bananablocks.com/api/v1';
const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGES = 8;
const MAX_DETAIL_LOOKUPS = 120;

// The injected transport. It must resolve to { body, nextCursor }.
// `nextCursor` comes from the response's x-next-cursor header.
let transport = null;

function setTransport(fn) {
  transport = typeof fn === 'function' ? fn : null;
}

// Reads the compressed public key out of a P2PKH script_sig.
//
// The unlocking script is: <signature> <compressed public key>. The public
// key is pushed with a DIRECT push of 33 bytes, which is opcode 0x21 (33),
// but the signature before it is a DER signature of variable length, so the
// key's push opcode is NOT always 0x21 - it depends on how long the
// signature is.
//
// The script is therefore parsed STRUCTURALLY: walk the pushes and take the
// LAST 33-byte push, which is the public key. String-matching a fixed
// "2102" marker is wrong and misses keys whenever the signature length
// shifts the byte alignment.
function publicKeyFromScriptSig(scriptSig) {
  const hex = String(scriptSig || '').trim().toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return '';
  const bytes = Buffer.from(hex, 'hex');

  let offset = 0;
  const pushes = [];
  while (offset < bytes.length) {
    const opcode = bytes[offset];
    offset += 1;
    let length = null;
    if (opcode <= 0x4b) {
      length = opcode;
    } else if (opcode === 0x4c) {
      if (offset + 1 > bytes.length) break;
      length = bytes[offset];
      offset += 1;
    } else if (opcode === 0x4d) {
      if (offset + 2 > bytes.length) break;
      length = bytes.readUInt16LE(offset);
      offset += 2;
    } else if (opcode === 0x4e) {
      if (offset + 4 > bytes.length) break;
      length = bytes.readUInt32LE(offset);
      offset += 4;
    } else {
      // Not a push opcode - skip it.
      continue;
    }
    if (length === null || offset + length > bytes.length) break;
    pushes.push(bytes.subarray(offset, offset + length));
    offset += length;
  }

  // The public key is the last 33-byte push.
  for (let index = pushes.length - 1; index >= 0; index -= 1) {
    const push = pushes[index];
    if (push.length !== 33) continue;
    if (push[0] !== 0x02 && push[0] !== 0x03) continue;
    return push.toString('hex');
  }
  return '';
}

// hash160 over the COMPRESSED SEC1 bytes, which is what P2PKH commits to.
// Using bsv.PublicKey.fromBuffer here would misinterpret raw SEC1 data as
// DER and can produce a different address.
function addressFromPublicKeyBytes(publicKeyBytes) {
  const hash = bsv.crypto.Hash.sha256ripemd160(publicKeyBytes);
  return bsv.Address.fromPublicKeyHash(hash, 'livenet').toString();
}

// Confirms a recovered key really belongs to the address.
function publicKeyMatchesAddress(publicKeyHex, address) {
  try {
    const bytes = Buffer.from(String(publicKeyHex || '').trim(), 'hex');
    if (bytes.length !== 33) return false;
    if (bytes[0] !== 0x02 && bytes[0] !== 0x03) return false;
    return addressFromPublicKeyBytes(bytes) === String(address || '').trim();
  } catch {
    return false;
  }
}

// The default transport uses the wallet's own rate-limited fetch.
async function defaultTransport(url) {
  const { bananaBlocksFetch, waitForRateLimitBudget } = require('./bananablocks.cjs');
  await waitForRateLimitBudget();
  const response = await bananaBlocksFetch(url);
  if (!response.ok) throw new Error(`The chain lookup failed (HTTP ${response.status}).`);
  return {
    body: await response.json(),
    nextCursor: response.headers?.get('x-next-cursor') || null,
  };
}

async function request(url) {
  const result = transport ? await transport(url) : await defaultTransport(url);
  return {
    body: result?.body ?? result,
    nextCursor: result?.nextCursor || null,
  };
}

function rowsOf(body) {
  if (Array.isArray(body)) return body;
  return body?.history || body?.transactions || body?.unspent || null;
}

// Recovers the public key for an address by walking its spent transactions.
//
// The history endpoint paginates with a CURSOR, not a page number: the
// response carries an `x-next-cursor` header and the next request takes
// `&cursor=<value>`. Using a page number silently returns the same rows, so
// the walk would never reach the older spends that reveal the key.
//
// Returns { publicKeyHex } on success, or { publicKeyHex: '', reason } when
// the address has never spent and the key cannot be recovered.
async function resolvePublicKeyForAddress(address) {
  const target = String(address || '').trim();
  if (!bsv.Address.isValid(target, 'livenet')) {
    throw new Error('Enter a valid BSV mainnet address.');
  }

  const seen = new Set();
  let cursor = null;
  let detailLookups = 0;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const base = `${BB_API}/bsv/main/address/${encodeURIComponent(target)}/history?limit=${HISTORY_PAGE_SIZE}`;
    const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
    let response;
    try {
      response = await request(url);
    } catch (error) {
      if (!seen.size) throw error;
      break;
    }
    const rows = rowsOf(response.body);
    if (!Array.isArray(rows) || !rows.length) break;

    let added = 0;
    for (const row of rows) {
      const txid = String(row?.tx_hash || row?.txid || row?.hash || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) continue;
      if (seen.has(txid)) continue;
      seen.add(txid);
      added += 1;

      if (detailLookups >= MAX_DETAIL_LOOKUPS) continue;
      detailLookups += 1;
      let detail;
      try {
        detail = (await request(`${BB_API}/tx/${txid}`)).body;
      } catch {
        continue;
      }
      const tx = detail?.result || detail?.transaction || detail;
      const inputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
      for (const input of inputs) {
        const inputAddress = input?.address
          || (Array.isArray(input?.addresses) ? input.addresses[0] : null);
        if (String(inputAddress || '').trim() !== target) continue;
        const publicKeyHex = publicKeyFromScriptSig(input?.script_sig ?? input?.scriptSig);
        if (!publicKeyHex) continue;
        // VERIFY before returning. A key that does not derive the address is
        // not that address's key.
        if (!publicKeyMatchesAddress(publicKeyHex, target)) continue;
        return { publicKeyHex, verified: true, txid };
      }
    }

    cursor = response.nextCursor;
    if (!cursor) break;
    if (!added) break;
  }

  return {
    publicKeyHex: '',
    verified: false,
    reason: 'That address has never spent on-chain, so it has no published public key yet. '
      + 'Ask for a small payment first, or enter the key manually.',
  };
}

module.exports = {
  resolvePublicKeyForAddress,
  setTransport,
  publicKeyFromScriptSig,
  publicKeyMatchesAddress,
  addressFromPublicKeyBytes,
  _test: { publicKeyFromScriptSig, publicKeyMatchesAddress, addressFromPublicKeyBytes, rowsOf },
};
