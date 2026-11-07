import React, { useState } from 'react';
import { BadgeCheck, Check, Coins, ImagePlus, RefreshCw, ShieldCheck } from 'lucide-react';
import ExplorerReference from './ExplorerReference.jsx';
import './Bsv21ToolsPage.css';

const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_TICKER_LENGTH = 28;
const UINT64_MAX = 18446744073709551615n;

function maxSupplyAtDecimals(decimalsValue) {
  const dec = Number.parseInt(decimalsValue, 10);
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) return null;
  return UINT64_MAX / (10n ** BigInt(dec));
}

function supplyExceedsCap(supplyValue, decimalsValue) {
  const max = maxSupplyAtDecimals(decimalsValue);
  if (max === null || !/^\d+$/.test(supplyValue)) return false;
  return BigInt(supplyValue) > max;
}

function formatSatoshis(value) {
  try {
    const sats = BigInt(value);
    const whole = sats / 100000000n;
    const fraction = (sats % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return 'unknown';
  }
}

export default function Bsv21ToolsPage({ balance, onMinted }) {
  const [symbol, setSymbol] = useState('');
  const [supply, setSupply] = useState('');
  const [decimals, setDecimals] = useState('0');
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [imageName, setImageName] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const confirmedBalance = balance?.confirmed != null ? `${formatSatoshis(balance.confirmed)} BSV` : 'not synced';
  const pendingBalance = balance?.unconfirmed != null ? `${formatSatoshis(balance.unconfirmed)} BSV` : 'not synced';
  const spendableBalance = balance?.spendableBsvSats != null ? `${formatSatoshis(balance.spendableBsvSats)} BSV` : 'sync balances first';

  const selectImage = event => {
    const file = event.target.files?.[0];
    setError('');
    setImageDataUrl('');
    setImageName('');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPEG, or WebP image.');
      event.target.value = '';
      return;
    }
    if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
      setError('The token image must be smaller than 512 KB.');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError('The selected token image could not be read.');
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setError('The selected token image could not be read.');
        return;
      }
      setImageDataUrl(reader.result);
      setImageName(file.name);
    };
    reader.readAsDataURL(file);
  };

  const review = event => {
    event.preventDefault();
    setError('');
    if (!symbol.trim() || !supply.trim() || !imageDataUrl) {
      setError('Enter a ticker and supply, then choose a token image.');
      return;
    }
    if (!/^[A-Z0-9]{1,28}$/.test(symbol.trim())) {
      setError(`The ticker must be 1–${MAX_TICKER_LENGTH} letters or numbers.`);
      return;
    }
    if (!/^[1-9]\d*$/.test(supply.trim()) || !/^\d+$/.test(decimals) || Number(decimals) > 18) {
      setError('Enter a whole-number token supply greater than 0 and choose 0–18 decimal places.');
      return;
    }
    if (supplyExceedsCap(supply.trim(), decimals)) {
      setError(`Supply exceeds the maximum of ${maxSupplyAtDecimals(decimals)} at ${decimals} decimals (uint64 cap).`);
      return;
    }
    setReviewing(true);
  };

  const mint = async () => {
    setBusy(true);
    setError('');
    try {
      const minted = await window.lbsx.mintBsv21Token({
        symbol: symbol.trim(),
        supply: supply.trim(),
        decimals: Number(decimals),
        imageDataUrl,
        imageName,
      });
      setResult(minted);
      setReviewing(false);
      await onMinted?.();
    } catch (mintError) {
      setError(mintError.message || 'The BSV-21 token could not be minted.');
    } finally {
      setBusy(false);
    }
  };

  const clearForm = () => {
    setSymbol('');
    setSupply('');
    setDecimals('0');
    setImageDataUrl('');
    setImageName('');
    setReviewing(false);
    setError('');
    setResult(null);
  };

  return <>
    <div className="page-heading">
      <div><div className="eyebrow">CREATE ON-CHAIN ASSETS</div><h1>BSV-21 Tools</h1><p>Create and manage BSV-21 tokens from this wallet.</p></div>
    </div>
    <section className="surface-card mint-tool-card">
      <div className="mint-tool-heading"><div className="mint-tool-icon"><Coins size={18} /></div><div><span className="muted-label">FIRST TOOL</span><h2>Mint A Token</h2></div></div>
      {result ? <div className="mint-success" role="status">
        <div className="mint-success-icon"><Check size={19} /></div>
        <h3>{result.symbol} was broadcast</h3>
        <p>The BSV-21 deployment and its token image were broadcast together and recorded locally.</p>
        <dl><div><dt>Token ID</dt><dd><ExplorerReference value={result.tokenId} kind="token" /></dd></div><div><dt>Minted supply</dt><dd>{result.supply} {result.symbol}</dd></div><div><dt>Image + deployment transaction</dt><dd><ExplorerReference value={result.imageTxid} /></dd></div><div><dt>Admin index output</dt><dd><ExplorerReference value={result.adminIndexOutpoint} kind="outpoint" /> · 0.5 BSV service fee</dd></div></dl>
        <button className="secondary-button" onClick={clearForm}>Mint another token</button>
      </div> : reviewing ? <div className="mint-review">
        <span className="muted-label">REVIEW MAINNET TRANSACTIONS</span>
        <h3>Ready to mint {symbol.trim()}?</h3>
        <div><span>Initial supply</span><b>{supply} {symbol.trim()}</b></div>
        <div><span>Decimals</span><b>{decimals}</b></div>
        <div><span>Token image</span><b>{imageName}</b></div>
        <div><span>LBSX service fee</span><b>0.50000000 BSV (50,000,000 sat)</b></div>
        <p>Confirming broadcasts one irreversible transaction: a 1-satoshi Ordinals image output, the fixed-supply BSV-21 token output that references it, a <b>0.5 BSV service fee</b> output to the LBSX admin wallet, and a 0-satoshi OP_RETURN (<code>LBSX v2 mint</code>) that records this mint and the service fee on-chain. The service fee is collected to maintain the wallet and is not refundable. It is paid in addition to the network fee, which comes from verified wallet UTXOs.</p>
        {error && <div className="sync-error" role="alert">{error}</div>}
        <div className="mint-review-actions"><button className="secondary-button" onClick={() => setReviewing(false)} disabled={busy}>Back</button><button className="primary-button" onClick={mint} disabled={busy}>{busy ? <><RefreshCw size={15} className="spin" /> Broadcasting…</> : <><Coins size={15} /> Broadcast mint</>}</button></div>
      </div> : <form className="mint-form" onSubmit={review}>
        <div className="mint-form-grid">
          <label className="field-label">Token ticker<input value={symbol} onChange={event => setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, MAX_TICKER_LENGTH))} maxLength={MAX_TICKER_LENGTH} placeholder="e.g. LBSX" autoComplete="off" required /><small className="mint-field-hint">Letters and numbers only · max {MAX_TICKER_LENGTH} characters</small></label>
          <label className="field-label">Initial supply<input value={supply} onChange={event => {
            const raw = event.target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
            const max = maxSupplyAtDecimals(decimals);
            setSupply(max !== null && raw && BigInt(raw) > max ? max.toString() : raw);
          }} placeholder="e.g. 1000000" inputMode="numeric" autoComplete="off" required /><small className={supplyExceedsCap(supply, decimals) ? 'mint-field-hint mint-field-error' : 'mint-field-hint'}>Max at dec={decimals || '0'}: {maxSupplyAtDecimals(decimals)?.toString() ?? '—'} (uint64 cap)</small></label>
          <label className="field-label">Decimal places<input type="number" min="0" max="18" step="1" value={decimals} onChange={event => {
            const next = event.target.value.replace(/[^0-9]/g, '').slice(0, 2);
            const value = next === '' ? '' : String(Math.min(Number(next), 18));
            setDecimals(value);
            const max = maxSupplyAtDecimals(value);
            setSupply(current => (max !== null && current && BigInt(current) > max ? max.toString() : current));
          }} required /></label>
          <label className="field-label mint-image-label">Token image <span className="optional">PNG, JPEG, or WebP · max 512 KB</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={selectImage} required /></label>
        </div>
        {imageDataUrl && <div className="mint-image-preview"><img src={imageDataUrl} alt="Token image preview" /><span>{imageName}</span></div>}
        {error && <div className="sync-error" role="alert">{error}</div>}
        <div className="mint-local-note"><ShieldCheck size={16} /><span>The image and token inscription are public on-chain data. Signing stays on this device. Confirmed balance: {confirmedBalance} · Pending: {pendingBalance} · Verified spendable: {spendableBalance}. Minting costs a 0.5 BSV service fee plus the network fee and uses verified wallet-owned cash UTXOs; confirmed balance may also include token carriers, reserved outputs, or outputs not yet verified.</span></div>
        <div className="mint-fee-line"><span>LBSX service fee</span><b>0.5 <span className="bsv-ticker">BSV</span></b><small>+ network fee · non-refundable</small></div>
        <button className="primary-button mint-review-button" type="submit"><BadgeCheck size={15} />Review token mint</button>
      </form>}
    </section>
  </>;
}
