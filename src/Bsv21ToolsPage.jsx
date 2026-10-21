import React, { useState } from 'react';
import { BadgeCheck, Check, Coins, ImagePlus, RefreshCw, ShieldCheck } from 'lucide-react';
import ExplorerReference from './ExplorerReference.jsx';
import './Bsv21ToolsPage.css';

const MAX_IMAGE_BYTES = 512 * 1024;

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
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(supply.trim()) || Number(decimals) < 0 || Number(decimals) > 18) {
      setError('Enter a valid token supply and choose 0–18 decimal places.');
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
        <dl><div><dt>Token ID</dt><dd><ExplorerReference value={result.tokenId} kind="token" /></dd></div><div><dt>Minted supply</dt><dd>{result.supply} {result.symbol}</dd></div><div><dt>Image + deployment transaction</dt><dd><ExplorerReference value={result.imageTxid} /></dd></div><div><dt>Admin index output</dt><dd><ExplorerReference value={result.adminIndexOutpoint} kind="outpoint" /> · 1 sat</dd></div></dl>
        <button className="secondary-button" onClick={clearForm}>Mint another token</button>
      </div> : reviewing ? <div className="mint-review">
        <span className="muted-label">REVIEW MAINNET TRANSACTIONS</span>
        <h3>Ready to mint {symbol.trim()}?</h3>
        <div><span>Initial supply</span><b>{supply} {symbol.trim()}</b></div>
        <div><span>Decimals</span><b>{decimals}</b></div>
        <div><span>Token image</span><b>{imageName}</b></div>
        <p>Confirming broadcasts one irreversible transaction: a 1-satoshi Ordinals image output, the fixed-supply BSV-21 token output that references it, and a separate 1-satoshi index output to the wallet’s discovery address. Network fees are paid from verified wallet UTXOs.</p>
        {error && <div className="sync-error" role="alert">{error}</div>}
        <div className="mint-review-actions"><button className="secondary-button" onClick={() => setReviewing(false)} disabled={busy}>Back</button><button className="primary-button" onClick={mint} disabled={busy}>{busy ? <><RefreshCw size={15} className="spin" /> Broadcasting…</> : <><Coins size={15} /> Broadcast mint</>}</button></div>
      </div> : <form className="mint-form" onSubmit={review}>
        <div className="mint-form-grid">
          <label className="field-label">Token ticker<input value={symbol} onChange={event => setSymbol(event.target.value)} maxLength={32} placeholder="e.g. LBSX" autoComplete="off" required /></label>
          <label className="field-label">Initial supply<input value={supply} onChange={event => setSupply(event.target.value)} placeholder="e.g. 1000000" inputMode="decimal" autoComplete="off" required /></label>
          <label className="field-label">Decimal places<input type="number" min="0" max="18" step="1" value={decimals} onChange={event => setDecimals(event.target.value)} required /></label>
          <label className="field-label mint-image-label">Token image <span className="optional">PNG, JPEG, or WebP · max 512 KB</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={selectImage} required /></label>
        </div>
        {imageDataUrl && <div className="mint-image-preview"><img src={imageDataUrl} alt="Token image preview" /><span>{imageName}</span></div>}
        {error && <div className="sync-error" role="alert">{error}</div>}
        <div className="mint-local-note"><ShieldCheck size={16} /><span>The image and token inscription are public on-chain data. Signing stays on this device. Confirmed balance: {confirmedBalance} · Pending: {pendingBalance} · Verified spendable: {spendableBalance}. Minting uses verified wallet-owned cash UTXOs; confirmed balance may also include token carriers, reserved outputs, or outputs not yet verified.</span></div>
        <button className="primary-button mint-review-button" type="submit"><BadgeCheck size={15} />Review token mint</button>
      </form>}
    </section>
  </>;
}
