import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Coins, Layers, RefreshCw, Search, Wallet } from 'lucide-react';
import ExplorerReference from './ExplorerReference.jsx';

const PAGE_SIZE = 20;

const TYPE_ICON = {
  spendable: Wallet,
  token: Coins,
  locked: Layers,
  spent: AlertTriangle,
  unverified: AlertTriangle,
};

const formatBsv = satoshis => {
  const value = Number(satoshis) || 0;
  return (value / 1e8).toLocaleString(undefined, { minimumFractionDigits: 8, maximumFractionDigits: 8 });
};

export default function UtxoStorePanel() {
  const [store, setStore] = useState({ rows: [], total: 0, counts: {}, page: 1, pageCount: 1, pageSize: PAGE_SIZE, lastSyncedAt: null });
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (targetPage, targetQuery) => {
    setLoading(true);
    setError('');
    try {
      const result = await window.lbsx.getUtxoStore({ query: targetQuery, page: targetPage, pageSize: PAGE_SIZE });
      setStore({
        rows: result?.rows || [],
        total: Number(result?.total) || 0,
        counts: result?.counts || {},
        page: Number(result?.page) || 1,
        pageCount: Math.max(1, Number(result?.pageCount) || 1),
        pageSize: Number(result?.pageSize) || PAGE_SIZE,
        lastSyncedAt: result?.lastSyncedAt || null,
      });
    } catch (reason) {
      setError(reason?.message || 'Could not load the saved UTXO store.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(1, ''); }, [load]);

  const submitSearch = event => {
    event.preventDefault();
    const next = query.trim();
    setPage(1);
    load(1, next);
  };

  const goToPage = nextPage => {
    const target = Math.min(Math.max(1, nextPage), store.pageCount);
    setPage(target);
    load(target, query.trim());
  };

  const rows = store.rows || [];
  const counts = store.counts || {};

  return <section className="surface-card utxo-store">
    <div className="utxo-store-head">
      <div>
        <div className="eyebrow">LOCAL UTXO HISTORY</div>
        <h2>UTXO Store</h2>
        <p>Every wallet output saved on this computer, with its type: spendable BSV, a BSV-21 token, a time-locked output, spent, or not yet verified.</p>
      </div>
      <button className="secondary-button" type="button" onClick={() => load(page, query.trim())} disabled={loading}>
        <RefreshCw size={15} className={loading ? 'spin' : ''} /> {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>

    <form className="utxo-store-search" onSubmit={submitSearch}>
      <div className="utxo-store-search-field">
        <Search size={15} />
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search by TXID, vout, block or type (e.g. BUILD)"
          aria-label="Search saved UTXOs"
        />
      </div>
      <button className="primary-button" type="submit" disabled={loading}>Search</button>
    </form>

    <div className="utxo-store-summary">
      <span><b>{store.total.toLocaleString()}</b> saved {store.total === 1 ? 'output' : 'outputs'}</span>
      {counts.spendable ? <span className="utxo-type-chip spendable"><Wallet size={12} /> {counts.spendable} spendable</span> : null}
      {counts.token ? <span className="utxo-type-chip token"><Coins size={12} /> {counts.token} token</span> : null}
      {counts.locked ? <span className="utxo-type-chip locked"><Layers size={12} /> {counts.locked} locked</span> : null}
      {counts.unverified ? <span className="utxo-type-chip unverified"><AlertTriangle size={12} /> {counts.unverified} unverified</span> : null}
      {store.lastSyncedAt ? <span className="utxo-store-synced">Last scan {new Date(store.lastSyncedAt).toLocaleString()}</span> : null}
    </div>

    {error ? <div className="sync-error" role="alert">{error}</div> : null}

    <div className="utxo-store-table-wrap">
      <table className="utxo-store-table">
        <thead>
          <tr><th>TXID</th><th>VOUT</th><th>VALUE (BSV)</th><th>TYPE</th><th>BLOCK</th></tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const Icon = TYPE_ICON[row.type] || AlertTriangle;
            return <tr key={`${row.txid}.${row.vout}`}>
              <td className="utxo-txid"><ExplorerReference value={row.txid} compact className="utxo-txid-reference" /></td>
              <td>{row.vout}</td>
              <td>{formatBsv(row.satoshis)}</td>
              <td><span className={`utxo-type-chip ${row.type}`}><Icon size={12} /> {row.typeLabel}</span></td>
              <td>{row.blockHeight != null ? row.blockHeight.toLocaleString() : '—'}</td>
            </tr>;
          })}
          {!rows.length && !loading ? <tr><td colSpan={5} className="utxo-store-empty">No saved UTXOs match this search yet. Run a balance sync to scan the wallet again.</td></tr> : null}
        </tbody>
      </table>
    </div>

    <div className="utxo-store-pager">
      <button className="secondary-button" type="button" onClick={() => goToPage(page - 1)} disabled={loading || store.page <= 1}>
        <ChevronLeft size={15} /> Previous
      </button>
      <span>Page <b>{store.page}</b> of <b>{store.pageCount}</b></span>
      <button className="secondary-button" type="button" onClick={() => goToPage(page + 1)} disabled={loading || store.page >= store.pageCount}>
        Next <ChevronRight size={15} />
      </button>
    </div>
  </section>;
}
