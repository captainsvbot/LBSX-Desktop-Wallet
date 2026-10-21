# Security Policy

## Reporting a vulnerability

If you believe you have found a vulnerability in LBSX Desktop Wallet, please
report it privately rather than opening a public issue.

- Open a **private** security advisory on the repository, or
- Contact the maintainer via the repository's issue tracker with a request for
  a private channel.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally with a test script.
- The wallet build version (`v1.2.01` / package version `1.2.1`) and platform.
- Whether the issue requires a real wallet, a funded wallet, or only a
  synthetic one.

You should get an acknowledgement within a few days. Please do not disclose
the issue publicly, and do not test against mainnet with funds at risk, until
a fix has been released or you have received explicit permission.

---

## Threat model in one paragraph

LBSX Desktop Wallet is a **local-first, single-signature, import-only**
desktop wallet. The threat model assumes an attacker may have: read access to
the victim's disk, network-level visibility (and the ability to drop or
modify packets), the ability to run other code on the victim's machine after
the wallet has been used, and full visibility of the public blockchain. The
threat model does **not** assume the attacker can break AES-256-GCM, scrypt,
or the security of the operating system's key store, and does **not** protect
the user from a compromised operating system, a malicious remote code
execution in the renderer, or a phishing attack that convinces the user to
import someone else's recovery phrase.

---

## What the wallet protects

| Property | How |
|---|---|
| Recovery phrase at rest | `wallet-vault.json` is encrypted with scrypt (N=2^15, r=8, p=1, 64 MB cap) → AES-256-GCM (16-byte salt, 12-byte IV, 16-byte tag), or with Electron `safeStorage` (OS key store) in device mode. |
| Key material in memory | The phrase lives in a single module-level variable in `electron/vault.cjs`. Derived key buffers are zero-filled after use. `lockVault()` nulls the reference; `before-quit` locks automatically. |
| Renderer compromise | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer has no Node access. The bridge is a frozen, allow-listed API (`electron/preload.cjs`). All window opens are denied; navigation is blocked except the dev server or the packaged `file://` page. |
| Local state file | `wallet-data/<sha256(address)>.enc` is AES-256-GCM encrypted under an HKDF-SHA256 key derived from the wallet seed. Unreadable without the recovery phrase. |
| Integrity of the state file | Writes use a unique temp file with mode `0o600` and the `wx` flag, then an atomic `rename()`. A per-file write queue serialises read-modify-write cycles. |
| Transaction inclusion | Spent inputs must carry a BEEF Merkle proof that the wallet checks against a locally validated BSV mainnet header chain, anchored at genesis. |
| Indexer API key | Encrypted with `safeStorage`. Sent only to `bananablocks.com`, only in the `X-API-Key` header, only when the user enables it. |
| Clickjacking / injection | The packaged renderer runs under a strict CSP: `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `frame-uri 'none'`. |

---

## What the wallet deliberately does NOT protect

This section is the important one. These are **design decisions**, not bugs.
They are documented here so that users, auditors, and future contributors all
make the same assumptions.

### 1. Peer Chat is obfuscation, not encryption against an attacker

Peer Chat message bodies are encrypted with AES-256-GCM. The key is:

```js
crypto.createHash('sha256').update(ADMIN_DISCOVERY_ADDRESS, 'utf8').digest()
```

`ADMIN_DISCOVERY_ADDRESS` is a public, hardcoded value in
`electron/constants.cjs`. **Anyone can derive the key and decrypt any Peer
Chat message body.** This is verified and reproducible from public data only.

The intent is to keep casual readers of the chain from casually reading chat
messages. It provides **no** confidentiality against a motivated attacker.

The application states this in the Peer Chat info popover ("New posts use
AES-GCM with a key derived from the public admin address, so anyone can
reverse it"), on the feature card ("Publicly reversible"), and in the README.

**Do not use Peer Chat for anything you would not publish.**

### 2. On-chain content is permanent and public

- Peer Chat messages are written to the blockchain and cannot be deleted, even
  if the sender's keys are compromised afterwards.
- The optional note on a BSV send is a public `OP_RETURN`.
- A Peer Chat tip announcement embeds the **recipient's wallet address** in
  the message body. That address is permanently public and linkable to the
  sender and to any other transaction it has made.

### 3. The indexer learns your addresses

Balance, history, and token reads are address-based. BananaBlocks (and
anything able to observe traffic to it) learns which addresses you query and
when. There is no privacy layer, no coin mixing, and no address rotation.

### 4. SPV proves inclusion, not unspentness

The local header chain proves that a transaction was included in a block on a
chain the wallet validated. It does **not** prove that an output is still
unspent, and it does **not** validate every transaction in the chain. The
indexer remains the source of truth for current balances, history, and
external spend state, and the wallet will not sign from an unknown or stale
external spend status.

### 5. `ADMIN_DISCOVERY_ADDRESS` is a single point of failure and a privacy leak

Because every peer-trading order and peer-chat message is anchored to this one
public address:

- All participants and counterparties are visible to anyone watching it.
- Compromise or migration of the address is a project-wide event, not a
  per-user one.
- It cannot be "fixed" by moving it to a config file: peers need a stable,
  shared value for discovery to work at all.

### 6. Device mode inherits the OS key store's security

In passwordless mode the phrase is protected only as well as the operating
system's key store and the account it belongs to. On Linux, Electron's
`basic_text` backend is explicitly detected and rejected because it is not
encrypted by a real key store.

### 7. No additional protections are offered

- No multi-signature support.
- No hardware wallet or cold-storage signing.
- No coin control, UTXO labelling, or allowlists.
- No recipient screening, sanctions filtering, or policy engine.
- No auto-lock timer or idle timeout beyond the explicit Lock button and
  `before-quit`.
- The wallet is import-only: it never generates a recovery phrase.

---

## Wallet data location

**No wallet data is stored in this repository, and none ever should be.**

The running application stores everything in the Electron `userData`
directory, which on Windows resolves to:

```
%APPDATA%\lbsx-desktop-wallet\
```

| File | Contents | Protection |
|---|---|---|
| `wallet-vault.json` | The BIP39 recovery phrase | scrypt + AES-256-GCM, or `safeStorage` in device mode |
| `wallet-data\<sha256(address)>.enc` | The full per-wallet state document | AES-256-GCM, seed-derived key |
| `bananablocks-api-key.json` | Optional BananaBlocks API key | `safeStorage` |
| `spv\mainnet.headers` | Cached BSV mainnet block headers | Public chain data, unencrypted |

To remove every trace of a wallet, delete the `lbsx-desktop-wallet` folder in
`%APPDATA%` (or `%APPDATA%\LBSX Desktop Wallet` for an installed build) and
clear the app's OS key-store entry if passwordless mode was used.

---

## Reporting a false positive

Some scanners flag `electron/constants.cjs` for "hardcoded key material" and
`electron/peer-chat-crypto.cjs` for "weak key derivation". Both are expected
and are **not** vulnerabilities:

- The address is a public discovery anchor, not a secret.
- The Peer Chat key is intentionally derived from public data. The
  application already discloses the property to users.

The `.gitignore` also lists `wallet-vault.json`, `wallet-data/`, `*.enc`,
`mainnet.headers`, and `bananablocks-api-key.json` so that a misconfigured
local run cannot accidentally stage real wallet state.

---

## Supported versions

| Version | Supported |
|---|---|
| 1.2.x | ✅ |
| < 1.2 | ❌ |

Please upgrade to the latest release before reporting an issue.
