import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, ChevronLeft, Clock, Coins, Gift,
  HelpCircle, Loader2, Lock, MessageCircle, RefreshCw, Send,
  Smile, TrendingUp, Users, X, Zap,
} from 'lucide-react';
import ExplorerReference from './ExplorerReference.jsx';
import './PeerChatPage.css';

const MAX_MESSAGE_LENGTH = 500;
const RECENT_WINDOW_MS = 30 * 60 * 1000;
const TIP_PREFIX = 'LBSX-PEER-TIP:';
const QUICK_EMOJIS = ['😊', '😂', '❤️', '👍', '🔥', '💯', '✨', '🙏', '💪', '🎉', '👀', '🎯', '⚡', '🚀', '💎', '₿'];
const AVATAR_COLORS = [
  [99, 102, 241], [56, 189, 248], [52, 211, 153],
  [168, 85, 247], [236, 72, 153], [217, 70, 239],
];

const shortAddress = address => address ? `${address.slice(0, 10)}…${address.slice(-7)}` : 'Unknown wallet';
const formatTime = timestamp => {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Unknown time';
};

function formatDateLabel(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (left, right) => left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function timeAgo(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function colorForAddress(address) {
  const seed = [...String(address || '')].reduce(
    (hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619),
    2166136261,
  ) >>> 0;
  return AVATAR_COLORS[seed % AVATAR_COLORS.length];
}

function formatTokenUnits(raw, decimals = 0) {
  try {
    const amount = BigInt(raw || '0');
    const places = Math.min(18, Math.max(0, Number(decimals) || 0));
    const scale = 10n ** BigInt(places);
    const whole = amount / scale;
    const fraction = (amount % scale).toString().padStart(places, '0').replace(/0+$/, '');
    return fraction ? `${whole.toLocaleString('en-US')}.${fraction}` : whole.toLocaleString('en-US');
  } catch {
    return '0';
  }
}

function toTokenBaseUnits(amount, decimals = 0) {
  const places = Math.min(18, Math.max(0, Number(decimals) || 0));
  const text = String(amount || '');
  if (!/^\d*(?:\.\d*)?$/.test(text) || text === '' || text === '.') return null;
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > places) return null;
  try {
    return BigInt(whole || '0') * (10n ** BigInt(places))
      + BigInt(fraction.padEnd(places, '0') || '0');
  } catch {
    return null;
  }
}

function createTipAnnouncement({ token, amount, recipient, transferTxid }) {
  return `${TIP_PREFIX}${JSON.stringify({
    version: 1,
    tokenId: token.tokenId,
    symbol: token.symbol,
    amount,
    recipient,
    transferTxid,
  })}`;
}

function parseTipAnnouncement(content) {
  if (typeof content !== 'string' || !content.startsWith(TIP_PREFIX)) return null;
  try {
    const tip = JSON.parse(content.slice(TIP_PREFIX.length));
    if (tip?.version !== 1
      || !/^[0-9a-f]{64}(?:_\d+)?$/i.test(String(tip.tokenId || ''))
      || typeof tip.symbol !== 'string' || !tip.symbol.trim() || tip.symbol.length > 32
      || typeof tip.amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(tip.amount)
      || !/^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(String(tip.recipient || ''))
      || !/^[0-9a-f]{64}$/i.test(String(tip.transferTxid || ''))) return null;
    return tip;
  } catch {
    return null;
  }
}

function buildPeers(messages, ownAddress) {
  const byAddress = new Map();
  for (const message of messages) {
    const address = String(message.senderAddress || '');
    const timestamp = Date.parse(message.timestamp);
    if (!address || !Number.isFinite(timestamp)) continue;
    const existing = byAddress.get(address);
    if (!existing || timestamp > existing.lastSeen) byAddress.set(address, {
      address,
      lastSeen: timestamp,
      isMe: address === ownAddress,
      isRecent: Date.now() - timestamp < RECENT_WINDOW_MS,
    });
  }
  return [...byAddress.values()].sort((left, right) =>
    Number(right.isRecent) - Number(left.isRecent) || right.lastSeen - left.lastSeen);
}

function PeerAvatar({ address, size = 'md', recent = false }) {
  const [red, green, blue] = colorForAddress(address);
  const initial = address ? address.slice(1, 2).toUpperCase() : '?';
  return <div className={`pc-avatar pc-avatar-${size}`} style={{
    '--avatar-rgb': `${red}, ${green}, ${blue}`,
  }}>
    {initial}
    {recent && <span className="pc-avatar-dot" />}
  </div>;
}

function OnChainReference({ txid }) {
  return <ExplorerReference
    value={txid}
    kind="txid"
    compact
    linkLabel="on-chain"
    hideCopy
    className="pc-on-chain-link"
  />;
}

function DateDivider({ label }) {
  return <div className="pc-date-divider">
    <span className="pc-divider" />
    <b>{label}</b>
    <span className="pc-divider" />
  </div>;
}

function PeerMessage({ message, ownAddress, grouped }) {
  const isMine = message.senderAddress === ownAddress;
  const tip = parseTipAnnouncement(message.content);
  const [red, green, blue] = colorForAddress(message.senderAddress);
  return <article className={`pc-message-row ${isMine ? 'is-mine' : ''}`} style={{
    '--sender-rgb': `${red}, ${green}, ${blue}`,
  }}>
    {grouped ? <span className="pc-avatar-spacer" /> : <PeerAvatar address={message.senderAddress} />}
    <div className="pc-message-stack">
      {!grouped && <div className={`pc-message-author ${isMine ? 'is-mine' : ''}`}>
        <b>{isMine ? 'You' : shortAddress(message.senderAddress)}</b>
      </div>}
      {tip ? <div className="pc-tip-event">
        <Gift size={14} />
        <span><b>{isMine ? 'You' : shortAddress(message.senderAddress)}</b> tipped <strong>{tip.amount} {tip.symbol}</strong> to <code>{shortAddress(tip.recipient)}</code></span>
        <OnChainReference txid={tip.transferTxid} />
      </div> : <div className={`pc-message-bubble ${isMine ? 'is-mine' : ''}`}>
        <p>{message.content}</p>
      </div>}
      <div className={`pc-message-meta ${isMine ? 'is-mine' : ''}`}>
        <span>{formatTime(message.timestamp)}</span>
        {!message.isEncrypted && <span className="pc-legacy-label">legacy · plaintext</span>}
        {message.status === 'pending'
          ? <span className="pc-pending-label"><Clock size={11} /> pending</span>
          : <OnChainReference txid={message.txid} />}
      </div>
    </div>
  </article>;
}

function PeerChatPendingTransactions({ messages }) {
  const [pageNumber, setPageNumber] = useState(1);
  const pageSize = 5;
  const rows = useMemo(() => messages
    .filter(message => message?.status === 'pending' && /^[0-9a-f]{64}$/i.test(String(message.txid || '')))
    .sort((left, right) => {
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
        || String(right.txid).localeCompare(String(left.txid));
    }), [messages]);
  const pageCount = Math.ceil(rows.length / pageSize);
  const currentPage = Math.min(pageNumber, Math.max(pageCount, 1));
  const firstPage = Math.max(1, Math.min(currentPage - 2, pageCount - 4));
  const pageNumbers = Array.from(
    { length: Math.max(0, Math.min(5, pageCount - firstPage + 1)) },
    (_, index) => firstPage + index,
  );
  const firstRow = rows.length ? (currentPage - 1) * pageSize + 1 : 0;
  const lastRow = Math.min(currentPage * pageSize, rows.length);
  const visibleRows = rows.slice(firstRow - 1, lastRow);

  useEffect(() => {
    if (pageNumber > currentPage) setPageNumber(currentPage);
  }, [pageNumber, currentPage]);
  useEffect(() => {
    setPageNumber(1);
  }, [rows[0]?.txid]);

  if (!rows.length) return null;
  return <section className="pc-pending-transactions" aria-label="Pending Peer Chat transactions">
    <header className="pc-pending-transactions-header">
      <div className="pc-pending-transactions-title">
        <Clock size={15} />
        <div><h2>Pending Transactions</h2><p>Locally saved Peer Chat posts awaiting confirmation.</p></div>
      </div>
      <span className="pc-pending-count">{rows.length} pending</span>
    </header>
    <div className="pc-pending-list">
      {visibleRows.map(message => <article className="pc-pending-row" key={message.txid}>
        <span className="pc-pending-status"><Clock size={12} />Pending</span>
        <div className="pc-pending-details">
          <b>Peer Chat message</b>
          <time>{formatTime(message.timestamp)} · {new Date(message.timestamp).toLocaleDateString()}</time>
        </div>
        <ExplorerReference value={message.txid} kind="txid" compact className="pc-pending-reference" />
      </article>)}
    </div>
    {pageCount > 1 && <div className="activity-pagination">
      <span>Showing {firstRow}–{lastRow} of {rows.length} pending</span>
      <div className="activity-pagination-controls">
        <button type="button" className="activity-page-button" onClick={() => setPageNumber(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page"><ArrowLeft size={13} />Back</button>
        {pageNumbers.map(number => <button type="button" key={number} className={`activity-page-number ${number === currentPage ? 'active' : ''}`} onClick={() => setPageNumber(number)} aria-label={`Page ${number}`} aria-current={number === currentPage ? 'page' : undefined}>{number}</button>)}
        <button type="button" className="activity-page-button" onClick={() => setPageNumber(currentPage + 1)} disabled={currentPage >= pageCount} aria-label="Next page">Next<ArrowRight size={13} /></button>
      </div>
    </div>}
  </section>;
}

function MembersDrawer({ peers, onClose }) {
  const recent = peers.filter(peer => peer.isRecent);
  const earlier = peers.filter(peer => !peer.isRecent);
  const renderPeer = peer => <div className="pc-member-row" key={peer.address}>
    <PeerAvatar address={peer.address} size="sm" recent={peer.isRecent} />
    <div className="pc-member-details">
      <b>{peer.isMe ? 'You' : shortAddress(peer.address)}</b>
      <span>{timeAgo(peer.lastSeen)}</span>
    </div>
    {peer.isMe && <small>YOU</small>}
  </div>;
  return <aside className="pc-members-drawer" aria-label="Peer Chat members">
    <header><div><Users size={15} /><b>Members</b><span>{peers.length}</span></div>
      <button type="button" onClick={onClose} aria-label="Close members"><X size={16} /></button>
    </header>
    <div className="pc-members-list">
      {peers.length === 0 ? <p className="pc-drawer-empty">No wallets in the local index yet.</p> : <>
        {recent.length > 0 && <section><h3>RECENT · {recent.length}</h3>{recent.map(renderPeer)}</section>}
        {earlier.length > 0 && <section><h3>EARLIER · {earlier.length}</h3>{earlier.map(renderPeer)}</section>}
      </>}
    </div>
    <footer>Recent means a message was indexed in the last 30 minutes; this is not live-presence tracking.</footer>
  </aside>;
}

function PeerChatTipDialog({ peers, tokens, onClose, onRefresh }) {
  const [stage, setStage] = useState('token');
  const [selectedToken, setSelectedToken] = useState(null);
  const [selectedPeer, setSelectedPeer] = useState(null);
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [refreshError, setRefreshError] = useState('');
  const availableTokens = tokens.filter(token => {
    try { return BigInt(token.balance || '0') > 0n; } catch { return false; }
  });
  const recipients = peers.filter(peer => !peer.isMe);
  const decimals = Math.min(18, Math.max(0, Number(selectedToken?.decimals) || 0));
  const amountBase = toTokenBaseUnits(amount, decimals);
  const tokenBalance = (() => {
    try { return BigInt(selectedToken?.balance || '0'); } catch { return 0n; }
  })();
  const amountIsValid = amountBase !== null && amountBase > 0n && amountBase <= tokenBalance;
  const titles = { token: 'Select a Token', peer: 'Select a Peer', amount: 'Enter Amount', review: 'Review & Tip', result: 'Tip Status' };

  const back = () => {
    if (stage === 'peer') setStage('token');
    else if (stage === 'amount') setStage('peer');
    else if (stage === 'review') setStage('amount');
  };

  const sendTip = async () => {
    if (!selectedToken || !selectedPeer || !amountIsValid || busy) return;
    setBusy(true);
    setAmountError('');
    try {
      const displayAmount = formatTokenUnits(amountBase.toString(), decimals).replace(/,/g, '');
      const transfer = await window.lbsx.sendToken({
        tokenId: selectedToken.tokenId,
        decimals,
        symbol: selectedToken.symbol,
        amount: displayAmount,
        recipient: selectedPeer.address,
      });
      let announcementTxid = '';
      let announcementError = '';
      try {
        const announcement = createTipAnnouncement({
          token: selectedToken,
          amount: displayAmount,
          recipient: selectedPeer.address,
          transferTxid: transfer.txid,
        });
        const post = await window.lbsx.sendPeerChatMessage({ message: announcement });
        announcementTxid = post.txid;
      } catch (error) {
        announcementError = error.message || 'The token transfer succeeded, but its chat announcement failed.';
      }
      setResult({ tokenTxid: transfer.txid, announcementTxid, announcementError });
      setStage('result');
      if (onRefresh) {
        Promise.resolve(onRefresh()).catch(error => {
          setRefreshError(error.message || 'The wallet activity could not be refreshed.');
        });
      }
    } catch (error) {
      setResult({ transferError: error.message || 'The token transfer could not be confirmed.' });
      setStage('result');
    } finally {
      setBusy(false);
    }
  };

  const selectAmount = value => {
    if (/[+\-eE]/.test(value) || !/^\d*(?:\.\d*)?$/.test(value)) return;
    const fractional = value.split('.')[1] || '';
    if (fractional.length > decimals) return;
    setAmount(value);
    setAmountError('');
  };

  return <div className="pc-modal-scrim">
    <section className="pc-tip-dialog" role="dialog" aria-modal="true" aria-label="Tip a Peer">
      <header>
        <div className="pc-tip-dialog-title">
          {['peer', 'amount', 'review'].includes(stage) && <button type="button" onClick={back} disabled={busy} aria-label="Go back"><ChevronLeft size={17} /></button>}
          <span><Gift size={15} /></span><b>{titles[stage]}</b>
        </div>
        {!busy && <button type="button" className="pc-tip-close" onClick={onClose} aria-label="Close tip"><X size={17} /></button>}
      </header>

      <div className="pc-tip-dialog-content">
        {stage === 'token' && (availableTokens.length ? <div className="pc-tip-options">
          {availableTokens.map(token => <button type="button" className="pc-tip-option" key={token.tokenId} onClick={() => { setSelectedToken(token); setStage('peer'); }}>
            <span className="pc-token-mark">{String(token.symbol || '??').slice(0, 2).toUpperCase()}</span>
            <span className="pc-tip-option-name"><b>{token.symbol}</b><small>{token.name || token.tokenId}</small></span>
            <strong>{formatTokenUnits(token.balance, token.decimals)}</strong>
          </button>)}
        </div> : <div className="pc-tip-empty"><Coins size={30} /><b>No tippable token balances</b><span>Sync your wallet or receive a BSV-21 token before tipping.</span></div>)}

        {stage === 'peer' && (recipients.length ? <div className="pc-tip-options">
          {recipients.map(peer => <button type="button" className="pc-tip-option" key={peer.address} onClick={() => { setSelectedPeer(peer); setStage('amount'); }}>
            <PeerAvatar address={peer.address} size="sm" recent={peer.isRecent} />
            <span className="pc-tip-option-name"><b>{shortAddress(peer.address)}</b><small>{peer.isRecent ? 'Recent message' : `Last message ${timeAgo(peer.lastSeen)}`}</small></span>
            <span className="pc-tip-option-address">{shortAddress(peer.address)}</span>
          </button>)}
        </div> : <div className="pc-tip-empty"><Users size={30} /><b>No peers to tip yet</b><span>Sync the shared feed or wait for another wallet to post.</span></div>)}

        {stage === 'amount' && selectedToken && selectedPeer && <div className="pc-tip-amount-stage">
          <div className="pc-tip-summary"><span className="pc-token-mark">{String(selectedToken.symbol || '??').slice(0, 2).toUpperCase()}</span>
            <div><b>{selectedToken.symbol}</b><small>To {shortAddress(selectedPeer.address)}</small></div>
            <strong>{formatTokenUnits(selectedToken.balance, decimals)} available</strong>
          </div>
          <label className="pc-tip-amount-label">Amount <button type="button" onClick={() => { setAmount(formatTokenUnits(selectedToken.balance, decimals).replace(/,/g, '')); setAmountError(''); }}>MAX</button></label>
          <div className="pc-tip-amount-input"><input value={amount} inputMode="decimal" onChange={event => selectAmount(event.target.value)} placeholder="0" autoFocus /><span>{selectedToken.symbol}</span></div>
          <small className="pc-tip-help">Up to {decimals} decimal place{decimals === 1 ? '' : 's'} · balance is rechecked before signing.</small>
          {amountError && <p className="pc-tip-error">{amountError}</p>}
          <button type="button" className="pc-tip-primary" disabled={!amountIsValid} onClick={() => { setAmountError(''); setStage('review'); }}>Review Tip</button>
        </div>}

        {stage === 'review' && selectedToken && selectedPeer && <div className="pc-tip-review">
          <div><span>To</span><b>{shortAddress(selectedPeer.address)}</b></div>
          <div><span>Token</span><b>{selectedToken.symbol}</b></div>
          <div><span>Amount</span><b>{formatTokenUnits(amountBase?.toString() || '0', decimals)} {selectedToken.symbol}</b></div>
          <div className="pc-tip-fee-warning"><AlertCircle size={15} /><p>This sends the token transfer and a separate app-encoded chat announcement. The announcement adds 1,000 sats to the admin wallet plus a miner fee; the token transfer also requires BSV for its miner fee.</p></div>
          <button type="button" className="pc-tip-primary" disabled={!amountIsValid || busy} onClick={sendTip}>
            {busy ? <><Loader2 size={14} className="spin" /> Sending on-chain…</> : <><Gift size={14} /> Tip Peer</>}
          </button>
        </div>}

        {stage === 'result' && result && <div className="pc-tip-result">
          {result.transferError ? <>
            <AlertCircle size={36} className="pc-tip-result-error" />
            <h3>Transfer status needs checking</h3>
            <p>{result.transferError}</p>
            <small>Check wallet Activity and BananaBlocks before trying again to avoid a duplicate transfer.</small>
          </> : <>
            <CheckCircle2 size={36} className="pc-tip-result-success" />
            <h3>Token transfer submitted</h3>
            <p>{amount} {selectedToken?.symbol} to {shortAddress(selectedPeer?.address)}</p>
            <div className="pc-tip-result-links"><span>Token transfer</span><ExplorerReference value={result.tokenTxid} kind="txid" compact /></div>
            {result.announcementTxid
              ? <div className="pc-tip-result-links"><span>Chat announcement</span><ExplorerReference value={result.announcementTxid} kind="txid" compact /></div>
              : <p className="pc-tip-partial-warning">{result.announcementError || 'The token transfer was submitted, but the chat announcement is unavailable. Do not resend the token.'}</p>}
            {refreshError && <p className="pc-tip-partial-warning">{refreshError}</p>}
          </>}
          <button type="button" className="pc-tip-primary" onClick={onClose}>Done</button>
        </div>}
      </div>
    </section>
  </div>;
}

function PeerChatInfo({ onClose }) {
  return <div className="pc-info-popover" role="dialog" aria-label="About Peer Chat">
    <div className="pc-info-content">
      <div><MessageCircle size={15} /><section><b>Wallet community feed</b><p>Messages from wallet addresses indexed through the shared admin-wallet history.</p></section></div>
      <div><Lock size={15} /><section><b>On-chain encoding</b><p>New posts use AES-GCM with a key derived from the public admin address, so anyone can reverse it. Local history is encrypted for this wallet; older v1 posts are plaintext.</p></section></div>
      <div><Zap size={15} /><section><b>Posting cost</b><p>Each chat post adds 1,000 sats to the admin wallet plus a miner fee and remains on BSV mainnet.</p></section></div>
    </div>
    <button type="button" onClick={onClose} aria-label="Close about Peer Chat"><X size={15} /></button>
  </div>;
}

function PeerChatFeatureCards() {
  return <div className="pc-feature-cards">
    <section className="pc-feature-card">
      <span className="pc-feature-icon is-green"><MessageCircle size={15} /></span>
      <div><b>Wallet community</b><p>Shared messages indexed locally from the admin-wallet feed.</p></div>
    </section>
    <section className="pc-feature-card">
      <span className="pc-feature-icon is-emerald"><Lock size={15} /></span>
      <div><b>On-chain encoding</b><p>Publicly reversible; local chat history is encrypted for this wallet.</p></div>
    </section>
    <section className="pc-feature-card">
      <span className="pc-feature-icon is-blue"><Zap size={15} /></span>
      <div><b>Micro-fee per message</b><p>1,000 sats to the admin wallet, plus the miner fee.</p></div>
    </section>
  </div>;
}

export default function PeerChatPage({ wallet, snapshot, syncing, error, onSync, onSent, onGo, tokens = [], onTokenTipSent }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showTip, setShowTip] = useState(false);
  const textareaRef = useRef(null);
  const endRef = useRef(null);
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const peers = useMemo(() => buildPeers(messages, wallet?.address), [messages, wallet?.address]);
  const recentPeerCount = peers.filter(peer => peer.isRecent).length;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const sendMessage = async text => {
    const content = String(text || '').trim();
    if (!content || sending) return;
    setSending(true);
    setSendError('');
    try {
      await window.lbsx.sendPeerChatMessage({ message: content });
      setDraft('');
      await onSent();
    } catch (sendFailure) {
      setSendError(sendFailure.message || 'The message could not be broadcast.');
    } finally {
      setSending(false);
      setShowEmoji(false);
    }
  };

  const submit = async event => {
    event.preventDefault();
    await sendMessage(draft);
  };

  const addEmoji = emoji => {
    const input = textareaRef.current;
    if (!input) { setDraft(value => value + emoji); return; }
    const start = input.selectionStart;
    const end = input.selectionEnd;
    setDraft(value => `${value.slice(0, start)}${emoji}${value.slice(end)}`);
    setShowEmoji(false);
    requestAnimationFrame(() => {
      input.focus();
      const cursor = start + emoji.length;
      input.setSelectionRange(cursor, cursor);
    });
  };

  return <div className="pc-page-layout">
    <header className="pc-page-heading">
      <div className="pc-page-title">
        <span className="pc-page-icon"><MessageCircle size={17} /></span>
        <h1>Peer Chat</h1>
        <span className="pc-live-badge">LIVE</span>
      </div>
      <p>Community chat — permanently stored on the BSV blockchain</p>
    </header>
    {error && <div className="sync-error" role="alert">{error}</div>}
    {sendError && <div className="pc-error" role="alert"><span>{sendError}</span><button type="button" onClick={() => setSendError('')} aria-label="Dismiss error">×</button></div>}

    <section className="pc-panel" aria-label="Peer Chat">
      <header className="pc-header">
        <div className="pc-panel-live"><span className={snapshot?.syncedAt ? 'is-indexed' : ''} />{snapshot?.syncedAt ? 'Live' : 'Local index not synced'}</div>
        <div className="pc-header-actions">
          <button type="button" className="pc-dex-button" onClick={() => onGo?.('trading')} title="Open Trading"><TrendingUp size={13} /><span>Token DEX</span></button>
          <button type="button" onClick={onSync} disabled={syncing} title="Sync messages" aria-label="Sync messages"><RefreshCw size={14} className={syncing ? 'spin' : ''} /></button>
          <button type="button" onClick={() => setShowMembers(value => !value)} aria-pressed={showMembers} title="Members" aria-label="Members"><Users size={14} /><span>Peers</span></button>
          <button type="button" onClick={() => setShowInfo(value => !value)} aria-pressed={showInfo} title="About Peer Chat" aria-label="About Peer Chat"><HelpCircle size={14} /></button>
        </div>
      </header>
      {showInfo && <PeerChatInfo onClose={() => setShowInfo(false)} />}
      <div className="pc-chat-body">
        <div className="pc-message-list" aria-live="polite">
          {messages.length ? messages.map((message, index) => {
            const previous = messages[index - 1];
            const label = formatDateLabel(message.timestamp);
            const previousLabel = previous ? formatDateLabel(previous.timestamp) : null;
            const timestamp = Date.parse(message.timestamp);
            const previousTimestamp = previous ? Date.parse(previous.timestamp) : NaN;
            const grouped = Boolean(previous && previous.senderAddress === message.senderAddress
              && label === previousLabel && Number.isFinite(timestamp) && Number.isFinite(previousTimestamp)
              && timestamp - previousTimestamp >= 0 && timestamp - previousTimestamp < 5 * 60 * 1000);
            return <React.Fragment key={message.txid}>
              {label !== previousLabel && <DateDivider label={label} />}
              <PeerMessage message={message} ownAddress={wallet?.address} grouped={grouped} />
            </React.Fragment>;
          }) : <div className="pc-empty-state">
            <span><MessageCircle size={28} /></span>
            <b>No messages yet</b>
            <p>Sync the shared admin-wallet index or post the first message.</p>
            <button type="button" onClick={onSync} disabled={syncing}><RefreshCw size={13} className={syncing ? 'spin' : ''} /> Sync messages</button>
          </div>}
          <div ref={endRef} className="pc-scroll-end" />
        </div>
        {showMembers && <MembersDrawer peers={peers} onClose={() => setShowMembers(false)} />}
        <form className="pc-composer" onSubmit={submit}>
          <div className="pc-composer-topline">
            <span><b>0.00001 BSV</b> + miner fees · stored on-chain</span>
            <button type="button" className="pc-tip-button" onClick={() => setShowTip(true)}><Gift size={13} /> Tip Token</button>
            {draft.length > 0 && <span className={`pc-char-count ${draft.length > 450 ? 'near-limit' : ''}`}>{MAX_MESSAGE_LENGTH - draft.length}</span>}
          </div>
          <div className="pc-input-well">
            <div className="pc-emoji-wrap">
              <button type="button" className="pc-emoji-trigger" disabled={sending} onClick={() => setShowEmoji(value => !value)} title="Add emoji" aria-label="Add emoji"><Smile size={18} /></button>
              {showEmoji && <div className="pc-emoji-picker" role="dialog" aria-label="Choose an emoji">
                {QUICK_EMOJIS.map(emoji => <button type="button" key={emoji} onClick={() => addEmoji(emoji)}>{emoji}</button>)}
              </div>}
            </div>
            <textarea
              ref={textareaRef}
              id="peer-chat-message"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void sendMessage(draft);
                }
              }}
              onInput={event => {
                const input = event.currentTarget;
                input.style.height = 'auto';
                input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
              }}
              maxLength={MAX_MESSAGE_LENGTH}
              rows={1}
              placeholder={sending ? 'Broadcasting…' : 'Message the community…'}
              disabled={sending}
              aria-label="Your Peer Chat message"
            />
            <button type="submit" className="pc-send-button" disabled={sending || !draft.trim()} aria-label="Send message">
              {sending ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
            </button>
          </div>
          <p className="pc-composer-footnote">{MAX_MESSAGE_LENGTH - draft.length}/500 characters · Shift+Enter for a new line</p>
        </form>
      </div>
    </section>
    <PeerChatPendingTransactions messages={messages} />
    <PeerChatFeatureCards />
    {showTip && <PeerChatTipDialog
      peers={peers}
      tokens={tokens}
      onClose={() => setShowTip(false)}
      onRefresh={async () => { await onSent(); await onTokenTipSent?.(); }}
    />}
  </div>;
}
