import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import OnChainTradingPage from './TradingPage.jsx';
import Bsv21ToolsPage from './Bsv21ToolsPage.jsx';
import PeerChatPage from './PeerChatPage.jsx';
import MailPage from './MailPage.jsx';
import UtxoStorePanel from './UtxoStorePanel.jsx';
import BsvLogo from './BsvLogo.jsx';
import BsvText from './BsvText.jsx';
import TokenIcon from './TokenIcon.jsx';
import ExplorerReference from './ExplorerReference.jsx';
import lbsxWalletLogo from '../assets/lbsx-wallet-logo.jpeg';
import './branding.css';
import './activity.css';
import {
  Activity, AlertTriangle, ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck,
  Blocks, Check, ChevronDown, CircleHelp, Coins, Copy, Eye, EyeOff, FileClock,
  Fingerprint, KeyRound, LayoutDashboard, LockKeyhole, LogOut, Mail, Menu, MessageCircle,
  Plus, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, Trash2, Wallet, Unlock,
  TrendingUp,
} from 'lucide-react';

function rowKind(row) {
  const type = row.type || '';
  if (type.includes('chat')) return 'chat';
  if (type.includes('import')) return 'import';
  if (type.includes('mint')) return 'mint';
  if (type.includes('lock') || type.includes('unlock')) return 'lock';
  if (type.includes('list') || type.includes('cancel') || type.includes('buy')) return 'trade';
  return 'transfer';
}

function activityIcon(row, isReceive) {
  switch (rowKind(row)) {
    case 'chat': return <MessageCircle size={16} />;
    case 'import': return <Plus size={16} />;
    case 'mint': return <Coins size={16} />;
    case 'lock': return row.type.includes('unlock') ? <Unlock size={16} /> : <LockKeyhole size={16} />;
    case 'trade': return <TrendingUp size={16} />;
    default: return isReceive ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />;
  }
}
const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'send', label: 'Send', icon: ArrowUpRight },
  { id: 'receive', label: 'Receive', icon: ArrowDownLeft },
  { id: 'assets', label: 'Assets', icon: Blocks },
  { id: 'trading', label: 'Trading', icon: TrendingUp },
  { id: 'bsv21-tools', label: 'BSV-21 Tools', icon: Coins },
  { id: 'peer-chat', label: 'Peer Chat', icon: MessageCircle },
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'activity', label: 'Activity', icon: FileClock },
  { id: 'api-key', label: 'API key', icon: KeyRound },
];

