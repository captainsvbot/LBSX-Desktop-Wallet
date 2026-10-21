const API = 'https://bananablocks.com/api/v1';

async function verifyTransactionProof(_address, txid, expectedHeight = 0) {
  const response = await globalThis.fetch(`${API}/bsv/main/tx/${txid}/hex`, {
    headers: { Accept: 'text/plain' },
  });
  if (!response.ok) throw new Error(`Could not fetch test transaction ${txid}.`);
  return {
    txid: String(txid).toLowerCase(),
    blockHeight: expectedHeight || 900001,
    blockHash: '12'.repeat(32),
    merkleRoot: '34'.repeat(32),
    rawTxHex: (await response.text()).trim(),
    verified: true,
    validationVersion: 1,
  };
}

module.exports = {
  ensureHeaderChain: async () => ({ tipHeight: 1000000 }),
  verifyTransactionProof,
  reportProgress: () => {},
};
