// Fetches the recipient's compressed public key from a transaction that spends
// from their P2PKH address. The public key is published in the script_sig.
const https = require('node:https');
const fs = require('node:fs');
const { publicKeyFromScriptSig: parsePublicKeyFromScriptSig } = require('../electron/public-key-resolver.cjs');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const address = process.argv[2];
  if (!address) throw new Error('Pass the recipient address.');
  const history = await get(`https://bananablocks.com/api/v1/bsv/main/address/${address}/history?limit=5`);
  if (history.status !== 200) throw new Error(`history HTTP ${history.status}`);
  const rows = JSON.parse(history.body);
  for (const row of rows) {
    await sleep(2200);
    const detail = await get(`https://bananablocks.com/api/v1/tx/${row.tx_hash}`);
    if (detail.status !== 200) continue;
    const body = JSON.parse(detail.body);
    const tx = body.result || body.transaction || body;
    for (const input of tx.inputs || []) {
      const inputAddress = input.address || (Array.isArray(input.addresses) ? input.addresses[0] : null);
      if (inputAddress !== address) continue;
      const scriptSig = input.script_sig || '';
      // script_sig is: <signature push> <33-byte public key push>. The push
      // opcode depends on the DER signature length, so the key is parsed
      // structurally by the shared resolver rather than string-matched.
      const publicKeyHex = parsePublicKeyFromScriptSig(scriptSig);
      if (!publicKeyHex) continue;
      console.log('txid:', row.tx_hash);
      console.log('publicKeyHex:', publicKeyHex);
      fs.writeFileSync(`${__dirname}/../.recipient-pubkey.txt`, publicKeyHex);
      return;
    }
  }
  throw new Error('No public key found in the recent history of that address.');
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
