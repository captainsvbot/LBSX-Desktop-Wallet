import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, BadgeCheck, Loader2, Plus, RefreshCw, ShoppingCart, Tag, X } from 'lucide-react';
import BsvLogo from './BsvLogo.jsx';
import BsvText from './BsvText.jsx';
import TokenIcon from './TokenIcon.jsx';
import ExplorerReference from './ExplorerReference.jsx';

const formatUnits = (raw, decimals = 0) => {
  try {
    const n = BigInt(raw || '0');
    const scale = 10n ** BigInt(Math.min(18, Math.max(0, decimals)));
    const whole = n / scale;
    const fraction = scale === 1n ? '' : (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
  } catch { return '—'; }
};

const satsToBsv = sats => (Number(sats || 0) / 100000000).toFixed(8);
const BUY_SERVICE_FEE_SATS = 10000n;
const buyPlatformFeeSats = sats => {
  const price = BigInt(sats || 0);
  return price > 0n ? (price + 99n) / 100n : 1n;
};
const formatSats = raw => {
  try {
    const amount = BigInt(raw ?? '0');
    const whole = amount / 100000000n;
    const fraction = (amount % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
    return fraction ? `${whole.toLocaleString('en-US')}.${fraction}` : whole.toLocaleString('en-US');
  } catch { return '—'; }
};
const shortOutpoint = outpoint => outpoint ? `${outpoint.slice(0, 10)}…${outpoint.slice(-5)}` : '—';

function priceToSats(value) {
  const text = String(value || '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const sats = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
  return sats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sats) : null;
}

function unitsToBase(value, decimals = 0) {
  const text = String(value || '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  try { return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0'); }
  catch { return null; }
}

export default function TradingPage({ tokens = [], bsvBalance, address, onSyncAssets, assetsSyncing, discoveredOrders = [], discoverySyncedAt, discoverySyncing, discoveryError, onSyncDiscovery }) {
  const walletTokens = useMemo(() => Array.isArray(tokens) ? tokens : [], [tokens]);
  const [customTokens, setCustomTokens] = useState([]);
  const usableTokens = useMemo(() => [...walletTokens, ...customTokens.filter(custom => !walletTokens.some(token => token.tokenId === custom.tokenId))], [walletTokens, customTokens]);
  const [tokenId, setTokenId] = useState('');
  const [marketInput, setMarketInput] = useState('');
  const [marketFormOpen, setMarketFormOpen] = useState(false);
  const [addingMarket, setAddingMarket] = useState(false);
  const [addMarketError, setAddMarketError] = useState('');
  const [importedTokenError, setImportedTokenError] = useState('');
  const [orderBook, setOrderBook] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [side, setSide] = useState('buy');
  const [price, setPrice] = useState('');
  const [sellAmount, setSellAmount] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const quoteRequestRef = useRef(0);
  const [confirmation, setConfirmation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    let active = true;
    const loadImportedTokens = async () => {
      setImportedTokenError('');
      try {
        const saved = await window.lbsx.getImportedTokens();
        const imported = Array.isArray(saved) ? [...saved] : [];
        let legacy = [];
        try {
          const parsed = JSON.parse(localStorage.getItem('lbsxTradingMarkets') || '[]');
          legacy = Array.isArray(parsed) ? parsed : [];
        } catch {
          setImportedTokenError('The previous local token-market list could not be read; it was left unchanged.');
        }
        for (const token of legacy) {
          if (!token?.tokenId || imported.some(item => item.tokenId === token.tokenId)) continue;
          imported.push(await window.lbsx.saveImportedToken(token));
        }
        if (legacy.length) localStorage.removeItem('lbsxTradingMarkets');
        if (active) setCustomTokens(imported);
      } catch (error) {
        if (active) setImportedTokenError(error.message || 'Could not load the encrypted local token list.');
      }
    };
    loadImportedTokens();
    return () => { active = false; };
  }, [address]);

  useEffect(() => {
    if (!usableTokens.length) { setTokenId(''); return; }
    if (!usableTokens.some(token => token.tokenId === tokenId)) setTokenId(usableTokens[0].tokenId);
  }, [usableTokens, tokenId]);

  const selected = usableTokens.find(token => token.tokenId === tokenId);
  const decimals = Math.min(18, Math.max(0, Number(selected?.decimals || 0)));
  const confirmedSats = /^\d+$/.test(String(bsvBalance?.confirmed ?? '')) ? BigInt(bsvBalance.confirmed) : null;
  const unconfirmedSats = /^-?\d+$/.test(String(bsvBalance?.unconfirmed ?? '')) ? BigInt(bsvBalance.unconfirmed) : null;
  const trackedSpendableSats = /^\d+$/.test(String(bsvBalance?.spendableBsvSats ?? '')) ? BigInt(bsvBalance.spendableBsvSats) : null;
  // The chain can report a negative mempool delta; pending balance never shows as a credit.
  const pendingSats = unconfirmedSats === null ? null : unconfirmedSats > 0n ? unconfirmedSats : 0n;
  // Displayed balance mirrors the Overview tile: confirmed plus pending, never a negative pending.
  // The tracked 0-conf change is not added on top of the confirmed balance; it double counts inputs the
  // pending transaction already spends, which is what made the old tile read higher than the chain balance.
  const availableSats = confirmedSats === null ? trackedSpendableSats : confirmedSats + (pendingSats ?? 0n);
  // Fee/affordability checks keep the Send page rule: confirmed balance or locally tracked 0-conf change, whichever is larger.
  const spendableSats = confirmedSats === null
    ? trackedSpendableSats
    : trackedSpendableSats === null
      ? confirmedSats
      : (trackedSpendableSats > confirmedSats ? trackedSpendableSats : confirmedSats);
  const tokenBalanceBase = /^\d+$/.test(String(selected?.balance ?? '')) ? selected.balance : null;
  const orders = orderBook?.asks || [];
  const ownOrders = orderBook?.myOrders || [];
  const listingPriceSats = priceToSats(price);
  const bestAsk = orders[0];
  const bestAskTotalSats = bestAsk
    ? BigInt(bestAsk.priceSats) + buyPlatformFeeSats(bestAsk.priceSats) + BUY_SERVICE_FEE_SATS + 4000n
    : 0n;
  const canCoverBestAsk = spendableSats === null || !bestAsk || spendableSats >= bestAskTotalSats;

  const loadBook = async ({ quiet = false, preserveMessage = false } = {}) => {
    if (!tokenId) { setOrderBook(null); return; }
    quiet ? setRefreshing(true) : setLoading(true);
    if (!preserveMessage) setMessage(null);
    try {
      const result = await window.lbsx.getTokenOrderBook(tokenId);
      setOrderBook(result);
    } catch (error) {
      setMessage({ success: false, text: error.message || 'Could not load the on-chain order book.' });
    } finally { setLoading(false); setRefreshing(false); }
  };

  const loadSellQuote = async () => {
    const requestId = ++quoteRequestRef.current;
    const requestedTokenId = tokenId;
    setQuote(null); setQuoteError('');
    if (!requestedTokenId) return;
    setQuoteLoading(true);
    try {
      const result = await window.lbsx.getTokenSellQuote(requestedTokenId);
      if (requestId !== quoteRequestRef.current) return;
      setQuote(result);
      setSellAmount(formatUnits(result.amountBase, decimals));
    }
    catch (error) {
      if (requestId === quoteRequestRef.current) setQuoteError(error.message || 'No spendable token output was found. Sync assets and try again.');
    }
    finally { if (requestId === quoteRequestRef.current) setQuoteLoading(false); }
  };

  useEffect(() => {
    quoteRequestRef.current += 1;
    setQuote(null); setQuoteError(''); setQuoteLoading(false); setOrderBook(null);
    if (tokenId) {
      loadBook();
      // If the user changes CIGAR/token while Sell is selected, fetch a fresh
      // spendable UTXO quote for the newly selected pair automatically.
      if (side === 'sell') loadSellQuote();
    }
  }, [tokenId]);

  const chooseSide = sideName => {
    setSide(sideName); setConfirmation(null); setMessage(null);
    if (sideName === 'sell' && !quote && !quoteLoading) loadSellQuote();
  };

  const prepareBuy = listing => setConfirmation({ kind: 'buy', listing });
  const addMarket = async event => {
    event.preventDefault();
    if (addingMarket) return;
    setAddingMarket(true); setAddMarketError('');
    try {
      const market = await window.lbsx.getTokenMarketInfo(marketInput.trim());
      const saved = await window.lbsx.saveImportedToken(market);
      setCustomTokens(current => [saved, ...current.filter(item => item.tokenId !== saved.tokenId)]);
      setTokenId(saved.tokenId); setMarketInput(''); setMarketFormOpen(false);
    } catch (error) { setAddMarketError(error.message || 'Could not load that BSV-21 token from BananaBlocks.'); }
    finally { setAddingMarket(false); }
  };
  const prepareSell = () => {
    if (!quote) return setQuoteError('Sync the wallet and load a spendable token output first.');
    if (listingPriceSats == null || listingPriceSats < 100) return setQuoteError('Enter a price of at least 0.00000100 BSV.');
    if (spendableSats !== null && spendableSats < 5000n) return setQuoteError('At least 0.00005000 spendable BSV is needed for transaction fees.');
    const amountBase = unitsToBase(sellAmount, decimals);
    if (amountBase === null || amountBase <= 0n) return setQuoteError(`Enter a token amount greater than zero with no more than ${decimals} decimal places.`);
    if (amountBase > BigInt(quote.amountBase)) return setQuoteError('The sell amount exceeds the spendable token output.');
    setQuoteError(''); setConfirmation({ kind: 'sell', priceSats: listingPriceSats, amountBase: amountBase.toString() });
  };

  const submit = async () => {
    if (!confirmation || busy) return;
    setBusy(true); setMessage(null); setSubmitError('');
    try {
      let result;
      if (confirmation.kind === 'sell') {
        result = await window.lbsx.listTokenForSale({ tokenId, amountBase: confirmation.amountBase, priceSats: confirmation.priceSats, decimals, symbol: selected?.symbol });
        setMessage({ success: true, text: 'Sell listing broadcast:', txid: result.txid });
      } else if (confirmation.kind === 'buy') {
        result = await window.lbsx.buyTokenListing({ tokenId, outpoint: confirmation.listing.outpoint, decimals, symbol: selected?.symbol });
        setMessage({ success: true, text: 'Purchase broadcast:', txid: result.txid });
      } else {
        result = await window.lbsx.cancelTokenListing({ tokenId, outpoint: confirmation.listing.outpoint, decimals, symbol: selected?.symbol });
        setMessage({ success: true, text: 'Cancellation broadcast:', txid: result.txid });
      }
      setConfirmation(null);
      await loadBook({ quiet: true, preserveMessage: true });
    } catch (error) {
      const text = error.message || 'The transaction could not be broadcast.';
      setSubmitError(text);
      setMessage({ success: false, text });
    } finally { setBusy(false); }
  };

  return <>
    <div className="page-heading trading-page-heading">
      <div><div className="eyebrow">PEER-TO-PEER · BSV-21</div><h1>Trading</h1><p>Buy and sell tokens through public on-chain OrdLock listings.</p></div>
      <div className="trading-heading-actions">
        <button className="secondary-button" onClick={() => { setMarketFormOpen(open => !open); setAddMarketError(''); }}><Plus size={15} />Import token</button>
        <button className="secondary-button" onClick={() => loadBook({ quiet: true })} disabled={!tokenId || refreshing || loading}>
          <RefreshCw size={15} className={refreshing ? 'spin' : ''} />{refreshing ? 'Syncing…' : 'Refresh order book'}
        </button>
      </div>
    </div>

    {marketFormOpen && <form className="market-add-form" onSubmit={addMarket}>
      <div><label className="field-label" htmlFor="market-token-id">Import a BSV-21 token</label><p className="market-form-note">Paste its full token ID, including the origin output suffix (for example: txid_0). The import is encrypted and saved for this wallet, even if you hold none.</p></div>
      <input id="market-token-id" value={marketInput} onChange={event => setMarketInput(event.target.value)} placeholder="64-character txid_0" autoComplete="off" spellCheck="false" required pattern="[a-fA-F0-9]{64}_[0-9]+" title="Enter the full BSV-21 token ID, including its origin output index (txid_outputIndex)" />
      <button className="primary-button" type="submit" disabled={addingMarket || !marketInput.trim()}>{addingMarket ? <><Loader2 size={15} className="spin" />Loading…</> : 'Import token'}</button>
      {addMarketError && <div className="market-inline-error" role="alert">{addMarketError}</div>}
    </form>}
    {importedTokenError && <div className="market-inline-error" role="alert">{importedTokenError}</div>}


    <section className="market-terminal surface-card">
      <header className="market-terminal-head">
        <div className="market-pair-select">
          <div className="market-token-mark"><TokenIcon token={selected} fallback={selected?.symbol ? selected.symbol.slice(0, 1).toUpperCase() : <BsvLogo />} /></div>
          <label><span className="muted-label">TOKEN MARKET</span>
            <select aria-label="Select token market" value={tokenId} onChange={event => setTokenId(event.target.value)} disabled={!usableTokens.length}>
              {usableTokens.map(token => <option key={token.tokenId} value={token.tokenId}>{token.symbol || token.name || token.tokenId}</option>)}
            </select>
            {selected && <ExplorerReference value={selected.tokenId} kind="token" className="market-token-reference" />}
          </label>
        </div>
        <div className="market-summary"><span><i className="status-dot" />{loading ? 'SYNCING' : 'ON-CHAIN BOOK'}</span><b>{orders.length} ask{orders.length === 1 ? '' : 's'}</b></div>
      </header>

      {usableTokens.length > 0 && <div className="market-balance-strip" aria-label="Wallet trading balances">
        <div><span><BsvText>BSV available</BsvText></span><b><BsvText>{availableSats === null ? 'Sync wallet' : `${formatSats(availableSats)} BSV`}</BsvText></b>{confirmedSats !== null && <small>Confirmed {formatSats(confirmedSats)} · Pending {formatSats(pendingSats ?? 0n)} BSV</small>}{confirmedSats === null && <small>{trackedSpendableSats === null ? 'Sync balances to read your on-chain BSV balance' : `${formatSats(trackedSpendableSats)} locally tracked · 0-conf spendable`}</small>}</div>
        <div><span>{selected?.symbol || 'Token'} balance</span><b>{tokenBalanceBase === null ? '—' : `${formatUnits(tokenBalanceBase, decimals)} ${selected?.symbol || ''}`}</b><small>Wallet total · sell checks a spendable UTXO</small></div>
        <button type="button" onClick={onSyncAssets} disabled={assetsSyncing}><RefreshCw size={13} className={assetsSyncing ? 'spin' : ''} />{assetsSyncing ? 'Syncing' : 'Sync balances'}</button>
      </div>}

      {!usableTokens.length ? <div className="market-empty">
        <div className="large-empty-icon"><ArrowDownUp size={23} /></div><h2>Import a BSV-21 token to start</h2>
        <p>Import any token by its origin ID to discover LBSX listings, even if you do not hold it. Imported tokens are saved in encrypted wallet data.</p>
        <button className="primary-button" onClick={() => setMarketFormOpen(true)}><Plus size={15} />Import BSV-21 token</button>
        <button className="secondary-button" onClick={onSyncAssets} disabled={assetsSyncing}><RefreshCw size={15} className={assetsSyncing ? 'spin' : ''} />{assetsSyncing ? 'Syncing assets…' : 'Sync wallet assets'}</button>
      </div> : <>
        <div className="market-terminal-body">
          <section className="market-book-column">
            <div className="market-section-title"><div><span className="muted-label">LIVE ORDER BOOK</span><h2>{selected?.symbol || 'BSV-21'} / BSV</h2></div><span className="market-indexer">Admin wallet index</span></div>
            <div className="market-book-labels"><span>LISTING TOTAL (BSV)</span><span>AMOUNT ({selected?.symbol || 'TOKEN'})</span><span>SELLER</span></div>
            <div className="market-asks">
              {orders.map((listing, index) => <div className="market-ask-row" key={listing.outpoint}>
                <div className="market-depth-bar" style={{ width: `${Math.min(88, 22 + index * 5)}%` }} />
                <span className="market-price">{satsToBsv(listing.priceSats)}</span>
                <span>{formatUnits(listing.amountBase, listing.decimals ?? decimals)}</span>
                <div className="market-listing-seller"><div><code title={listing.sellerAddress}>{listing.sellerAddress ? `${listing.sellerAddress.slice(0, 6)}…${listing.sellerAddress.slice(-4)}` : 'Unknown seller'}</code><ExplorerReference value={listing.outpoint} kind="outpoint" compact /></div>{listing.status === 'pending' && <span className="market-pending-tag">PENDING</span>}</div>
                <button className="market-buy-button" onClick={() => prepareBuy(listing)} title={listing.status === 'pending' ? 'This listing is waiting for confirmation' : 'Review and buy this listing'} disabled={listing.status === 'pending' || (spendableSats !== null && spendableSats < BigInt(listing.priceSats) + buyPlatformFeeSats(listing.priceSats) + BUY_SERVICE_FEE_SATS + 4000n)}><ShoppingCart size={13} />{listing.status === 'pending' ? 'Pending' : 'Buy'}</button>
              </div>)}
              {!orders.length && <div className="market-empty compact"><div className="large-empty-icon"><Tag size={20} /></div><h3>{loading ? 'Indexing admin-wallet orders…' : 'No active sell listings'}</h3><p>The wallet scans the admin-wallet OP_RETURN history and verifies each matching BSV-21 OrdLock output with BananaBlocks.</p></div>}
            </div>
            <div className="market-book-foot"><span>Confirmed listings are buyable; mempool listings show as pending</span><span>{orderBook?.syncedAt ? `Updated ${new Date(orderBook.syncedAt).toLocaleTimeString()}` : '—'}</span></div>
          </section>

          <section className="market-action-column">
            <div className="market-section-title"><div><span className="muted-label">ORDER ENTRY</span><h2>Trade {selected?.symbol || 'token'}</h2></div></div>
            <div className="market-side-toggle"><button className={side === 'buy' ? 'active buy' : ''} onClick={() => chooseSide('buy')}>Buy</button><button className={side === 'sell' ? 'active sell' : ''} onClick={() => chooseSide('sell')}>Sell</button></div>

            {side === 'buy' ? <div className="market-order-form">
              <div className="market-mini-stat"><span>Best listing total</span><b><BsvText>{orders.length ? `${satsToBsv(orders[0].priceSats)} BSV` : '—'}</BsvText></b></div>
              {!canCoverBestAsk && <div className="market-inline-error">Not enough confirmed BSV for the best listing plus the minimum fee reserve. Sync after funding the wallet or choose a lower-priced listing.</div>}
              {spendableSats === null && <div className="market-inline-error">Sync balances before buying to check BSV available for the listing and transaction fees.</div>}
              <p className="market-form-note">Choose a live OrdLock listing from the book. Buy orders settle on-chain directly; there is no off-chain matching engine.</p>
              <button className="primary-button wide" disabled={!orders.length || !canCoverBestAsk || spendableSats === null} onClick={() => orders.length && prepareBuy(orders[0])}><ShoppingCart size={15} />{orders.length ? 'Review best ask' : 'No asks available'}</button>
            </div> : <div className="market-order-form">
              <div className="market-mini-stat"><span>Spendable token UTXO</span><b>{quote ? `${formatUnits(quote.amountBase, decimals)} ${selected?.symbol || ''}` : quoteError ? 'Unavailable' : quoteLoading ? 'Checking…' : 'Not loaded'}</b></div>
              {tokenBalanceBase !== null && quote && <div className="market-inline-note">Wallet balance: {formatUnits(tokenBalanceBase, decimals)} {selected?.symbol}. This spendable output can fund a listing up to {formatUnits(quote.amountBase, decimals)} {selected?.symbol}; any unlisted remainder returns to your wallet.</div>}
              {spendableSats !== null && spendableSats < 5000n && <div className="market-inline-error">At least 0.00005000 spendable BSV is needed for listing transaction fees.</div>}
              {quoteError && <div className="market-inline-error">{quoteError} <button type="button" className="market-retry-quote" onClick={loadSellQuote} disabled={quoteLoading}>Retry lookup</button></div>}
              <label className="field-label">Total listing price<div className="amount-input"><input value={price} onChange={event => setPrice(event.target.value)} placeholder="0.00010000" inputMode="decimal" /><span className="bsv-ticker">BSV</span></div></label>
              <label className="field-label">Token amount<div className="amount-input"><input aria-label="Token amount to sell" value={sellAmount} onChange={event => setSellAmount(event.target.value)} placeholder="0" inputMode="decimal" disabled={!quote} /><span>{selected?.symbol || 'TOKEN'}</span></div></label>
              <p className="market-form-note">Enter the amount to sell. The remainder from this spendable output is returned to your wallet as a separate BSV-21 output. You can cancel the listing later.</p>
              <button className="primary-button wide" onClick={prepareSell} disabled={!quote || quoteLoading || (spendableSats !== null && spendableSats < 5000n)}><Tag size={15} />Review sell listing</button>
            </div>}
            <div className="market-local-note"><BadgeCheck size={14} /><span>Keys stay local. BananaBlocks provides confirmed and mempool history; the wallet reconstructs orders from the admin-wallet OP_RETURN and verifies the live OrdLock output.</span></div>
          </section>
        </div>

        <section className="market-my-orders">
          <div className="market-section-title"><div><span className="muted-label">YOUR SELL ORDERS</span><h2>My listings</h2></div><span className="market-order-count">{ownOrders.length}</span></div>
          {ownOrders.length ? ownOrders.map(listing => <div className="market-own-row" key={listing.outpoint}>
            <div><b>{formatUnits(listing.amountBase, listing.decimals ?? decimals)} {selected?.symbol || ''}</b><span>{satsToBsv(listing.priceSats)} <BsvText>BSV</BsvText> · <ExplorerReference value={listing.outpoint} kind="outpoint" /></span></div>
            {listing.status === 'pending' ? <span className="market-pending-tag">Pending confirmation</span> : <button className="market-cancel-button" onClick={() => setConfirmation({ kind: 'cancel', listing })}><X size={13} />Cancel order</button>}
          </div>) : <div className="market-no-orders">No active listings from this wallet for the selected token.</div>}
        </section>
      </>}
    </section>

    {message && <div className={`market-message ${message.success ? 'success' : 'error'}`}><span>{message.text}{message.txid && <> <ExplorerReference value={message.txid} className="market-message-reference" /></>}</span><button aria-label="Dismiss" onClick={() => setMessage(null)}><X size={14} /></button></div>}

    {confirmation && <div className="modal-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setConfirmation(null); }}>
      <section className="token-modal market-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="market-review-title">
        <header className="token-modal-head"><div><span className="muted-label">LOCAL SIGNING · MAINNET</span><h2 id="market-review-title">Review {confirmation.kind === 'buy' ? 'token purchase' : confirmation.kind === 'sell' ? 'sell listing' : 'order cancellation'}</h2></div><button className="icon-button" onClick={() => setConfirmation(null)} disabled={busy} aria-label="Close">×</button></header>
        <div className="market-review-details">
          {confirmation.kind === 'sell' ? <><div><span>Token amount</span><b>{formatUnits(confirmation.amountBase, decimals)} {selected?.symbol}</b></div><div><span>Returned token remainder</span><b>{formatUnits(BigInt(quote?.amountBase || '0') - BigInt(confirmation.amountBase), decimals)} {selected?.symbol}</b></div><div><span>Total listing price</span><b>{satsToBsv(confirmation.priceSats)} BSV ({confirmation.priceSats.toLocaleString()} sats)</b></div><div><span>Seller / cancel address</span><code>{address}</code></div><div><span>Order format</span><b>On-chain OrdLock v2</b></div><div><span>Discovery record</span><b>OP_RETURN: token, amount, price, seller, source outpoint</b></div><div><span>Admin-wallet anchor</span><b>0.0001 BSV to 15BYCBgXi2…N9nQqp7eB</b></div></> : <><div><span>Token amount</span><b>{formatUnits(confirmation.listing.amountBase, confirmation.listing.decimals ?? decimals)} {selected?.symbol}</b></div>{confirmation.kind === 'buy' && <div><span>Listing price</span><b>{satsToBsv(confirmation.listing.priceSats)} BSV</b></div>}<div><span>{confirmation.kind === 'buy' ? 'Payment to seller' : 'Listing price'}</span><b>{satsToBsv(confirmation.listing.priceSats)} BSV ({confirmation.listing.priceSats.toLocaleString()} sats)</b></div>{confirmation.kind === 'buy' && <><div><span>Payment to ADMIN-WALLET ANCHOR</span><b>{satsToBsv(buyPlatformFeeSats(confirmation.listing.priceSats))} BSV ({buyPlatformFeeSats(confirmation.listing.priceSats).toLocaleString()} sats)</b></div><div><span>Service fee</span><b>{satsToBsv(BUY_SERVICE_FEE_SATS)} BSV (10,000 sats)</b></div><div><span>Discovery record</span><b>OP_RETURN: token, amount, price, buyer, source outpoint</b></div></>}<div><span>Listing outpoint</span><ExplorerReference value={confirmation.listing.outpoint} kind="outpoint" /></div><div><span>Action</span><b>{confirmation.kind === 'buy' ? 'Buy and receive BSV-21 token' : 'Cancel and return token to this wallet'}</b></div></>}
        </div>
        {submitError && <div className="market-inline-error" role="alert">{submitError}</div>}
        <p className="token-modal-warning">This signs and broadcasts a mainnet transaction. The action cannot be reversed after broadcast. Check the token, amount, price, and outpoint before continuing.</p>
        <div className="review-buttons"><button className="secondary-button" onClick={() => setConfirmation(null)} disabled={busy}>Back</button><button className="primary-button" onClick={submit} disabled={busy}>{busy ? <><Loader2 size={15} className="spin" />Signing and broadcasting…</> : confirmation.kind === 'sell' ? <><Tag size={15} />List on chain</> : confirmation.kind === 'buy' ? <><ShoppingCart size={15} />Buy token</> : <><X size={15} />Cancel order</>}</button></div>
      </section>
    </div>}
  </>;
}