const shortAddress = (address = '') => address ? `${address.slice(0, 10)}…${address.slice(-8)}` : '—';
const progressLabel = phase => ({
  downloading: 'Syncing BSV headers',
  reorg: 'Reconciling chain reorganization',
  validating: 'Validating local BSV headers',
  'fetching-wallet-data': 'Fetching wallet balances and UTXOs',
  'scanning-wallet-utxos': 'Scanning wallet outputs',
  'verifying-wallet-data': 'Finishing local header and proof checks',
  'verifying-cash-utxos': 'Verifying spendable BSV outputs',
  'verifying-token-utxos': 'Verifying spendable BSV-21 outputs',
  'saving-wallet-snapshot': 'Saving encrypted wallet snapshot',
  'sync-complete': 'Balance sync complete',
})[phase] || 'Syncing wallet data';
const progressDetail = progress => {
  if (['downloading', 'reorg', 'validating'].includes(progress.phase)) {
    return `${Number(progress.completed || 0).toLocaleString()} / ${Number(progress.total || 0).toLocaleString()} headers${Number.isSafeInteger(progress.height) ? ` · height ${Number(progress.height).toLocaleString()}` : ''}`;
  }
  if (progress.phase === 'scanning-wallet-utxos') {
    return `${Number(progress.count || 0).toLocaleString()} BSV outputs found`;
  }
  if (progress.phase === 'verifying-cash-utxos') {
    return `${Number(progress.completed || 0).toLocaleString()} BSV outputs verified`;
  }
  if (progress.phase === 'verifying-token-utxos') {
    return `${Number(progress.completed || 0).toLocaleString()} / ${Number(progress.total || 0).toLocaleString()} tokens`;
  }
  return '';
};
const peerChatProgressLabel = phase => ({
  'history': 'Reading admin-wallet history',
  'screening': 'Screening admin-wallet transactions',
  'verifying': 'Verifying peer chat messages',
  'paused': 'Peer chat sync paused by the API rate limit',
  'complete': 'Peer chat index up to date',
})[phase] || 'Syncing peer chat messages';
const peerChatProgressDetail = progress => {
  if (!progress) return '';
  const checked = Number(progress.checked || 0).toLocaleString();
  const total = Number(progress.total || 0).toLocaleString();
  if (progress.phase === 'verifying') {
    const candidates = Number(progress.candidates || 0).toLocaleString();
    const verified = Number(progress.verified || 0).toLocaleString();
    return `${verified} of ${candidates} messages verified · ${checked} of ${total} transactions checked`;
  }
  return `${checked} of ${total} transactions checked`;
};
const activityProgressLabel = phase => ({
  'activity-reconciling': 'Checking locally saved wallet records',
  'activity-history-page': 'Reading wallet history from BananaBlocks',
  'activity-unconfirmed-history': 'Reading unconfirmed wallet history',
  'activity-loading-transactions': 'Loading transaction details',
  'activity-checking-pending': 'Checking pending transaction statuses',
  'activity-refreshing-utxos': 'Refreshing the UTXO snapshot',
  'activity-saving': 'Saving encrypted wallet history',
  'activity-complete': 'Wallet history refresh complete',
})[phase] || 'Refreshing wallet history';
const activityProgressDetail = progress => {
  if (!progress) return '';
  if (progress.phase === 'activity-history-page') {
    return `Page ${Number(progress.completed || 0).toLocaleString()} read · ${Number(progress.count || 0).toLocaleString()} transactions found`;
  }
  if (progress.phase === 'activity-unconfirmed-history') {
    return `${Number(progress.count || 0).toLocaleString()} transactions found so far`;
  }
  if (progress.phase === 'activity-loading-transactions') {
    const total = Number(progress.total || 0);
    return total > 0
      ? `${Number(progress.completed || 0).toLocaleString()} / ${total.toLocaleString()} transactions loaded`
      : 'Loading transaction details';
  }
  if (progress.phase === 'activity-complete') {
    if (progress.rateLimited) return 'BananaBlocks rate limited the request. Progress was saved — refresh again to continue.';
    const remaining = Number(progress.remaining || 0);
    return remaining > 0
      ? `${Number(progress.completed || 0).toLocaleString()} transactions saved · ${remaining.toLocaleString()} still queued`
      : `${Number(progress.completed || 0).toLocaleString()} transactions saved`;
  }
  return '';
};
const PENDING_STATUS_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const formatUnits = (raw, decimals) => {
  try {
    const amount = BigInt(raw || '0');
    const scale = 10n ** BigInt(decimals);
    const whole = amount / scale;
    const remainder = amount % scale;
    if (!decimals || remainder === 0n) return whole.toLocaleString('en-US');
    return `${whole.toLocaleString('en-US')}.${remainder.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
  } catch { return '—'; }
};
const formatSatoshis = (raw) => {
  try {
    const amount = BigInt(raw || '0');
    const whole = amount / 100000000n;
    const fraction = (amount % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
    return fraction ? `${whole.toLocaleString('en-US')}.${fraction}` : whole.toLocaleString('en-US');
  } catch { return '—'; }
};
const sanitizeBsvAmount = (value) => {
  const cleaned = String(value).replace(/,/g, '.').replace(/[^\d.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  return rest.length ? `${whole}.${rest.join('').slice(0, 8)}` : whole;
};
const minimumBsvAmount = (value) => {
  const text = String(value).trim();
  if (!text || text === '.') return '';
  return /^0*\.?0*$/.test(text) ? '0.00000001' : text;
};
const sanitizeTokenAmount = (value, decimals) => {
  const cleaned = String(value).replace(/,/g, '.').replace(/[^\d.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  if (!decimals) return whole;
  return rest.length ? `${whole}.${rest.join('').slice(0, decimals)}` : whole;
};
const tokenAmountToBase = (value, decimals) => {
  const text = String(value).trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
};

export default function App() {
  const [vaultExists, setVaultExists] = useState(null);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [deviceProtectionAvailable, setDeviceProtectionAvailable] = useState(false);
  const [wallet, setWallet] = useState(null);
  const [page, setPage] = useState('overview');
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [protectWithPassword, setProtectWithPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState(false);
  const [chainSnapshot, setChainSnapshot] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const balanceSyncingRef = useRef(false);
  const [syncError, setSyncError] = useState('');
  const [spvProgress, setSpvProgress] = useState(null);
  const [activityProgress, setActivityProgress] = useState(null);
  const [activitySnapshot, setActivitySnapshot] = useState(null);
  const [activitySyncing, setActivitySyncing] = useState(false);
  const [pendingStatusChecking, setPendingStatusChecking] = useState(false);
  const pendingStatusCheckingRef = useRef(false);
  const pendingStatusRetryAtRef = useRef(0);
  const [activityError, setActivityError] = useState('');
  const [assetAction, setAssetAction] = useState(null);
  const [tradingSnapshot, setTradingSnapshot] = useState(null);
  const [tradingSyncing, setTradingSyncing] = useState(false);
  const [tradingError, setTradingError] = useState('');
  const [peerChatSnapshot, setPeerChatSnapshot] = useState(null);
  const [peerChatSyncing, setPeerChatSyncing] = useState(false);
  const [peerChatError, setPeerChatError] = useState('');
  const [peerChatNotice, setPeerChatNotice] = useState('');
  const [peerChatProgress, setPeerChatProgress] = useState(null);
  const [mailSnapshot, setMailSnapshot] = useState(null);
  // The LOCAL drafts. They live in the encrypted wallet data, so they are
  // loaded from the main process like the mailbox itself.
  const [mailDrafts, setMailDrafts] = useState([]);
  const [mailContacts, setMailContacts] = useState([]);
  const [mailOwnCard, setMailOwnCard] = useState(null);
  const [mailSyncing, setMailSyncing] = useState(false);
  const [mailError, setMailError] = useState('');

  const syncTrading = async () => {
    setTradingSyncing(true);
    setTradingError('');
    try { setTradingSnapshot(await window.lbsx.syncTradingDiscovery()); }
    catch (e) { setTradingError(e.message || 'Could not sync the on-chain trading feed.'); }
    finally { setTradingSyncing(false); }
  };

  useEffect(() => {
    if (!wallet) return;
    window.lbsx.getTradingDiscoveryCache().then(setTradingSnapshot).catch(() => {});
  }, [wallet]);

  useEffect(() => {
    if (!wallet) {
      setPeerChatSnapshot(null);
      setPeerChatError('');
      return undefined;
    }
    let active = true;
    setPeerChatError('');
    window.lbsx.getPeerChatSnapshot()
      .then(snapshot => { if (active) setPeerChatSnapshot(snapshot); })
      .catch(error => { if (active) setPeerChatError(error.message || 'Could not load encrypted local peer chat.'); });
    return () => { active = false; };
  }, [wallet]);

  useEffect(() => {
    if (!wallet) {
      setSpvProgress(null);
      return undefined;
    }
    return window.lbsx.onSpvProgress(progress => {
      if (progress?.phase === 'complete') {
        setSpvProgress(balanceSyncingRef.current ? { phase: 'verifying-wallet-data', completed: 0, total: 0 } : null);
      } else setSpvProgress(progress);
    });
  }, [wallet]);

  useEffect(() => {
    if (!wallet) {
      setActivityProgress(null);
      return undefined;
    }
    return window.lbsx.onActivityProgress(progress => {
      if (!progress?.phase) return;
      setActivityProgress(progress);
    });
  }, [wallet]);

  useEffect(() => {
    if (!wallet) {
      setPeerChatProgress(null);
      return undefined;
    }
    return window.lbsx.onPeerChatProgress(progress => {
      if (!progress?.phase) return;
      setPeerChatProgress(progress);
    });
  }, [wallet]);

  useEffect(() => {
    if (activityProgress?.phase !== 'activity-complete') return undefined;
    const timer = setTimeout(() => setActivityProgress(null), 5000);
    return () => clearTimeout(timer);
  }, [activityProgress]);

  useEffect(() => {
    if (!wallet) {
      setActivitySnapshot(null);
      return undefined;
    }
    let active = true;
    setActivityError('');
    window.lbsx.getWalletActivity()
      .then(snapshot => {
        if (!active) return;
        setActivitySnapshot(snapshot);
        setChainSnapshot(snapshot.chainSnapshot || null);
      })
      .catch(error => { if (active) setActivityError(error.message || 'Could not load encrypted local activity.'); });
    return () => { active = false; };
  }, [wallet]);

  const syncBalances = async () => {
    balanceSyncingRef.current = true;
    setSyncing(true);
    setSyncError('');
    setActivityError('');
    setSpvProgress({ phase: 'fetching-wallet-data', completed: 0, total: 1 });
    try {
      const result = await window.lbsx.syncBalances();
      setChainSnapshot(result);
      const failures = Object.values(result.errors || {}).filter(Boolean);
      if (failures.length) setSyncError(failures.join(' '));
      else setSyncError('');
      try {
        const activity = await window.lbsx.getWalletActivity();
        setActivitySnapshot(activity);
      } catch (error) {
        setActivityError(error.message || 'Could not reload locally saved wallet activity.');
      }
      return result;
    } catch (e) {
      setSyncError(e.message || 'Could not sync balances. Check your internet connection and retry.');
      return null;
    } finally {
      balanceSyncingRef.current = false;
      setSyncing(false);
      setSpvProgress(null);
    }
  };

  const syncActivity = async () => {
    setActivitySyncing(true);
    setActivityError('');
    setActivityProgress({ phase: 'activity-reconciling', completed: 0, total: 0 });
    try {
      const snapshot = await window.lbsx.syncWalletActivity();
      setActivitySnapshot(snapshot);
      if (snapshot.errors?.length) setActivityError(snapshot.errors.join(' '));
    } catch (e) {
      setActivityError(e.message || 'Could not sync wallet activity. Check your internet connection and retry.');
      setActivityProgress(null);
    } finally { setActivitySyncing(false); }
  };

  const checkPendingStatuses = async () => {
    if (pendingStatusCheckingRef.current) return null;
    pendingStatusCheckingRef.current = true;
    setPendingStatusChecking(true);
    setActivityError('');
    try {
      const snapshot = await window.lbsx.checkPendingTransactionStatuses();
      setActivitySnapshot(snapshot);
      if (snapshot.errors?.length) {
        pendingStatusRetryAtRef.current = Date.now() + 60 * 1000;
        setActivityError(snapshot.errors.join(' '));
      } else {
        pendingStatusRetryAtRef.current = 0;
        setActivityError('');
      }
      return snapshot;
    } catch (error) {
      pendingStatusRetryAtRef.current = Date.now() + 60 * 1000;
      setActivityError(error.message || 'Could not check pending transaction statuses.');
      return null;
    } finally {
      pendingStatusCheckingRef.current = false;
      setPendingStatusChecking(false);
    }
  };

  useEffect(() => {
    if (!wallet || !activitySnapshot || pendingStatusChecking || activitySyncing) return undefined;
    const pending = (activitySnapshot.activities || []).filter(row => row.status === 'unconfirmed' && row.txid);
    if (!pending.length) return undefined;

    const checkedAt = Date.parse(activitySnapshot.transactionStatusCheckedAt || '');
    const newestPendingAt = Math.max(...pending.map(row => {
      const timestamp = Date.parse(row.timestamp);
      return Number.isFinite(timestamp) ? timestamp : 0;
    }));
    const newPendingTransaction = Number.isFinite(checkedAt) && newestPendingAt > checkedAt;
    const elapsed = Number.isFinite(checkedAt) ? Date.now() - checkedAt : Infinity;
    const statusDelay = newPendingTransaction ? 0 : Math.max(0, PENDING_STATUS_CHECK_INTERVAL_MS - elapsed);
    const retryDelay = Math.max(0, pendingStatusRetryAtRef.current - Date.now());
    const delay = Math.max(statusDelay, retryDelay);
    const timer = setTimeout(() => { void checkPendingStatuses(); }, delay);
    return () => clearTimeout(timer);
  }, [wallet, activitySnapshot, pendingStatusChecking, activitySyncing]);

  const syncPeerChat = async () => {
    setPeerChatSyncing(true);
    setPeerChatError('');
    setPeerChatNotice('');
    try {
      const snapshot = await window.lbsx.syncPeerChat();
      setPeerChatSnapshot(snapshot);
      setPeerChatNotice((snapshot.errors || []).join(' '));
      return snapshot;
    } catch (error) {
      setPeerChatError(error.message || 'Could not sync the LBSX peer chat index.');
      return null;
    } finally { setPeerChatSyncing(false); setPeerChatProgress(null); }
  };

  const refreshPeerChat = async () => {
    try {
      setPeerChatSnapshot(await window.lbsx.getPeerChatSnapshot());
    } catch (error) {
      setPeerChatError(error.message || 'The message was broadcast, but the encrypted local chat cache could not be reloaded.');
    }
  };

  useEffect(() => {
    if (!wallet) {
      setMailSnapshot(null);
      setMailContacts([]);
      setMailOwnCard(null);
      setMailError('');
      return undefined;
    }
    let active = true;
    setMailError('');
    Promise.all([
      window.lbsx.getMail(),
      window.lbsx.getMailContacts(),
      window.lbsx.getOwnMailCard(),
      window.lbsx.getMailDrafts(),
    ]).then(([snapshot, contacts, card, draftList]) => {
      if (!active) return;
      setMailSnapshot(snapshot);
      setMailContacts(contacts || []);
      setMailOwnCard(card || null);
      setMailDrafts(draftList?.drafts || []);
    }).catch(error => {
      if (active) setMailError(error.message || 'Could not load the encrypted mail cache.');
    });
    return () => { active = false; };
  }, [wallet]);

  const syncMail = async () => {
    setMailSyncing(true);
    setMailError('');
    try {
      const snapshot = await window.lbsx.syncMail();
      setMailSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      setMailError(error.message || 'Could not sync the encrypted mailbox.');
      return null;
    } finally { setMailSyncing(false); }
  };

  const refreshMail = async () => {
    try {
      const [snapshot, contacts, draftList] = await Promise.all([
        window.lbsx.getMail(),
        window.lbsx.getMailContacts(),
        window.lbsx.getMailDrafts(),
      ]);
      setMailSnapshot(snapshot);
      setMailContacts(contacts || []);
      setMailDrafts(draftList?.drafts || []);
    } catch (error) {
      setMailError(error.message || 'The mail was broadcast, but the encrypted local mailbox could not be reloaded.');
    }
  };

  // Reloads the LOCAL drafts. Drafts live in the encrypted wallet data, so
  // they are re-read from the main process rather than kept in page state.
  const refreshMailDrafts = async () => {
    try {
      const draftList = await window.lbsx.getMailDrafts();
      setMailDrafts(draftList?.drafts || []);
    } catch (error) {
      setMailError(error.message || 'The drafts could not be reloaded.');
    }
  };

  const refreshMailContacts = async () => {
    try {
      setMailContacts(await window.lbsx.getMailContacts());
    } catch (error) {
      setMailError(error.message || 'The contact list could not be reloaded.');
    }
  };

  const refreshLocalSnapshots = async () => {
    try {
      const snapshot = await window.lbsx.getWalletActivity();
      setActivitySnapshot(snapshot);
      setChainSnapshot(snapshot.chainSnapshot || null);
    } catch (error) {
      setActivityError(error.message || 'The token was created, but the local wallet snapshot could not be reloaded.');
    }
  };

  const refreshAfterWalletAction = async () => {
    await refreshLocalSnapshots();
    await syncBalances();
  };

  useEffect(() => {
    window.lbsx.vaultStatus()
      .then(({ exists, requiresPassword: passwordRequired, deviceProtectionAvailable: deviceAvailable, wallet: activeWallet }) => {
        setVaultExists(exists);
        setRequiresPassword(passwordRequired);
        setDeviceProtectionAvailable(deviceAvailable);
        if (activeWallet) setWallet(activeWallet);
      })
      .catch((e) => { setError(e.message || 'Could not open the local wallet vault.'); setVaultExists(false); });
  }, []);

  const clearEntry = () => {
    setPhrase('');
    setPassword('');
    setConfirmPassword('');
  };

  const importWallet = async (event) => {
    event.preventDefault();
    setError('');
    if (protectWithPassword && password !== confirmPassword) return setError('Those passwords do not match.');
    setBusy(true);
    try {
      const result = await window.lbsx.importSeedPhrase({ mnemonic: phrase, password: protectWithPassword ? password : '' });
      setWallet(result.wallet);
      setVaultExists(true);
      setRequiresPassword(result.requiresPassword);
      clearEntry();
    } catch (e) {
      setError(e.message || 'Could not import this recovery phrase.');
    } finally { setBusy(false); }
  };

  const unlockWallet = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await window.lbsx.unlock({ password });
      setWallet(result.wallet);
      setRequiresPassword(result.requiresPassword);
      clearEntry();
    } catch (e) {
      setError(e.message || 'Could not unlock the local vault.');
    } finally { setBusy(false); }
  };

  const lockWallet = async () => {
    await window.lbsx.lock();
    setWallet(null);
    setChainSnapshot(null);
    setActivitySnapshot(null);
    setTradingSnapshot(null);
    setPeerChatSnapshot(null);
    setMailSnapshot(null);
    setMailContacts([]);
    setMailOwnCard(null);
    setPage('overview');
    clearEntry();
  };

  const deleteWallet = async () => {
    await window.lbsx.deleteWallet();
    setWallet(null);
    setVaultExists(false);
    setRequiresPassword(false);
    setChainSnapshot(null);
    setActivitySnapshot(null);
    setTradingSnapshot(null);
    setPeerChatSnapshot(null);
    setMailSnapshot(null);
    setMailContacts([]);
    setMailOwnCard(null);
    setDeletePrompt(false);
    setPage('overview');
    clearEntry();
    // OS key-store availability is a property of the machine, not of the wallet, so re-read it
    // instead of assuming it disappeared along with the vault.
    const status = await window.lbsx.vaultStatus().catch(() => null);
    setDeviceProtectionAvailable(Boolean(status?.deviceProtectionAvailable));
  };

  const copyAddress = async () => {
    if (!wallet?.address) return;
    await navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (vaultExists === null) return <div className="boot-screen"><img className="brand-logo boot-logo" src={lbsxWalletLogo} alt="" aria-hidden="true" /><span>Opening local vault…</span></div>;
  if (!wallet) {
    return <VaultGate
      hasVault={vaultExists}
      requiresPassword={requiresPassword}
      deviceProtectionAvailable={deviceProtectionAvailable}
      phrase={phrase} setPhrase={setPhrase}
      password={password} setPassword={setPassword}
      confirmPassword={confirmPassword} setConfirmPassword={setConfirmPassword}
      showPassword={showPassword} setShowPassword={setShowPassword}
      protectWithPassword={protectWithPassword} setProtectWithPassword={setProtectWithPassword}
      error={error} busy={busy}
      onImport={importWallet} onUnlock={unlockWallet}
    />;
  }

  const activePage = page === 'security' ? 'security' : page;
  const pageTitle = ({ overview: 'My BSV Wallet', assets: 'Your assets', trading: 'Peer trading', 'bsv21-tools': 'BSV-21 Tools', 'peer-chat': 'Peer Chat', email: 'Email', send: 'Send BSV', receive: 'Receive BSV', activity: 'Activity', security: 'Security center', 'api-key': 'BananaBlocks API' })[activePage];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup"><img className="brand-logo" src={lbsxWalletLogo} alt="" aria-hidden="true" /><div><b>LBSX</b><small>DESKTOP WALLET</small></div></div>
        <div className="profile-chip"><div className="coin-badge"><BsvLogo /></div><div><strong>My BSV Wallet</strong><span>Local vault · Mainnet</span></div><ChevronDown size={15} /></div>
        <div className="nav-caption">WALLET</div>
        <nav className="primary-nav" aria-label="Wallet navigation">
          {nav.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => { setPage(id); setMobileNav(false); }}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{id === 'activity' && <span className="nav-soon">LOCAL</span>}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-shortcut"><div className="shield-icon"><ShieldCheck size={17} /></div><div><b>Keys stay on this device</b><span>Encrypted local vault</span></div></div>
          <button className={`nav-item ${page === 'security' ? 'active' : ''}`} onClick={() => { setPage('security'); setMobileNav(false); }}><Settings2 size={17} /><span>Security</span></button>
          <div className="sidebar-foot"><span className="status-dot" /> Local-only mode <span className="version">v2.1.20</span></div>
        </div>
      </aside>

      {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
      <main className={`main-area ${page === 'peer-chat' ? 'main-area-peer-chat' : ''} ${page === 'email' ? 'main-area-wide' : ''}`}>
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle menu"><Menu size={19} /></button>
          <div className="breadcrumb"><span>Wallet</span><span className="crumb-slash">/</span><b>{pageTitle}</b></div>
          <div className="top-actions">
            {/* The BSV BALANCE, on every tab except Overview. The Overview page
                already shows the balance in full, so repeating it there would
                be noise - on the other tabs it is the one number a user wants
                always on screen, next to the network they are on. */}
            {page !== 'overview' && <div className="balance-chip" title={chainSnapshot?.balance ? `Confirmed ${chainSnapshot.balance.confirmed} sats · Pending ${chainSnapshot.balance.unconfirmed} sats` : 'Sync balances to read your on-chain balance'}>
              <span className="balance-chip-amount">
                {chainSnapshot?.balance
                  ? formatSatoshis((BigInt(chainSnapshot.balance.confirmed) + BigInt(chainSnapshot.balance.unconfirmed)).toString())
                  : '—'}
              </span>
              <span className="balance-chip-ticker">BSV</span>
            </div>}
            <div className="network-chip"><span className="status-dot" /> BSV Mainnet</div>
            <button className="lock-button" onClick={lockWallet}><LockKeyhole size={15} /><span>Lock wallet</span></button>
          </div>
        </header>

        <div className="page-content">
          {spvProgress && <div className="spv-progress" role="status">
            <div>
              <b>{progressLabel(spvProgress.phase)}</b>
              <span>{progressDetail(spvProgress)}</span>
            </div>
            <progress max={Math.max(1, Number(spvProgress.total || 1))} {...(spvProgress.total > 0 ? { value: Math.min(Number(spvProgress.completed || 0), Number(spvProgress.total)) } : {})} />
          </div>}
          {activityProgress && <div className="spv-progress" role="status">
            <div>
              <b>{activityProgressLabel(activityProgress.phase)}</b>
              <span>{activityProgressDetail(activityProgress)}</span>
            </div>
            <progress max={Math.max(1, Number(activityProgress.total || 1))} {...(activityProgress.total > 0 ? { value: Math.min(Number(activityProgress.completed || 0), Number(activityProgress.total)) } : {})} />
          </div>}
          {peerChatProgress && <div className="spv-progress" role="status">
            <div>
              <b>{peerChatProgressLabel(peerChatProgress.phase)}</b>
              <span>{peerChatProgressDetail(peerChatProgress)}</span>
            </div>
            <progress max={Math.max(1, Number(peerChatProgress.total || 1))} {...(peerChatProgress.total > 0 ? { value: Math.min(Number(peerChatProgress.checked || 0), Number(peerChatProgress.total)) } : {})} />
          </div>}
          {page === 'overview' && <Overview wallet={wallet} onGo={setPage} onCopy={copyAddress} copied={copied} snapshot={chainSnapshot} activitySnapshot={activitySnapshot} syncing={syncing} syncError={syncError} onSync={syncBalances} />}
          {page === 'assets' && <Assets snapshot={chainSnapshot} syncing={syncing} syncError={syncError} onSync={syncBalances} onAction={(type, token) => setAssetAction({ type, token })} />}
          {page === 'trading' && <OnChainTradingPage tokens={chainSnapshot?.tokens || []} bsvBalance={chainSnapshot?.balance || null} address={wallet.address} onSyncAssets={syncBalances} assetsSyncing={syncing} discoveredOrders={tradingSnapshot?.discoveredOrders || []} discoverySyncedAt={tradingSnapshot?.syncedAt} discoverySyncing={tradingSyncing} discoveryError={tradingError} onSyncDiscovery={syncTrading} />}
          {page === 'bsv21-tools' && <Bsv21ToolsPage balance={chainSnapshot?.balance || null} onMinted={refreshLocalSnapshots} />}
          {page === 'peer-chat' && <PeerChatPage wallet={wallet} snapshot={peerChatSnapshot} tokens={chainSnapshot?.tokens || []} syncing={peerChatSyncing} error={peerChatError} notice={peerChatNotice} status={peerChatProgress || peerChatSnapshot?.status || null} onSync={syncPeerChat} onSent={refreshPeerChat} onGo={setPage} onTokenTipSent={refreshAfterWalletAction} />}
          {page === 'email' && <MailPage wallet={wallet} snapshot={mailSnapshot} contacts={mailContacts} ownCard={mailOwnCard} drafts={mailDrafts} syncing={mailSyncing} error={mailError} onSync={syncMail} onSent={refreshMail} onContactsChanged={refreshMailContacts} onDraftsChanged={refreshMailDrafts} />}
          {page === 'send' && <ActionPage wallet={wallet} balance={chainSnapshot?.balance} syncing={syncing} onSync={syncBalances} onSent={refreshAfterWalletAction} />}
          {page === 'receive' && <Receive wallet={wallet} onCopy={copyAddress} copied={copied} />}
          {page === 'activity' && <ActivityPage snapshot={activitySnapshot} chainSnapshot={chainSnapshot} tokens={chainSnapshot?.tokens || []} syncing={activitySyncing} balanceSyncing={syncing} checkingPending={pendingStatusChecking} error={activityError} balanceError={syncError} onSync={syncActivity} onSyncBalances={syncBalances} onCheckPending={checkPendingStatuses} />}
          {page === 'security' && <Security wallet={wallet} onCopy={copyAddress} copied={copied} onLock={lockWallet} onDelete={() => setDeletePrompt(true)} />}
          {page === 'api-key' && <BananaBlocksApiPage />}
        </div>
      </main>
      {assetAction && <TokenActionModal key={`${assetAction.type}:${assetAction.token.tokenId}`} action={assetAction} wallet={wallet} onClose={() => setAssetAction(null)} onChanged={refreshAfterWalletAction} onRepair={syncBalances} />}
      {deletePrompt && <DeleteWalletModal wallet={wallet} onClose={() => setDeletePrompt(false)} onConfirm={deleteWallet} />}
    </div>
  );
}

function VaultGate({ hasVault, requiresPassword, deviceProtectionAvailable, phrase, setPhrase, password, setPassword, confirmPassword, setConfirmPassword, showPassword, setShowPassword, protectWithPassword, setProtectWithPassword, error, busy, onImport, onUnlock }) {
  const passwordMode = hasVault ? requiresPassword : protectWithPassword;
  return (
    <div className="gate-shell">
      <div className="gate-glow" />
      <div className="gate-brand"><img className="brand-logo" src={lbsxWalletLogo} alt="" aria-hidden="true" /><div><b>LBSX</b><span>DESKTOP WALLET</span></div></div>
      <div className="gate-card">
        <div className="gate-icon"><LockKeyhole size={23} /></div>
        <div className="eyebrow">SELF-CUSTODY · LOCAL ENCRYPTION</div>
        <h1>{hasVault ? 'Welcome back' : 'Import your wallet'}</h1>
        <p className="gate-copy">{hasVault ? (requiresPassword ? 'Enter your vault password to open your wallet.' : 'Your wallet is protected by this computer and ready to open.') : 'Start by importing an existing BIP39 recovery phrase. It stays on this computer and is never sent to a server.'}</p>
        <form onSubmit={hasVault ? onUnlock : onImport} className="gate-form">
          {!hasVault && <label className="field-label">Recovery phrase<textarea value={phrase} onChange={e => setPhrase(e.target.value)} placeholder="Enter your existing 12, 18, or 24 word phrase" rows={3} autoComplete="off" spellCheck="false" required /></label>}
          {!hasVault && <div className="protection-options">
            <button type="button" className={`protection-option ${!protectWithPassword ? 'selected' : ''}`} onClick={() => setProtectWithPassword(false)} disabled={!deviceProtectionAvailable}>
              <span className="option-radio" /> <span><b>Use this computer</b><small>No password; protected by your OS account</small></span>
            </button>
            <button type="button" className={`protection-option ${protectWithPassword ? 'selected' : ''}`} onClick={() => setProtectWithPassword(true)}>
              <span className="option-radio" /> <span><b>Set a vault password</b><small>Ask for it every time you open the app</small></span>
            </button>
          </div>}
          {!hasVault && !deviceProtectionAvailable && !protectWithPassword && <div className="form-error">This computer has no secure OS key store available. Choose a vault password to protect the wallet.</div>}
          {passwordMode && <label className="field-label">{hasVault ? 'Vault password' : 'Create a vault password'}
            <div className="password-wrap"><input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={hasVault ? 'Enter your password' : 'At least 12 characters'} autoComplete={hasVault ? 'current-password' : 'new-password'} required minLength={12} /><button type="button" className="reveal-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
          </label>}
          {!hasVault && protectWithPassword && <label className="field-label">Confirm vault password<input type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter your password" autoComplete="new-password" required minLength={12} /></label>}
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button gate-submit" type="submit" disabled={busy || (!hasVault && !phrase.trim()) || (!hasVault && !protectWithPassword && !deviceProtectionAvailable)}>{busy ? <><RefreshCw size={16} className="spin" />{hasVault ? 'Opening…' : 'Securing wallet…'}</> : <>{hasVault ? <LockKeyhole size={16} /> : <KeyRound size={16} />}{hasVault ? (requiresPassword ? 'Unlock wallet' : 'Open wallet') : 'Import wallet'}</>}</button>
        </form>
        <div className="gate-divider"><span /></div>
        <div className="gate-trust"><span><ShieldCheck size={15} /> {passwordMode ? 'Encrypted with your password' : 'Protected by this computer'} </span><span><Fingerprint size={15} /> Keys are derived on this device</span></div>
        <p className="gate-note">{hasVault && requiresPassword ? 'Your vault password cannot be recovered. Keep a separate offline backup of your recovery phrase.' : 'Keep a separate offline backup of your recovery phrase. Passwordless wallets open automatically for this OS account.'}</p>
      </div>
      <div className="gate-footer"><span className="status-dot" /> LBSX WALLET · LOCAL KEY CUSTODY · IMPORT ONLY</div>
    </div>
  );
}

function AddressQr({ address, size = 200, className = '' }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    setSrc('');
    if (address) QRCode.toDataURL(address, { width: size * 2, margin: 1, color: { dark: '#14201a', light: '#ffffff' } })
      .then(url => { if (active) setSrc(url); }).catch(() => {});
    return () => { active = false; };
  }, [address, size]);
  return <div className={`address-qr ${className}`.trim()}>{src ? <img src={src} width={size} height={size} alt="QR code for your BSV address" /> : null}</div>;
}

function Overview({ wallet, onGo, onCopy, copied, snapshot, activitySnapshot, syncing, syncError, onSync }) {
  const totalSatoshis = snapshot?.balance
    ? (BigInt(snapshot.balance.confirmed) + BigInt(snapshot.balance.unconfirmed)).toString()
    : null;
  const recentActivity = activitySnapshot?.activities?.slice(0, 3) || [];
  return <>
    <div className="page-heading overview-heading"><div><div className="eyebrow">PERSONAL WALLET</div><h1>Good to see you.</h1><p className="overview-sync-copy">Balances sync from BananaBlocks using your public address only. Your recovery phrase and private keys never leave this device.</p></div><div className="heading-actions"><button className="secondary-button" onClick={onSync} disabled={syncing}><RefreshCw size={15} className={syncing ? 'spin' : ''} /> {syncing ? 'Syncing…' : 'Sync balances'}</button><button className="secondary-button" onClick={() => onGo('security')}><ShieldCheck size={16} /> Security center</button></div></div>
    <section className="balance-card">
      <div className="balance-card-top"><div className="balance-head"><span className="muted-label">TOTAL BALANCE</span><span className="sync-badge"><span className="status-dot" /> {snapshot ? `Synced ${new Date(snapshot.syncedAt).toLocaleTimeString()}` : 'Not synced yet'}</span></div>      <div className="balance-card-marks"><AddressQr address={wallet.address} size={104} /><div className="bsv-coin"><BsvLogo /></div></div></div>
      <div className="balance-number">{totalSatoshis === null ? '—' : formatSatoshis(totalSatoshis)} <span className="bsv-ticker">BSV</span></div><div className="balance-usd">{snapshot?.balance ? <><span className="balance-chip"><i className="chip-dot confirmed" />Confirmed <b>{formatSatoshis(snapshot.balance.confirmed)}</b></span><span className="balance-chip"><i className="chip-dot pending" />Pending <b>{formatSatoshis(snapshot.balance.unconfirmed)}</b></span></> : 'Choose Sync balances to read your on-chain balance'}</div>
      <div className="balance-divider" />
      <div className="wallet-address"><div><span className="muted-label">YOUR BSV ADDRESS</span><code className="wallet-address-full" title={wallet.address}>{wallet.address}</code></div><button className="copy-button" onClick={onCopy}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy'}</button></div>
      <div className="card-actions"><button className="primary-button" onClick={() => onGo('send')}><Send size={16} /> Send</button><button className="light-button" onClick={() => onGo('receive')}><ArrowDownLeft size={16} /> Receive</button><button className="light-button" onClick={() => onGo('assets')}><Blocks size={16} /> Tokens</button></div>
    </section>
    <section className="quick-grid">
      <div className="surface-card"><div className="section-title-row"><div><span className="muted-label">PORTFOLIO</span><h2>Your assets</h2></div><button className="text-link" onClick={() => onGo('assets')}>View all <ArrowRight size={14} /></button></div>{snapshot?.tokens?.length ? <TokenRows tokens={snapshot.tokens.slice(0, 3)} /> : <div className="empty-asset"><div className="empty-icon"><Blocks size={18} /></div><div><b>{snapshot ? 'No BSV-21 balances found' : 'Token balances not synced'}</b><span>Sync balances to read BSV-21 holdings for this address.</span></div></div>}</div>
      <div className="surface-card activity-card"><div className="section-title-row"><div><span className="muted-label">RECENT</span><h2>Activity</h2></div><button className="text-link" onClick={() => onGo('activity')}>History <ArrowRight size={14} /></button></div>{recentActivity.length ? <div className="overview-activity-list">{recentActivity.map(row => <div className="overview-activity-row" key={row.id}><div className="activity-ring">{row.type?.includes('receive') ? <ArrowDownLeft size={15} /> : <Activity size={15} />}</div><div><b>{row.title}</b><span>{new Date(row.timestamp).toLocaleString()} · {row.status}</span>{row.txid && <ExplorerReference value={row.txid} compact className="overview-activity-reference" />}</div></div>)}</div> : <div className="empty-activity"><div className="activity-ring"><Activity size={17} /></div><div><b>{activitySnapshot?.syncedAt ? 'No activity found' : 'No activity synced'}</b><span>{activitySnapshot?.syncedAt ? 'Refresh Activity to check for new wallet transactions.' : 'Refresh Activity to sync on-chain history and save it locally.'}</span></div></div>}<div className="chain-note"><div className="chain-pulse" /><span>Encrypted local wallet data</span><span className="chain-note-right">{shortAddress(wallet.address)}</span></div></div>
    </section>
    {syncError && <div className="sync-error">{syncError}</div>}
    <LocalNotice />
  </>;
}

function TokenRows({ tokens, onAction, compact = false }) {
  return <div className="token-list">{tokens.map(token => <div className={`token-row ${compact ? 'token-row-compact' : ''}`} key={token.tokenId}>
    <div className="token-icon"><TokenIcon token={token} /></div>
    <div className="token-info"><div className="token-name-line"><b>{token.symbol}</b><span className="token-decimals-badge">{token.decimals ?? 0} decimals</span></div><ExplorerReference value={token.tokenId} kind="token" compact={compact} className="token-reference" /></div>
    <strong>{formatUnits(token.balance, token.decimals)}</strong>
    {onAction && <div className="token-actions">
      <button onClick={() => onAction('send', token)}><Send size={13} /> Send</button>
      <button onClick={() => onAction('receive', token)}><ArrowDownLeft size={13} /> Receive</button>
      <button onClick={() => onAction('locker', token)}><LockKeyhole size={13} /> Locker</button>
    </div>}
  </div>)}</div>;
}

function Assets({ snapshot, syncing, syncError, onSync, onAction }) {
  const canRepairTokenVerification = /SPV|header.chain|verified spendable output|BEEF/i.test(syncError || '');
  return <>
    <div className="page-heading">
      <div><div className="eyebrow">BSV-21 PORTFOLIO</div><h1>Your assets</h1><p>Send, receive, and time-lock each token from this local wallet.</p></div>
      <button className="secondary-button" onClick={onSync} disabled={syncing}><RefreshCw size={15} className={syncing ? 'spin' : ''} /> {syncing ? 'Syncing…' : 'Sync BSV + tokens'}</button>
    </div>
    <div className="surface-card token-assets-card">
      {syncError && <div className="sync-error" role="alert">
        <div>{syncError}</div>
        {canRepairTokenVerification && <div className="token-repair-panel">
          <span>This rechecks token outputs indexed by BananaBlocks and rebuilds local SPV-verified spend records. Your recovery phrase stays on this device.</span>
          <button type="button" className="secondary-button" onClick={onSync} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? 'spin' : ''} /> {syncing ? 'Repairing token outputs…' : 'Repair token verification'}
          </button>
        </div>}
      </div>}
      {snapshot?.tokens?.length ? <TokenRows tokens={snapshot.tokens} onAction={onAction} /> : <div className="assets-empty"><div className="large-empty-icon"><Blocks size={25} /></div><h2>{snapshot ? 'No BSV-21 token balances' : 'Sync your balances'}</h2><p>Fetch BSV and BSV-21 balances for your derived address. This read-only request does not send your seed phrase.</p></div>}
      <div className="feature-chips"><span>BSV-21 balances</span><span>Optional BananaBlocks API key</span><span>Local locker records</span></div>
    </div>
    <LocalNotice />
  </>;
}

function TokenActionModal({ action, wallet, onClose, onChanged, onRepair }) {
  const { token } = action;
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [schedule, setSchedule] = useState('monthly');
  const [tranches, setTranches] = useState('4');
  const [qr, setQr] = useState('');
  const [locks, setLocks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState('');
  const [reviewingSend, setReviewingSend] = useState(false);
  const [reviewingLock, setReviewingLock] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [txid, setTxid] = useState('');

  useEffect(() => {
    if (action.type === 'receive') {
      QRCode.toDataURL(wallet.address, { width: 240, margin: 2, color: { dark: '#14201a', light: '#ffffff' } }).then(setQr).catch(() => setError('Could not generate the receive QR code.'));
    }
    if (action.type === 'locker') loadLocks();
  }, [action.type, wallet.address, token.tokenId]);

  const loadLocks = async () => {
    try { setLocks(await window.lbsx.getTokenLocks(token.tokenId)); }
    catch (e) { setError(e.message || 'Could not load the local token locker.'); }
  };

  const submitSend = async () => {
    setBusy(true); setError(''); setNotice(''); setTxid('');
    try {
      const result = await window.lbsx.sendToken({ tokenId: token.tokenId, decimals: token.decimals, symbol: token.symbol, amount, recipient });
      setTxid(result.txid);
      setNotice(`Submitted ${result.amount} ${token.symbol} to BananaBlocks.`);
      setReviewingSend(false);
      await onChanged();
    } catch (e) { setError(e.message || 'Token send failed.'); }
    finally { setBusy(false); }
  };

  const submitLock = async () => {
    setBusy(true); setError(''); setNotice(''); setTxid('');
    try {
      const result = await window.lbsx.lockTokens({ tokenId: token.tokenId, decimals: token.decimals, symbol: token.symbol, amount, schedule, tranches: Number(tranches) });
      setTxid(result.txid);
      setNotice(`Locked ${result.totalLocked} ${token.symbol} across ${result.tranches} on-chain tranches.`);
      setAmount('');
      setReviewingLock(false);
      await loadLocks();
      await onChanged();
    } catch (e) { setError(e.message || 'Token lock failed.'); await loadLocks(); }
    finally { setBusy(false); }
  };

  const claim = async (lock) => {
    setClaiming(lock.id); setError(''); setNotice(''); setTxid('');
    try {
      const result = await window.lbsx.claimTokenLock(lock.id);
      setTxid(result.txid);
      setNotice(`Claimed ${result.amount} ${token.symbol} back to this wallet.`);
      await loadLocks();
      await onChanged();
    } catch (e) { setError(e.message || 'Could not claim this token tranche.'); }
    finally { setClaiming(''); }
  };

  const repairTokenVerification = async () => {
    setBusy(true);
    setNotice('');
    try {
      const result = await onRepair();
      if (!result) {
        setError('The repair sync could not complete. Try syncing your assets again.');
        return;
      }
      const failures = Object.values(result.errors || {}).filter(Boolean);
      if (failures.length) {
        setError(`Token verification still needs attention: ${failures.join(' ')}`);
        return;
      }
      setError('');
      setNotice(`BananaBlocks token outputs were rechecked. You can retry sending ${token.symbol}.`);
    } catch (repairError) {
      setError(repairError.message || 'Could not repair local token verification.');
    } finally {
      setBusy(false);
    }
  };

  const isReceive = action.type === 'receive';
  const isLocker = action.type === 'locker';
  const canRepairTokenVerification = /SPV|header.chain|verified spendable output|BEEF/i.test(error || '');
  const title = isReceive ? `Receive ${token.symbol}` : isLocker ? `${token.symbol} Locker` : `Send ${token.symbol}`;
  const now = Math.floor(Date.now() / 1000);
  const activeLocks = locks.filter(lock => lock.status !== 'released' && lock.status !== 'rejected');
  const lockedTotalBase = activeLocks.reduce((sum, lock) => sum + BigInt(lock.amountBase || '0'), 0n);
  const claimableTotalBase = activeLocks.filter(lock => lock.status === 'locked' && lock.unlockTimestamp <= now).reduce((sum, lock) => sum + BigInt(lock.amountBase || '0'), 0n);

  const lockBalanceBase = (() => { try { return BigInt(token.balance || '0'); } catch { return 0n; } })();
  const lockDecimals = Number(token.decimals) || 0;
  const reviewLock = event => {
    event.preventDefault(); setError('');
    const base = tokenAmountToBase(amount, lockDecimals);
    const trancheCount = Number(tranches);
    if (base === null || base <= 0n) return setError(lockDecimals ? `Enter an amount greater than 0 with up to ${lockDecimals} decimal places.` : 'Enter a whole-number amount greater than 0.');
    if (base > lockBalanceBase) return setError(`You only have ${formatUnits(token.balance, token.decimals)} ${token.symbol} available to lock.`);
    if (!Number.isInteger(trancheCount) || trancheCount < 1 || trancheCount > 24) return setError('Choose between 1 and 24 tranches.');
    if (base < BigInt(trancheCount)) return setError(`The amount is too small to split into ${trancheCount} tranches. Each tranche needs at least the smallest unit.`);
    setReviewingLock(true);
  };

  return <div className="modal-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="token-modal" role="dialog" aria-modal="true" aria-labelledby="token-modal-title">
      <header className="token-modal-head"><div><span className="eyebrow">{isLocker ? 'ON-CHAIN CLTV LOCKER' : 'BSV-21 TOKEN'}</span><h2 id="token-modal-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></header>
      {error && <div className="sync-error" role="alert">
        <div>{error}</div>
        {canRepairTokenVerification && <div className="token-repair-panel">
          <span>This rechecks indexed token outputs and rebuilds local SPV-verified spend records. It will not sign or broadcast a transfer.</span>
          <button type="button" className="secondary-button" onClick={repairTokenVerification} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'spin' : ''} /> {busy ? 'Repairing token outputs…' : 'Repair token verification'}
          </button>
        </div>}
      </div>}
      {notice && <div className="token-success">{notice}</div>}
      {txid && <div className="token-txid"><span>Transaction ID</span><ExplorerReference value={txid} /></div>}

      {isReceive && <div className="receive-token-content">
        <div className="qr-frame">{qr ? <img src={qr} alt={`QR code for ${token.symbol} receiving address`} /> : <span>Generating QR…</span>}</div>
        <p>Send <b>{token.symbol}</b> or BSV to this BSV mainnet address.</p>
        <code className="full-address">{wallet.address}</code>
        <button className="primary-button" onClick={() => navigator.clipboard.writeText(wallet.address)}><Copy size={15} /> Copy BSV public address</button>
        <div className="receive-warning"><CircleHelp size={15} /> The QR contains your public address only. Never share your recovery phrase.</div>
      </div>}

      {!isReceive && !isLocker && !reviewingSend && <form className="token-action-form" onSubmit={event => {
        event.preventDefault(); setError('');
        const decimals = Number(token.decimals) || 0;
        const base = tokenAmountToBase(amount, decimals);
        const minimum = decimals ? `0.${'0'.repeat(decimals - 1)}1` : '1';
        if (base === null || base <= 0n) return setError(`Enter an amount of at least ${minimum} ${token.symbol}${decimals ? ` with up to ${decimals} decimal places` : ' (whole numbers only)'}.`);
        if (base > lockBalanceBase) return setError(`You only have ${formatUnits(token.balance, token.decimals)} ${token.symbol} available to send.`);
        setReviewingSend(true);
      }}>
        <div className="token-current-balance"><span>Synced token balance</span><b>{formatUnits(token.balance, token.decimals)} {token.symbol}</b><small>{token.decimals ?? 0} decimal places</small></div>
        <label className="field-label">Recipient BSV address<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="Paste a BSV mainnet address" autoComplete="off" required /></label>
        <label className="field-label">Amount<div className="amount-input"><input value={amount} onChange={event => setAmount(sanitizeTokenAmount(event.target.value, lockDecimals))} onBlur={() => setAmount(current => (current && tokenAmountToBase(current, lockDecimals) === 0n ? (lockDecimals ? `0.${'0'.repeat(lockDecimals - 1)}1` : '1') : current))} placeholder={lockDecimals ? `0.${'0'.repeat(lockDecimals - 1)}1` : '1'} inputMode="decimal" autoComplete="off" required /><button type="button" className="text-link" onClick={() => setAmount(formatUnits(token.balance, token.decimals).replace(/,/g, ''))}>Max</button><span>{token.symbol}</span></div></label>
        <p className="token-modal-warning">This signs a BSV-21 transfer locally and broadcasts it to BananaBlocks. Verify the address and amount before continuing. Keep ordinary BSV in the wallet for network fees.</p>
        <button className="primary-button wide" type="submit"><Check size={15} /> Review transfer</button>
      </form>}
      {!isReceive && !isLocker && reviewingSend && <div className="token-action-form send-review"><h3>Review before broadcast</h3><div><span>Token amount</span><b>{amount} {token.symbol}</b></div><div><span>Recipient address</span><code>{recipient}</code></div><p className="token-modal-warning">This transaction is signed by the local wallet and cannot be reversed. Confirm the full address and amount before broadcasting.</p><div className="review-buttons"><button className="secondary-button" onClick={() => setReviewingSend(false)} disabled={busy}>Back to edit</button><button className="primary-button" onClick={submitSend} disabled={busy}>{busy ? <><RefreshCw size={15} className="spin" /> Signing…</> : <><Send size={15} /> Broadcast transfer</>}</button></div></div>}

      {isLocker && !reviewingLock && <div className="locker-content">
        <div className="locker-summary"><div><span>Claimable</span><b>{formatUnits(String(claimableTotalBase), token.decimals)}</b></div><div><span>Still locked</span><b>{formatUnits(String(lockedTotalBase), token.decimals)}</b></div><div><span>Tranches</span><b>{activeLocks.length}</b></div></div>
        <form className="token-action-form locker-form" onSubmit={reviewLock}>
          <h3>Lock tokens into release tranches</h3>
                  <div className="token-current-balance"><span>Available to lock</span><b>{formatUnits(token.balance, token.decimals)} {token.symbol}</b><small>{lockDecimals} decimal place{lockDecimals === 1 ? '' : 's'}</small></div>
                  <label className="field-label">Total amount to lock<div className="amount-input"><input value={amount} onChange={event => setAmount(sanitizeTokenAmount(event.target.value, lockDecimals))} placeholder={lockDecimals ? `0.${'0'.repeat(lockDecimals)}` : '0'} inputMode="decimal" autoComplete="off" required /><button type="button" className="text-link" onClick={() => setAmount(formatUnits(token.balance, token.decimals).replace(/,/g, ''))}>Max</button><span>{token.symbol}</span></div></label>
          <div className="locker-fields"><label className="field-label">Release interval<select value={schedule} onChange={event => setSchedule(event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly (30 days)</option><option value="yearly">Yearly (365 days)</option></select></label><label className="field-label">Tranches (1–24)<input type="number" min="1" max="24" step="1" value={tranches} onChange={event => setTranches(event.target.value)} required /></label></div>
          <p className="token-modal-warning">Each tranche is enforced on-chain with CLTV and cannot be spent before its unlock time. This is not a local-only freeze. Claims also require ordinary BSV for fees.</p>
          <button className="primary-button wide" type="submit"><Check size={15} /> Review lock schedule</button>
        </form>
        <div className="locker-list-head"><h3>Your local lock schedule</h3><button className="text-link" onClick={loadLocks}>Refresh status</button></div>
        {locks.length === 0 ? <div className="locker-empty">No tranches recorded in this computer’s local locker.</div> : <div className="locker-list">{locks.map(lock => {
          const matured = lock.status === 'locked' && lock.unlockTimestamp <= now;
          const label = lock.status === 'locked' ? (matured ? 'Claimable' : `Unlocks ${new Date(lock.unlockTimestamp * 1000).toLocaleString()}`) : lock.status === 'released' ? 'Claimed' : lock.status === 'rejected' ? 'Network rejected' : 'Broadcast status pending';
          return <div className="locker-row" key={lock.id}><div className="locker-row-icon">{matured ? <Unlock size={15} /> : <LockKeyhole size={15} />}</div><div className="locker-row-info"><b>{formatUnits(lock.amountBase, token.decimals)} {token.symbol}</b><span>Tranche {lock.trancheIndex}/{lock.totalTranches} · {label}</span><code>{shortAddress(lock.lockTxid)}</code></div>{matured && <button className="secondary-button" onClick={() => claim(lock)} disabled={claiming === lock.id}>{claiming === lock.id ? 'Claiming…' : 'Claim'}</button>}</div>;
        })}</div>}
        <p className="locker-local-note">Locker records are saved only in this app’s local data folder. Back up txids separately; records are not synchronized to a cloud service.</p>
      </div>}
      {isLocker && reviewingLock && <div className="send-review"><h3>Review on-chain lock</h3><div><span>Total amount</span><b>{amount} {token.symbol}</b></div><div><span>Schedule</span><b>{schedule} · {tranches} tranches</b></div><p className="token-modal-warning">Each tranche is locked by CLTV. Nobody can spend it before its unlock time, and a broadcast cannot be undone. Keep BSV available for the later claim fee.</p><div className="review-buttons"><button className="secondary-button" onClick={() => setReviewingLock(false)} disabled={busy}>Back to edit</button><button className="primary-button" onClick={submitLock} disabled={busy}>{busy ? <><RefreshCw size={15} className="spin" /> Creating lock…</> : <><LockKeyhole size={15} /> Broadcast lock</>}</button></div></div>}
    </section>
  </div>;
}

function ActionPage({ wallet, balance, syncing, onSync, onSent }) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [feeEstimate, setFeeEstimate] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const confirmedSats = /^\d+$/.test(String(balance?.confirmed ?? '')) ? BigInt(balance.confirmed) : null;
  const trackedSpendableSats = /^\d+$/.test(String(balance?.spendableBsvSats ?? '')) ? BigInt(balance.spendableBsvSats) : null;
  const spendableSats = confirmedSats === null ? trackedSpendableSats
    : trackedSpendableSats === null || confirmedSats >= trackedSpendableSats ? confirmedSats : trackedSpendableSats;
  const localPendingSats = /^\d+$/.test(String(balance?.pendingLocalBsvSats ?? '')) ? BigInt(balance.pendingLocalBsvSats) : 0n;
  let amountSats = null;
  try {
    if (/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(amount.trim())) {
      const [whole, fraction = ''] = amount.trim().split('.');
      amountSats = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
    }
  } catch {}
  const amountValid = amountSats !== null && amountSats > 0n;

  const review = event => {
    event.preventDefault();
    setError(''); setResult(null);
    const normalized = minimumBsvAmount(amount);
    if (normalized !== amount) { setAmount(normalized); return; }
    if (!amountValid) return setError('Enter a positive amount with up to 8 decimal places.');
    if (spendableSats === null) return setError('Sync your BSV balance before sending.');
    if (amountSats + 11000n > spendableSats) return setError('The amount plus the 0.0001 BSV service fee may leave too little spendable BSV for the network fee.');
    if (new TextEncoder().encode(note.trim()).length > 200) return setError('The public note must be 200 bytes or less.');
    setReviewing(true);
    setFeeEstimate(null);
    window.lbsx.estimateBsvSend({ recipient, amount: amount.trim(), note: note.trim() })
      .then(setFeeEstimate)
      .catch(estimateError => setError(estimateError.message || 'Could not calculate the network fee.'));
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const sent = await window.lbsx.sendBsv({ recipient, amount: amount.trim(), note: note.trim() });
      setResult(sent); setReviewing(false); setAmount(''); setNote('');
      onSent?.();
    } catch (sendError) {
      setError(sendError.message || 'The BSV transaction could not be broadcast.');
    } finally { setBusy(false); }
  };

  return <><div className="page-heading"><div><div className="eyebrow">ON-CHAIN TRANSFER</div><h1>Send BSV</h1><p>Build, review, sign locally, and broadcast through BananaBlocks.</p></div><button className="secondary-button" onClick={onSync} disabled={syncing}><RefreshCw size={15} className={syncing ? 'spin' : ''} />{syncing ? 'Syncing…' : 'Sync balance'}</button></div>
    <div className="action-layout"><div className="surface-card action-form"><div className="form-top-icon"><Send size={18} /></div>
      <div className="token-current-balance"><span>Spendable BSV</span><b><BsvText>{spendableSats === null ? 'Sync balance first' : `${formatSatoshis(spendableSats.toString())} BSV`}</BsvText></b>{localPendingSats > 0n && <small>{formatSatoshis(localPendingSats.toString())} locally tracked · 0-conf spendable</small>}</div>
      {error && <div className="sync-error">{error}</div>}
      {result && <div className="token-success"><b>Broadcast accepted</b><div>Amount: {formatSatoshis(String(result.amountSats))} <BsvText>BSV</BsvText> · network fee: {formatSatoshis(String(result.feeSats))} <BsvText>BSV</BsvText> · service fee: 0.0001 <BsvText>BSV</BsvText></div><ExplorerReference value={result.txid} /></div>}
      {!reviewing ? <form className="token-action-form" onSubmit={review}>
        <label className="field-label">Recipient BSV address<input value={recipient} onChange={event => setRecipient(event.target.value.trim())} placeholder="Paste a BSV mainnet address" autoComplete="off" required /></label>
        <label className="field-label">Amount<div className="amount-input"><input value={amount} onChange={event => setAmount(sanitizeBsvAmount(event.target.value))} onBlur={() => setAmount(current => minimumBsvAmount(current))} placeholder="0.00000001" inputMode="decimal" autoComplete="off" required /><span className="bsv-ticker">BSV</span></div></label>
        <label className="field-label">Public transaction note <span className="optional">OPTIONAL</span><textarea value={note} onChange={event => setNote(event.target.value)} placeholder="Optional note stored publicly on-chain" rows={3} maxLength={200} /></label>
        <p className="token-modal-warning">Only verified plain-BSV UTXOs and this wallet’s own locally tracked pending change are selected; external unconfirmed outputs and token carriers are excluded. The optional note is public and permanent.</p>
        <button className="primary-button wide" type="submit" disabled={spendableSats === null}><Check size={15} /> Review BSV payment</button>
      </form> : <div className="send-review"><h3>Review before broadcast</h3><div><span>Amount</span><b>{formatSatoshis(amountSats.toString())} <BsvText>BSV</BsvText></b></div><div><span>Recipient</span><code>{recipient}</code></div><div><span>Network fee</span><b>{feeEstimate ? `${formatSatoshis(String(feeEstimate.feeSats))} BSV (${feeEstimate.feeSats} sat · ${feeEstimate.sizeBytes} bytes at 1 sat/byte)` : 'Calculating…'}</b></div><div><span>LBSX service fee</span><b>10,000 sat (0.00010000 BSV)</b></div><p className="token-modal-warning">A 10,000 sat service fee is collected by LBSX to maintain the wallet. It is paid to the LBSX admin wallet in this transaction, in addition to the amount and network fee, and is recorded in the on-chain LBSX OP_RETURN.</p>{note.trim() && <div><span>Public note</span><b>{note.trim()}</b></div>}<p className="token-modal-warning">This signs and broadcasts a mainnet transaction. Verify the full address and amount before continuing.</p><div className="review-buttons"><button className="secondary-button" onClick={() => setReviewing(false)} disabled={busy}>Back to edit</button><button className="primary-button" onClick={submit} disabled={busy}>{busy ? <><RefreshCw size={15} className="spin" /> Signing…</> : <><Send size={15} /> Broadcast BSV</>}</button></div></div>}
    </div><div className="surface-card preview-card"><div className="muted-label">BEFORE YOU SEND</div><h3>Review carefully</h3><ul><li><BadgeCheck size={15} /> Verify the recipient address.</li><li><BadgeCheck size={15} /> Confirm the amount and actual network fee.</li><li><BadgeCheck size={15} /> Signing happens locally on this device.</li></ul><div className="privacy-callout"><ShieldCheck size={16} /><span>Your recovery phrase and private key stay in the encrypted local vault.</span></div></div></div><LocalNotice /></>;
}

function Receive({ wallet, onCopy, copied }) {
  return <><div className="page-heading"><div><div className="eyebrow">INCOMING PAYMENTS</div><h1>Receive BSV</h1><p>Share your public address to receive BSV or supported tokens.</p></div></div><div className="surface-card receive-card"><div className="receive-symbol"><BsvLogo /></div><AddressQr address={wallet.address} size={136} className="receive-qr" /><span className="muted-label">YOUR BSV MAINNET ADDRESS</span><code className="full-address">{wallet.address}</code><button className="primary-button" onClick={onCopy}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied address' : 'Copy address'}</button><div className="receive-warning"><CircleHelp size={15} /><span>Only send assets on the BSV mainnet to this address.</span></div></div><LocalNotice /></>;
}

function ActivityPage({ snapshot, chainSnapshot, tokens = [], syncing, balanceSyncing, checkingPending, error, balanceError, onSync, onSyncBalances, onCheckPending }) {
  const rows = snapshot?.activities || [];
  const [pageNumber, setPageNumber] = useState(1);
  const pageSize = 6;
  const pageCount = Math.ceil(rows.length / pageSize);
  const currentPage = Math.min(pageNumber, Math.max(pageCount, 1));
  const firstPage = Math.max(1, Math.min(currentPage - 2, pageCount - 4));
  const pageNumbers = Array.from({ length: Math.max(0, Math.min(5, pageCount - firstPage + 1)) }, (_, index) => firstPage + index);
  const firstRow = rows.length ? (currentPage - 1) * pageSize + 1 : 0;
  const lastRow = Math.min(currentPage * pageSize, rows.length);
  const visibleRows = rows.slice(firstRow - 1, lastRow);
  const balance = chainSnapshot?.balance;
  const validBalance = balance && /^\d+$/.test(String(balance.confirmed ?? ''))
    && /^\d+$/.test(String(balance.unconfirmed ?? ''));
  const totalBalanceSats = validBalance
    ? (BigInt(balance.confirmed) + BigInt(balance.unconfirmed)).toString()
    : null;
  const spendableSats = /^\d+$/.test(String(balance?.spendableBsvSats ?? ''))
    ? balance.spendableBsvSats
    : null;
  const balanceSyncedAt = chainSnapshot?.balanceSyncedAt || chainSnapshot?.syncedAt;
  const scanIncomplete = Boolean(snapshot?.syncedAt && snapshot.historyBackfillComplete === false);
  useEffect(() => {
    if (pageNumber > currentPage) setPageNumber(currentPage);
  }, [pageNumber, currentPage]);
  const tokenList = [...(snapshot?.importedTokens || []), ...tokens];
  const tokenFor = row => tokenList.find(token => token.tokenId === row.tokenId);
  const amountFor = row => {
    if (row.tokenAmount) {
      const token = tokenFor(row);
      const symbol = row.symbol || token?.symbol || 'BSV-21';
    return `${formatUnits(row.tokenAmount, Number(row.details?.decimals ?? token?.decimals ?? 0))} ${symbol}`;
    }
    if (row.amountSats != null) return `${formatSatoshis(row.amountSats)} BSV`;
    return '';
  };
  const txStatus = row => row.status === 'confirmed' ? 'CONFIRMED'
    : row.status === 'unconfirmed' ? 'UNCONFIRMED'
      : String(row.status || 'LOCAL').toUpperCase();
  const bsvBreakdown = row => {
    const details = row.details || {};
    const parts = [];
    if (details.walletNetSpentSats != null) parts.push(`Net debit ${formatSatoshis(details.walletNetSpentSats)} BSV`);
    if (details.changeSats != null && details.walletInputSats != null) parts.push(`Change returned ${formatSatoshis(details.changeSats)} BSV`);
    if (details.feeSats != null) parts.push(`Fee ${formatSatoshis(details.feeSats)} BSV`);
    return parts.join(' · ');
  };
  return <>
    <div className="page-heading"><div><div className="eyebrow">WALLET LEDGER</div><h1>Activity</h1><p>Wallet transactions and local actions are encrypted and retained on this device.</p></div><div className="heading-actions activity-heading-actions"><button className="secondary-button" onClick={onSyncBalances} disabled={balanceSyncing}><RefreshCw size={15} className={balanceSyncing ? 'spin' : ''} />{balanceSyncing ? 'Syncing balance…' : 'Sync balance'}</button><button className="secondary-button" onClick={onCheckPending} disabled={checkingPending || syncing || !rows.some(row => row.status === 'unconfirmed')} title="Check local pending transactions without refreshing all history"><BadgeCheck size={15} className={checkingPending ? 'spin' : ''} />{checkingPending ? 'Checking…' : 'Check pending'}</button><button className="secondary-button" onClick={onSync} disabled={syncing || checkingPending}><RefreshCw size={15} className={syncing ? 'spin' : ''} />{syncing ? 'Refreshing…' : 'Refresh history'}</button></div></div>
    {error && <div className="sync-error" role="alert">{error}</div>}
    {balanceError && <div className="sync-error" role="alert">{balanceError}</div>}
    <section className="surface-card activity-balance-summary">
      <div className="activity-balance-main"><span className="muted-label">CURRENT <BsvText>BSV</BsvText> BALANCE</span><b><BsvText>{totalBalanceSats === null ? 'Not synced yet' : `${formatSatoshis(totalBalanceSats)} BSV`}</BsvText></b><small>{validBalance ? `${formatSatoshis(balance.confirmed)} confirmed · ${formatSatoshis(balance.unconfirmed)} unconfirmed` : 'Sync your balance to see confirmed and pending BSV.'}</small></div>
      <div className="activity-balance-meta"><div><span>Spendable locally</span><b><BsvText>{spendableSats === null ? '—' : `${formatSatoshis(spendableSats)} BSV`}</BsvText></b></div><div><span>Balance checked</span><b>{balanceSyncedAt ? new Date(balanceSyncedAt).toLocaleString() : 'Not synced yet'}</b></div></div>
    </section>
    {snapshot?.remaining > 0 && <div className="activity-backfill-note">{snapshot.remaining} saved transaction{snapshot.remaining === 1 ? '' : 's'} still need detail lookups. Refresh history to retry and continue.</div>}
    {scanIncomplete && <div className="activity-backfill-note">Older wallet history is still loading. {rows.length} entr{rows.length === 1 ? 'y is' : 'ies are'} saved so far; refresh history to continue.</div>}
    <section className="surface-card activity-ledger">
      <div className="section-title-row"><div><span className="muted-label">LOCAL WALLET HISTORY</span><h2>{rows.length} loaded</h2></div><span className="activity-last-sync"><span>{snapshot?.syncedAt ? `Last refresh ${new Date(snapshot.syncedAt).toLocaleString()}` : 'Not refreshed yet'}</span>{snapshot?.transactionStatusCheckedAt && <span>Pending statuses checked {new Date(snapshot.transactionStatusCheckedAt).toLocaleString()}</span>}</span></div>
      {rows.length ? <><div className="activity-rows">{visibleRows.map(row => {
        const amount = amountFor(row);
        const isReceive = row.type?.includes('receive') || Number(row.details?.netSats) > 0;
        const isOutgoing = row.type?.includes('send') || Number(row.details?.netSats) < 0;
        const breakdown = bsvBreakdown(row);
        return <article className="activity-row" key={row.id}>
          <div className={`activity-row-icon ${isReceive ? 'received' : ''} kind-${rowKind(row)}`}>{activityIcon(row, isReceive)}</div>
          <div className="activity-row-main"><b>{row.title}</b><span>{new Date(row.timestamp).toLocaleString()} · {row.details?.lookupError ? 'DETAILS PENDING' : txStatus(row)}</span>{row.txid ? <ExplorerReference value={row.txid} compact className="activity-reference" /> : row.tokenId ? <ExplorerReference value={row.tokenId} kind="token" className="activity-reference" /> : null}</div>
          <div className="activity-row-value">{amount && <b><BsvText>{`${isOutgoing ? '−' : isReceive ? '+' : ''}${amount}`}</BsvText></b>}<span>{row.blockHeight > 0 ? `Block ${row.blockHeight}` : row.source === 'local' ? 'Saved locally' : 'Awaiting confirmation'}</span>{breakdown && <small>{breakdown}</small>}</div>
        </article>;
      })}</div>{pageCount > 1 && <div className="activity-pagination"><span>Showing {firstRow}–{lastRow} of {rows.length} loaded</span><div className="activity-pagination-controls"><button type="button" className="activity-page-button" onClick={() => setPageNumber(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page"><ArrowLeft size={13} />Back</button>{pageNumbers.map(number => <button type="button" key={number} className={`activity-page-number ${number === currentPage ? 'active' : ''}`} onClick={() => setPageNumber(number)} aria-label={`Page ${number}`} aria-current={number === currentPage ? 'page' : undefined}>{number}</button>)}<button type="button" className="activity-page-button" onClick={() => setPageNumber(currentPage + 1)} disabled={currentPage >= pageCount} aria-label="Next page">Next<ArrowRight size={13} /></button></div></div>}</> : <div className="assets-empty activity-empty"><div className="large-empty-icon"><FileClock size={25} /></div><h2>{snapshot?.syncedAt ? 'No wallet activity found' : 'Refresh to load wallet history'}</h2><p>{snapshot?.syncedAt ? 'This address has no indexed transactions or local wallet actions yet.' : 'Refresh retrieves confirmed and unconfirmed address history, then stores the results in encrypted wallet data.'}</p><button className="primary-button" onClick={onSync} disabled={syncing}><RefreshCw size={15} className={syncing ? 'spin' : ''} />{syncing ? 'Refreshing…' : 'Refresh history'}</button></div>}
    </section>
    <div className="local-notice"><div className="notice-icon"><ShieldCheck size={15} /></div><div><b>Encrypted local history and UTXOs</b><span>Activity, imported tokens, verified UTXOs, and pending transaction data are encrypted with a key derived from this wallet’s recovery phrase. Only this wallet can decrypt them.</span></div><span className="notice-tag">LOCAL</span></div>
    <LocalNotice />
  </>;
}

function TradingPage({ snapshot, syncing, error, onSync }) {
  const trades = snapshot?.transactions?.filter(row => row.classification === 'fee-linked-settlement-candidate') || [];
  const markets = snapshot?.markets || [];
  const formatFee = (sats) => `${(Number(sats || 0) / 100000000).toFixed(8)} BSV`;
  return <>
    <div className="page-heading"><div><div className="eyebrow">LOCAL CHAIN DISCOVERY</div><h1>Peer trading</h1><p>Confirmed token settlements reconstructed from the LocalBSV discovery wallet.</p></div><button className="secondary-button" onClick={onSync} disabled={syncing}><RefreshCw size={15} className={syncing ? 'spin' : ''} />{syncing ? 'Syncing chain…' : 'Sync discovery'}</button></div>
    <div className="trading-anchor surface-card"><div className="trading-anchor-icon"><TrendingUp size={18} /></div><div className="trading-anchor-copy"><span className="muted-label">HARDCODED DISCOVERY ADDRESS</span><code>{snapshot?.address || '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB'}</code><small>{snapshot?.syncedAt ? `Last sync ${new Date(snapshot.syncedAt).toLocaleString()} · ${snapshot.scannedTransactions || 0} transactions scanned${snapshot.historyComplete === false ? ' · older history still to be checked' : ''}${snapshot.lookupFailures ? ` · ${snapshot.lookupFailures} lookups failed; results may be incomplete` : ''}` : 'Sync to scan confirmed address history through BananaBlocks.'}</small></div><span className="chain-verified-pill"><span className="status-dot" /> READ ONLY</span></div>
    <div className="trading-warning"><CircleHelp size={16} /><div><b>What this can and cannot discover</b><span>The admin wallet can anchor confirmed settlements that pay its fee output. LocalBSV open orders are stored in its off-chain order book and are not linked to this address, so this tab cannot recreate open orders or offer live matching while LocalBSV is offline. This sync is read-only and never signs or broadcasts.</span></div></div>
    {error && <div className="sync-error">{error}</div>}
    <div className="trading-stats"><div className="surface-card"><span className="muted-label">CHAIN-DERIVED MARKETS</span><strong>{markets.length}</strong><small>Tokens observed in fee-linked candidates</small></div><div className="surface-card"><span className="muted-label">CONFIRMED CANDIDATES</span><strong>{trades.length}</strong><small>Need trade-intent validation from on-chain context</small></div><div className="surface-card"><span className="muted-label">PEER ADDRESSES</span><strong>{new Set(trades.flatMap(row => row.peerAddresses || [])).size}</strong><small>Input addresses visible on-chain</small></div></div>
    <section className="surface-card trading-list-card"><div className="section-title-row"><div><span className="muted-label">ON-CHAIN ACTIVITY</span><h2>Fee-linked settlement candidates</h2></div><span className="trading-count">{trades.length} tx</span></div>{trades.length ? <div className="trading-rows">{trades.map(row => <div className="trading-row" key={row.txid}><div className="trade-token-mark"><BsvLogo /></div><div className="trade-row-main"><b>{row.tokenIds?.map(id => markets.find(m => m.tokenId === id)?.symbol || id).join(', ') || 'BSV-21 token'}</b><span>{row.tokenOutputs?.map(token => `${token.op || 'token'} · ${token.amount} raw units${token.symbol ? ` · ${token.symbol}` : ''}`).join(' · ')}</span><ExplorerReference value={row.txid} compact className="trading-reference" /></div><div className="trade-row-right"><b>{formatFee(row.anchorOutputSats)} to anchor</b><span>Block {row.blockHeight || '—'}{row.blockTime ? ` · ${new Date(row.blockTime * 1000).toLocaleDateString()}` : ''}</span><span>{row.peerAddresses?.length || 0} visible input peers</span></div></div>)}</div> : <div className="trading-empty"><div className="large-empty-icon"><TrendingUp size={23} /></div><h2>{snapshot?.syncedAt ? 'No fee-linked settlement candidates found' : 'Start with a chain sync'}</h2><p>{snapshot?.syncedAt ? 'The scan found no transaction with both an anchor-wallet output and an indexed BSV-21 transfer. Ordinary admin-wallet activity is excluded.' : 'Sync the public discovery address to build your local, read-only view of confirmed token activity.'}</p><button className="primary-button" onClick={onSync} disabled={syncing}><RefreshCw size={15} className={syncing ? 'spin' : ''} />{syncing ? 'Syncing…' : 'Sync chain activity'}</button></div>}</section>
    {markets.length > 0 && <section className="surface-card trading-list-card"><div className="section-title-row"><div><span className="muted-label">TOKEN PAIRS OBSERVED</span><h2>Chain-derived markets</h2></div></div><div className="trading-market-list">{markets.map(market => <div className="trading-market-row" key={market.tokenId}><div className="token-icon">{market.symbol ? market.symbol.slice(0, 1).toUpperCase() : <BsvLogo />}</div><div><b>{market.symbol || market.tokenId}</b><ExplorerReference value={market.tokenId} kind="token" className="trading-reference" /></div><span>{market.confirmedSettlements} settlement{market.confirmedSettlements === 1 ? '' : 's'}</span><span>{market.peerAddresses.length} peer address{market.peerAddresses.length === 1 ? '' : 'es'}</span></div>)}</div></section>}
    <div className="local-notice"><div className="notice-icon"><ShieldCheck size={15} /></div><div><b>Private local index</b><span>Snapshots are saved in this wallet’s local app-data folder. Public chain data is read from BananaBlocks using the configured API key setting; your seed phrase and private keys are not used.</span></div><span className="notice-tag">LBSX WALLET</span></div>
  </>;
}

function VirusTotalApiPanel() {
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    window.lbsx.getVirusTotalApiKeyStatus()
      .then(result => {
        if (!active) return;
        setStatus(result);
        setEnabled(result.enabled);
      })
      .catch(reason => { if (active) setError(reason.message || 'Could not read the VirusTotal API key settings.'); });
    return () => { active = false; };
  }, []);

  const save = async event => {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.lbsx.saveVirusTotalApiKey({ apiKey, enabled });
      setStatus(result); setEnabled(result.enabled); setApiKey('');
      setMessage(result.enabled ? 'VirusTotal scanning enabled.' : 'Settings saved. Scanning stays off.');
    } catch (reason) { setError(reason.message || 'Could not save the API key settings.'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.lbsx.removeVirusTotalApiKey();
      setStatus(result); setEnabled(false); setApiKey('');
      setMessage('Saved VirusTotal API key removed.');
    } catch (reason) { setError(reason.message || 'Could not remove the saved API key.'); }
    finally { setBusy(false); }
  };

  return <section className="surface-card api-key-card">
    <div className="security-head">
      <div className="security-big-icon"><ShieldCheck size={21} /></div>
      <div>
        <h2>VirusTotal attachment scanning</h2>
        <p>Scan mail attachments before saving them.</p>
      </div>
    </div>
    {status && <div className="api-key-status"><span className={`status-dot ${status.enabled ? '' : 'api-key-status-off'}`} />{status.enabled ? 'Scanning enabled' : status.configured ? 'API key saved but disabled' : 'No API key saved'}</div>}
    {status?.secureStorageAvailable === false && <div className="sync-error">Secure operating-system storage is unavailable. The wallet will not save an API key insecurely.</div>}
    <form className="api-key-form" onSubmit={save}>
      <label className="field-label">VirusTotal API key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={status?.configured ? 'Enter a new key to replace the saved key' : 'Paste your VirusTotal API key'} autoComplete="off" spellCheck="false" /></label>
      <label className="api-key-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={!status?.secureStorageAvailable || (!status?.configured && !apiKey.trim())} /><span>Enable VirusTotal scanning</span></label>
      <p className="api-key-help">The key is encrypted with this computer’s secure storage and sent only to VirusTotal. Attachments are never previewed: the wallet checks the file’s SHA-256 with VirusTotal first, so a file VirusTotal already knows never leaves your device. An unknown file is uploaded only after you agree.</p>
      <p className="api-key-help">The public VirusTotal API allows 500 requests a day and 4 a minute, and is for non-commercial use. A file that is uploaded becomes permanently public.</p>
      {error && <div className="sync-error" role="alert">{error}</div>}
      {message && <div className="api-key-success" role="status">{message}</div>}
      <div className="api-key-actions">
        <button className="primary-button" type="submit" disabled={busy || !status?.secureStorageAvailable || (!apiKey.trim() && !status?.configured)}>{busy ? 'Saving…' : 'Save settings'}</button>
        {status?.configured && <button className="secondary-button" type="button" onClick={remove} disabled={busy}>Remove saved key</button>}
      </div>
    </form>
  </section>;
}

function BananaBlocksApiPage() {
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    window.lbsx.getBananaBlocksApiKeyStatus()
      .then(result => {
        if (!active) return;
        setStatus(result);
        setEnabled(result.enabled);
      })
      .catch(reason => { if (active) setError(reason.message || 'Could not read BananaBlocks API key settings.'); });
    return () => { active = false; };
  }, []);

  const save = async event => {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.lbsx.saveBananaBlocksApiKey({ apiKey, enabled });
      setStatus(result); setEnabled(result.enabled); setApiKey('');
      setMessage(result.enabled ? 'BananaBlocks API key enabled.' : 'Settings saved. BananaBlocks requests will use anonymous access.');
    } catch (reason) { setError(reason.message || 'Could not save the API key settings.'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.lbsx.removeBananaBlocksApiKey();
      setStatus(result); setEnabled(false); setApiKey('');
      setMessage('Saved BananaBlocks API key removed.');
    } catch (reason) { setError(reason.message || 'Could not remove the saved API key.'); }
    finally { setBusy(false); }
  };

  return <>
    <div className="page-heading"><div><div className="eyebrow">OPTIONAL AUTHENTICATION</div><h1>BananaBlocks API</h1><p>Use your API key for BananaBlocks wallet, token, and trading requests.</p></div></div>
    <section className="surface-card api-key-card">
      <div className="security-head"><div className="security-big-icon"><KeyRound size={21} /></div><div><h2>API key settings</h2><p>Anonymous access remains available when the key is disabled.</p></div></div>
      {status && <div className="api-key-status"><span className={`status-dot ${status.enabled ? '' : 'api-key-status-off'}`} />{status.enabled ? 'API key enabled' : status.configured ? 'API key saved but disabled' : 'No API key saved'}</div>}
      {status?.secureStorageAvailable === false && <div className="sync-error">Secure operating-system storage is unavailable. The wallet will not save an API key insecurely.</div>}
      <form className="api-key-form" onSubmit={save}>
        <label className="field-label">BananaBlocks API key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={status?.configured ? 'Enter a new key to replace the saved key' : 'Paste your BananaBlocks API key'} autoComplete="off" spellCheck="false" /></label>
        <label className="api-key-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={!status?.secureStorageAvailable || (!status?.configured && !apiKey.trim())} /><span>Enable this key for BananaBlocks requests</span></label>
        <p className="api-key-help">The key is encrypted with this computer’s secure storage. When enabled, it is sent in the <code>X-API-Key</code> header only to BananaBlocks. The wallet never requires a key.</p>
        {error && <div className="sync-error" role="alert">{error}</div>}
        {message && <div className="api-key-success" role="status">{message}</div>}
        <div className="api-key-actions">
          <button className="primary-button" type="submit" disabled={busy || !status?.secureStorageAvailable || (!apiKey.trim() && !status?.configured)}>{busy ? 'Saving…' : 'Save settings'}</button>
          {status?.configured && <button className="secondary-button" type="button" onClick={remove} disabled={busy}>Remove saved key</button>}
        </div>
      </form>
    </section>
    <VirusTotalApiPanel />
    <LocalNotice />
  </>;
}

function Security({ wallet, onCopy, copied, onLock, onDelete }) {
  const [tab, setTab] = useState('security');
  const protectionLabel = wallet.vaultMode === 'device' ? 'OS account encrypted' : 'Password encrypted';
  const heading = <div className="page-heading"><div><div className="eyebrow">LOCAL KEY CUSTODY</div><h1>Security center</h1><p>Manage the encrypted vault and verify which wallet is active.</p></div><button className="danger-quiet" onClick={onLock}><LockKeyhole size={15} /> Lock now</button></div>;
  const overview = <><div className="security-grid"><div className="surface-card security-main"><div className="security-head"><div className="security-big-icon"><ShieldCheck size={22} /></div><div><h2>Encrypted local vault</h2><p>Your imported phrase is encrypted on disk and only decrypted in memory while unlocked.</p></div><span className="secure-pill"><span className="status-dot" /> {protectionLabel.toUpperCase()}</span></div><div className="security-row"><div><span className="muted-label">ACTIVE ADDRESS</span><code style={{ wordBreak: 'break-all' }}>{wallet.address}</code></div><button className="copy-button" onClick={onCopy}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy'}</button></div><div className="security-row"><div><span className="muted-label">DERIVATION PATH</span><code>{wallet.derivationPath}</code></div></div><div className="security-footer"><span><Check size={15} /> {wallet.vaultMode === 'device' ? 'OS key-store encryption' : 'AES-256-GCM encrypted'}</span><span><Check size={15} /> Phrase stays on this device</span><span><Check size={15} /> Import-only wallet</span></div></div><div className="surface-card security-side"><div className="side-icon"><KeyRound size={18} /></div><h3>Recovery phrase</h3><p>The phrase is not displayed or copied from this screen. Keep your original backup in a secure, offline location.</p><div className="security-divider" /><div className="small-proof"><ShieldCheck size={15} /> No key-generation action exists in this wallet.</div><div className="small-proof"><LockKeyhole size={15} /> Locking clears the app's unlocked phrase reference.</div></div></div><div className="danger-zone"><div className="danger-zone-head"><div className="danger-zone-icon"><AlertTriangle size={18} /></div><div><h2>Delete wallet</h2><p>Remove the wallet connected to this computer, including its encrypted vault and local wallet data.</p></div></div><div className="danger-zone-body"><p className="danger-zone-note">Deleting the wallet does not move any BSV or BSV-21 tokens. Funds stay on the BSV mainnet at <code>{shortAddress(wallet.address)}</code>, but this app will no longer hold the keys that can spend them.</p><button className="danger-button" onClick={onDelete}><Trash2 size={15} /> Delete Wallet</button></div></div><LocalNotice /></>;
    return <>{heading}<div className="security-tabs" role="tablist"><button type="button" role="tab" aria-selected={tab === 'security'} className={tab === 'security' ? 'security-tab active' : 'security-tab'} onClick={() => setTab('security')}>Wallet security</button><button type="button" role="tab" aria-selected={tab === 'utxo'} className={tab === 'utxo' ? 'security-tab active' : 'security-tab'} onClick={() => setTab('utxo')}>UTXO Store</button></div>{tab === 'utxo' ? <UtxoStorePanel /> : overview}</>;
  }

function DeleteWalletModal({ wallet, onClose, onConfirm }) {
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canDelete = confirmText.trim().toUpperCase() === 'DELETE';
  const confirm = async () => {
    if (!canDelete || busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (reason) {
      setError(reason.message || 'Could not delete this wallet.');
      setBusy(false);
    }
  };
  return <div className="modal-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="token-modal delete-wallet-modal" role="dialog" aria-modal="true" aria-labelledby="delete-wallet-title">
      <header className="token-modal-head"><div><span className="eyebrow">IRREVERSIBLE ACTION</span><h2 id="delete-wallet-title">Delete Wallet</h2></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">×</button></header>
      <div className="delete-wallet-warning">
        <AlertTriangle size={16} />
        <div><b>This permanently destroys the wallet on this computer.</b><span>It cannot be undone, and nobody can recover it for you.</span></div>
      </div>
      <ul className="delete-wallet-risks">
        <li><b>Your recovery phrase is deleted.</b> The encrypted vault that holds it is erased from disk. Without a separate offline backup of your phrase, the wallet is gone for good.</li>
        <li><b>Your local wallet data is deleted.</b> Activity history, imported tokens, token locks, peer chat messages, and cached balance records for this address are removed from this computer.</li>
        <li><b>Your funds are not moved.</b> Any BSV and BSV-21 tokens stay on the BSV mainnet at <code>{shortAddress(wallet.address)}</code>. Deleting the wallet removes your only key to spend them, so those funds become effectively unrecoverable.</li>
        <li><b>You will need your phrase to return.</b> A new wallet can only be created by importing a recovery phrase again. This app cannot generate, export, or recover one.</li>
      </ul>
      <p className="delete-wallet-confirm-copy">Type <b>DELETE</b> to confirm you understand the risks and want to erase this wallet from this computer.</p>
      <input className="delete-wallet-input" value={confirmText} onChange={event => setConfirmText(event.target.value)} placeholder="DELETE" autoComplete="off" spellCheck="false" disabled={busy} />
      {error && <div className="sync-error" role="alert">{error}</div>}
      <div className="review-buttons">
        <button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="danger-button" onClick={confirm} disabled={!canDelete || busy}>{busy ? <><RefreshCw size={15} className="spin" /> Deleting…</> : <><Trash2 size={15} /> Delete</>}</button>
      </div>
    </section>
  </div>;
}

function LocalNotice() {
  return <div className="local-notice"><div className="notice-icon"><Sparkles size={15} /></div><div><b>Local-first wallet</b><span>Balance reads use BananaBlocks; the recovery phrase never leaves this computer.</span></div><span className="notice-tag">LBSX WALLET</span></div>;
}
