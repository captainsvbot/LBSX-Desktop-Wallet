import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

const isValidReference = (kind, value) => {
  if (kind === 'txid') return /^[a-f0-9]{64}$/i.test(value);
  if (kind === 'token') return /^[a-f0-9]{64}_[0-9]+$/i.test(value);
  if (kind === 'outpoint') return /^[a-f0-9]{64}\.(0|[1-9][0-9]*)$/i.test(value);
  return false;
};

const explorerLabel = kind => kind === 'token' ? 'token ID' : kind === 'outpoint' ? 'outpoint' : 'transaction ID';

function abbreviated(value) {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

export default function ExplorerReference({
  value,
  kind = 'txid',
  compact = false,
  className = '',
  linkLabel,
  hideCopy = false,
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  if (typeof value !== 'string' || !value) return null;

  const label = explorerLabel(kind);
  const valid = isValidReference(kind, value);
  const copy = async () => {
    setCopied(false);
    setCopyFailed(false);
    try {
      await window.lbsx.copyText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyFailed(true);
    }
  };
  const open = async () => {
    setOpenFailed(false);
    try {
      await window.lbsx.openExplorer({ kind, value });
    } catch {
      setOpenFailed(true);
    }
  };

  return <span className={`explorer-reference ${compact ? 'explorer-reference-compact' : ''} ${className}`.trim()} data-reference-kind={kind} data-reference-value={value}>
    <button type="button" className="explorer-reference-link" onClick={open} disabled={!valid} title={openFailed ? 'Could not open BananaBlocks' : `Open ${label} in BananaBlocks`}>
      {linkLabel || (compact ? abbreviated(value) : value)}
    </button>
    {!hideCopy && <button type="button" className="explorer-reference-copy" onClick={copy} aria-label={copied ? `${label} copied` : copyFailed ? `Could not copy ${label}` : `Copy ${label}`} title={copied ? 'Copied' : copyFailed ? 'Copy failed' : `Copy ${label}`}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>}
  </span>;
}
