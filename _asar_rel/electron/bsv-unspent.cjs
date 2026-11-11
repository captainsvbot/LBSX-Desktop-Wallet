const { bananaBlocksFetch, waitForRateLimitBudget } = require('./bananablocks.cjs');

const BB_API = 'https://bananablocks.com/api/v1';
const UNSPENT_PAGE_SIZE = 500;
const MAX_RATE_LIMIT_RETRIES = 5;
const TXID_RE = /^[0-9a-f]{64}$/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// The BananaBlocks allowance is shared by every request this app makes. Wait
// for the current window to roll over rather than spending the attempt on a
// request that is guaranteed to be rejected.
async function fetchJsonWithBudget(url) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    await waitForRateLimitBudget();
    let response;
    try {
      response = await bananaBlocksFetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (attempt === MAX_RATE_LIMIT_RETRIES) throw error;
      await sleep(1000 * (2 ** attempt));
      continue;
    }
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      await response.text().catch(() => '');
      await sleep(1000 * (2 ** attempt));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`BananaBlocks returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
      error.status = response.status;
      if (response.status === 429) error.code = 'BANANABLOCKS_RATE_LIMIT';
      throw error;
    }
    try { return { body: JSON.parse(text), headers: response.headers }; }
    catch { throw new Error('BananaBlocks returned an unreadable response.'); }
  }
  throw new Error('BananaBlocks returned HTTP 429: rate limit exceeded');
}

// The unspent endpoint answers the first page as a bare array and every later
// page as an object that carries its own cursor. Both forms are folded into
// one row shape so callers never have to know which page they are looking at.
function normalizeUnspentRow(row) {
  if (!row || typeof row !== 'object') return null;
  const txid = String(row.tx_hash || row.txid || '').toLowerCase();
  const vout = Number(row.tx_pos ?? row.vout);
  const value = Number(row.value ?? row.satoshis);
  const height = Number(row.height ?? row.block_height ?? 0);
  if (!TXID_RE.test(txid) || !Number.isInteger(vout) || vout < 0) return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  if (!Number.isSafeInteger(height) || height < 0) return null;
  return {
    tx_hash: txid,
    tx_pos: vout,
    value,
    height,
    status: String(row.status || 'confirmed'),
    script_type: row.script_type ? String(row.script_type) : null,
    spent: row.spent === true,
    spent_txid: row.spent_txid ? String(row.spent_txid).toLowerCase() : null,
  };
}

function pageCursor(body, headers) {
  if (Array.isArray(body)) return headers?.get?.('x-next-cursor') || null;
  return body?.cursor || headers?.get?.('x-next-cursor') || null;
}

function pageHasMore(body, headers) {
  const header = String(headers?.get?.('x-has-more') || '').toLowerCase() === 'true';
  if (Array.isArray(body)) return header;
  if (body?.hasMore === true || String(body?.hasMore).toLowerCase() === 'true') return true;
  return header;
}

// Reads the whole unspent set for an address. There is no cap on how many
// outputs are returned: the scan follows the server cursor until the latest
// block has been covered.
async function fetchAllUnspentUtxos(address, { pageSize = UNSPENT_PAGE_SIZE, onProgress = null } = {}) {
  const encoded = encodeURIComponent(address);
  const rows = [];
  const seen = new Set();
  let cursor = null;
  let page = 0;
  for (;;) {
    const url = `${BB_API}/bsv/main/address/${encoded}/unspent?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { body, headers } = await fetchJsonWithBudget(url);
    const items = Array.isArray(body) ? body
      : (Array.isArray(body?.items) ? body.items
        : (Array.isArray(body?.result) ? body.result : null));
    if (!items) throw new Error('The BSV UTXO response had an unexpected format.');
    for (const item of items) {
      const row = normalizeUnspentRow(item);
      if (!row) continue;
      const key = `${row.tx_hash}.${row.tx_pos}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    page += 1;
    onProgress?.({ completed: page, count: rows.length });
    const nextCursor = pageCursor(body, headers);
    if (!items.length || !pageHasMore(body, headers) || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return rows;
}

module.exports = {
  fetchAllUnspentUtxos,
  fetchJsonWithBudget,
  normalizeUnspentRow,
  UNSPENT_PAGE_SIZE,
};
