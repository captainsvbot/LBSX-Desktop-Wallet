function buildBananaBlocksUrl(reference) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    throw new Error('A BananaBlocks reference is required.');
  }
  const { kind, value } = reference;
  if (kind === 'txid' && typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) {
    return `https://bananablocks.com/tx/${value}`;
  }
  if (kind === 'token' && typeof value === 'string' && /^[a-f0-9]{64}_[0-9]+$/i.test(value)) {
    return `https://bananablocks.com/token/${value}`;
  }
  if (kind === 'outpoint' && typeof value === 'string' && /^([a-f0-9]{64})\.(0|[1-9][0-9]*)$/i.test(value)) {
    return `https://bananablocks.com/tx/${value.slice(0, 64)}`;
  }
  throw new Error('This is not a valid BananaBlocks transaction, token, or output reference.');
}

module.exports = { buildBananaBlocksUrl };
