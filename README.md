# LBSX Desktop Wallet

**Local-first BSV and BSV-21 desktop wallet for Windows.** Keys never leave your
computer, balances are verified against your own SPV header chain, and BSV-21
tokens, locks, peer trading, and peer chat are built and signed locally.

> **Version 1.2.1** (shown in the app as `v1.2.01`) · MIT licensed · Windows x64
> · Electron 39 + React 18 + Vite 6

LBSX Desktop Wallet is a local-first Electron wallet for BSV and BSV-21 assets.
Private keys are derived and used on this device; [BananaBlocks](https://bananablocks.com/)
provides public chain reads and transaction broadcasts. There is no hosted
account, no server-side key custody, and no telemetry.

This repository is the full application source. It contains **no wallet data,
no keys, and no build artifacts** — see
[Where wallet data is stored](#what-is-stored-on-disk).

---

## Table of contents

- [Why LBSX](#why-lbsx)
- [Is it safe? Does it solve real problems? Does it scale?](#is-it-safe-does-it-solve-real-problems-does-it-scale)
  - [1. Is the wallet safe?](#1-is-the-wallet-safe)
  - [2. Does it solve real problems?](#2-does-it-solve-real-problems)
  - [3. Does the wallet scale?](#3-does-the-wallet-scale)
  - [Import-only by design: LBSX never generates a recovery phrase](#import-only-by-design-lbsx-never-generates-a-recovery-phrase)
- [Feature overview](#feature-overview)
- [How it works](#how-it-works)
  - [Architecture](#architecture)
  - [The sync → verify → save pipeline](#the-sync--verify--save-pipeline)
  - [How data is saved after syncing](#how-data-is-saved-after-syncing)
  - [What is stored on disk](#what-is-stored-on-disk)
  - [Atomic writes and concurrency](#atomic-writes-and-concurrency)
  - [SPV header chain and reorganisation handling](#spv-header-chain-and-reorganisation-handling)
- [Security model](#security-model)
- [Feature deep dives](#feature-deep-dives)
- [Installation](#installation)
- [Development](#development)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Why LBSX

Most BSV wallets fall into one of two camps: custodial web wallets, or
full-node SPV clients that download and verify the entire chain.

LBSX takes a third path that we think is the right trade-off for a desktop
wallet that is about to be used with real money:

| | LBSX | Custodial web wallet | Full node |
|---|---|---|---|
| Key custody | **Local, yours** | Vendor server | Local |
| Chain verification | **Local SPV header chain** | Vendor server | Full |
| Indexer dependency | BananaBlocks (read/broadcast) | Vendor server | None |
| Backup burden | Your recovery phrase | Vendor | Your node |
| Key generation | **None — import only** | Vendor | Varies |
| Open source | **Yes (MIT)** | No | Yes |

The properties we optimised for:

- **Keys are yours, always.** The recovery phrase is imported on your machine,
  encrypted at rest, and decrypted only in Electron's main process. The
  renderer never receives it. There is no key-generation flow and no server
  copy of your seed.
- **The wallet verifies for itself.** A spendable balance is not "what the API
  said" — it is a UTXO whose parent transaction carries a BEEF Merkle proof
  that the wallet checked against a header chain it validated itself, anchored
  at the BSV genesis block.
- **The cache is an accelerator, not an oracle.** The encrypted local store
  makes repeat syncs fast and lets the wallet chain unconfirmed transactions.
  It never substitutes for current network state, and the wallet refuses to
  sign from an unknown or stale spend status.
- **Everything is inspectable.** The entire sync, verification, and persistence
  path is in this repository in plain JavaScript.
- **The wallet never generates a recovery phrase.** It has no key-generation
  code at all. You import a BIP39 phrase you already hold — typically from
  LocalBSV or your existing BSV wallet — and the wallet derives your keys from
  it on your machine. See
  [Import-only by design](#import-only-by-design-lbsx-never-generates-a-recovery-phrase)
  for why this is a deliberate choice.

---

## Is it safe? Does it solve real problems? Does it scale?

Three questions, answered honestly — including where the answer is "not
yet". Numbers in this section are measured from this codebase and this
machine, not estimated.

### 1. Is the wallet safe?

**Short answer: yes for the threat model it targets, and no for a few specific
things it deliberately does not cover.** Being precise here is more useful than
being reassuring.

**What is genuinely strong:**

| Control | Evidence in the code |
|---|---|
| The renderer cannot reach your keys | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the bridge in `electron/preload.cjs` is a frozen allow-list of ~35 named methods. The phrase is never a bridge argument. |
| The phrase is encrypted at rest with a real KDF | scrypt at N=2^15, r=8, p=1 with a 64 MB memory cap, then AES-256-GCM. The memory cap is what makes it expensive, not the iteration count alone. |
| Key material is not left lying around | `getWalletPrivateKey()` zero-fills its buffer in a `finally`. `lockVault()` nulls the phrase reference; `before-quit` locks automatically. |
| A spendable balance is proven, not assumed | A UTXO is only "spendable" if its parent transaction carries a BEEF Merkle proof checked against a header chain this wallet validated itself, anchored at the BSV genesis header. |
| The state file cannot be corrupted or partially written | Temp file with `0o600` + the `wx` flag, then an atomic `rename()`. A per-file write queue serialises every read-modify-write cycle. |
| A partially broadcast transaction cannot be silently lost | `broadcastTrackedTransaction` persists the transaction **before** broadcasting, and reserves its inputs in a blocklist so a concurrent action cannot spend them twice. |

**What is honestly weak, and why it is a design choice rather than an oversight:**

- **Peer Chat is obfuscation, not encryption.** Its key is `sha256(ADMIN_DISCOVERY_ADDRESS)`, and that address is public in the source. Anyone can derive the key and read the messages. The app says so in the Peer Chat info popover, on the feature card, and in `SECURITY.md`. Do not use it for anything you would not publish.
- **The wallet trusts one indexer.** Every network read and every broadcast goes to `bananablocks.com` (verified: it is the only external host referenced anywhere in `electron/`). The wallet never *trusts* that indexer for spend decisions — it verifies inclusion itself — but it does trust it for *availability* and for current unspent state.
- **Single-signature, import-only.** There is no multisig, no hardware-wallet signing, no coin control, no recipient screening, and no auto-lock timer beyond the explicit Lock button.
- **SPV proves inclusion, not unspentness.** The header chain proves a transaction is in a block. It does not prove an output is still unspent. The indexer remains the source of truth for that, and the wallet will not sign against an unknown or stale external spend status.

**The security centre in the app** reports vault state, the active address, the
derivation path (`m/44'/236'/0'/0/0`), and a one-click lock, so the user can
confirm which wallet is actually open instead of assuming it.

Full detail, including the complete list of non-goals, is in
[`SECURITY.md`](./SECURITY.md).

### Import-only by design: LBSX never generates a recovery phrase

**This is a deliberate design choice, not a missing feature.** LBSX Desktop
Wallet has no "create new wallet" button, and it contains no key-generation
code at all. There is no `generateMnemonic`, no `entropyToMnemonic`, no seed
word generator anywhere in the codebase. The only way a wallet comes into
existence is by **importing a BIP39 recovery phrase the user already holds.**

Verified in the code: `electron/vault.cjs` exposes exactly one creation path,
`importVault()`, which validates the phrase with `bip39.validateMnemonic()`
and refuses to run if a vault already exists. The renderer exposes exactly one
corresponding bridge method, `importSeedPhrase`. The Security Centre in the
app states it plainly: *"No key-generation action exists in this wallet."*

**Why we made this choice:**

- **It removes the single most common way people permanently lose money.** In
  a generate-then-display flow, the wallet renders twelve or twenty-four
  words on screen and asks the user to copy them onto paper. That is a
  high-stakes, high-friction moment, and it is a moment the user cannot
  independently verify: they have no existing copy to compare against, and
  they cannot tell a correct backup from a subtly wrong one until it is too
  late. By never generating, LBSX removes that failure mode entirely. There is
  no phrase to mistype because there is no phrase to type.
- **The user already has a proven backup.** An imported phrase came from
  somewhere the user chose — a hardware wallet, a phone wallet, a written
  backup they have already tested. Their recovery path is already established
  and already their responsibility. LBSX inherits that path instead of
  creating a second, competing one.
- **It removes a whole class of disclosure risk.** A generated phrase must be
  displayed, and therefore exists, at least momentarily, on a screen. That
  means it can be shoulder-surfed, captured in a screenshot, exposed by a
  screen-share, left in a clipboard, or captured by a screen recorder. An
  imported phrase is **never displayed at all** — the app confirms this in the
  Security Centre: *"The phrase is not displayed or copied from this screen.
  Keep your original backup in a secure, offline location."* LBSX does not
  show your phrase, does not offer to reveal it, and does not copy it to the
  clipboard. It only ever validates and stores it.
- **The wallet never becomes an issuer of your identity.** A generator is a
  party that mints your wallet and then depends on you to protect what it
  gave you. LBSX is deliberately a *client* of a wallet you already own. It
  derives `m/44'/236'/0'/0/0` from a phrase you brought; it does not author
  the phrase.
- **It is the honest path for existing LocalBSV customers.** These users
  already have a BSV wallet and a working recovery phrase behind it. LBSX's
  job is to let them bring that wallet — and the funds already in it — onto
  their own machine, with their own keys, verifiable against the chain. It is
  not their job to create a second, parallel wallet just to use a desktop
  app. The obligation to generate, back up, and protect a phrase is left
  exactly where it already was: with the user, and with the wallet they
  already use.

**The trade-off, stated plainly.** A brand-new user who has never held a BSV
wallet cannot onboard into LBSX directly, because there is no phrase for them
to import yet. They need to bootstrap a phrase elsewhere first, or use a
wallet that does generate. That is a real onboarding friction point, and it is
listed in [Known limitations](#known-limitations). We accept it: the failure
mode it prevents (a user permanently losing money to a botched backup they
were told to make) is far more expensive than the friction it creates, and
LBSX's audience is overwhelmingly people who already have a BSV wallet.

### 2. Does it solve real problems?

**Yes — but the problems it solves are specific, and in two areas the honest
answer is "it is early".**

**Real problems, genuinely solved:**

- **"I do not trust a vendor with my coins."** The phrase is imported on your
  machine, encrypted at rest, and never crosses a process boundary. There is no
  account, no server-side custody, and no telemetry. A custodial wallet can lose
  your balance to an outage, an insolvency, or a policy change; LBSX cannot.
- **"I do not want to run a full node."** A full BSV node is hundreds of
  gigabytes. LBSX validates a header chain from genesis and verifies Merkle
  proofs against it, which is the 80-bytes-per-block subset that actually
  matters for proving inclusion. You get cryptographic verification without the
  disk cost or the setup burden.
- **"Most BSV wallets treat tokens as a checkbox."** LBSX implements the
  actual BSV-21 mechanics: a token mint that atomically carries an Ordinals
  image, a lock that splits a balance into 1–24 time-locked tranches using
  `OP_CHECKLOCKTIMEVERIFY`, and a claim path that matures and releases them.
  These are the operations a real holder needs and that a generic wallet
  omits.
- **"I want to trade peer-to-peer without a custodian."** The order book is
  discovered from the chain itself, anchored to a shared public address, and
  every listing is re-verified against the live unspent `OrdLock` output before
  a purchase is built. There is no escrow operator and no custodial float.
- **"My wallet history should be mine."** Activity, balances, transaction
  proofs, and peer-chat messages are stored in an encrypted, wallet-scoped
  document under your own machine, not on someone else's account.
- **"I want to audit it."** The full sync, verification, sign, broadcast, and
  persistence path is plain JavaScript in this repository, and every
  persistence-format change is covered by an offline test.

**Honest "not yet":**

- **The peer-to-peer trading ecosystem is a fixed point of a fixed point.** It
  needs other LBSX users to actually list tokens, and it needs those users to
  be online. Until then the order book is mostly empty, and a token you mint
  has no guaranteed exit. This is the single biggest thing holding the feature
  back, and it is a *liquidity* problem, not a code problem.
- **The single indexer is a genuine single point of failure.** If
  BananaBlocks is down, unreachable, or changes its API, the wallet cannot
  read balances or broadcast. The architecture anticipates this — the code
  refers to a single `BB_API` constant per module in every case — but no
  alternative provider is wired in yet.
- **No hardware-wallet support.** For a wallet meant to hold real money, a
  USB signer is the obvious next requirement, and it is not here.
- **Windows x64 only.** No macOS, Linux, or ARM build.

### 3. Does the wallet scale?

**Three different senses of "scale", with three different answers. Measured
against this machine and this codebase:**

**Does it scale in *time* (how long does a sync take)?** Yes, with one
important caveat.

- The header chain downloads 80 bytes per block. Measured on this machine:
  **77,763,840 bytes = 74.2 MB = 972,048 headers**, i.e. the full chain from
  genesis to the current tip.
- Headers are fetched in parallel ranges of up to 2016 blocks, 4 concurrent
  requests, paced at 300 ms, with retry on 429 — so the first sync is
  bandwidth-bound, not round-trip-bound.
- The header cache is written to `userData/spv/mainnet.headers` and is
  **validated once, then trusted**, so subsequent syncs only fetch the new
  blocks. A daily sync after the first is a handful of headers, not 74 MB.
- **The caveat:** that 74.2 MB is downloaded *once*, on first run, and it
  grows forever at 80 bytes per block (~2.6 MB/year, since BSV averages
  roughly 10-minute blocks). That is a completely reasonable trade for full
  inclusion proof, and it is far smaller than a full node, but it is not zero
  and it is not zero-*growth*.
- History sync is **incremental and cursor-paginated**: pages of 100 rows,
  following an opaque continuation cursor, and it stops as soon as a page
  contains no unseen txids. On an established wallet that is typically one
  request, not a full re-scan. A cold wallet backfills up to 500 pages
  (50,000 rows) and then records that it is complete.

**Does it scale in *state size* (how big does my wallet data get)?** Yes, with
a bounded upper bound on the hot paths.

- The encrypted state document is a single JSON blob. Measured on this
  machine after real use: **3.63 MB**.
- The growth drivers are all explicitly capped in the code:
  `observedBsvUtxos` → 5,000; admin index transactions → 5,000; admin pending
  → 1,000; activity detail lookups per sync → 500; Peer Chat feed → the last
  150 messages; BEEF proof size → 32 MB ceiling.
- Activity rows are **merged by txid, not appended** — a re-sync of a known
  transaction updates the existing row rather than adding one, so repeated
  syncs do not grow the file.
- The cost is that the whole document is re-serialised and re-encrypted on
  every write, and the write is serialised through one queue. At 3.6 MB that
  is a few milliseconds; at 100 MB it would not be. This is fine for a
  personal wallet and would need a different storage engine for a high-volume
  one.

**Does it scale in *reach* (how many users, how much throughput)?** This is
where the honest answer is **not yet**, and it is worth being blunt:

- Every user is a **read-mostly client of one indexer**. The wallet does not
  run a node, does not serve other wallets, and does not shard. Peak load is
  whatever BananaBlocks can serve.
- Each wallet's first sync is a ~74 MB header download. Ten thousand new
  users on the same day is ten thousand header downloads, even though the
  bytes are identical for all of them.
- The app is a single desktop process with a **single in-memory write queue
  per state file** and a **single global SPV sync promise**. That is correct
  and safe for one wallet, and it is not designed for multi-tenant or
  server-side use.
- There is no fee market and no priority routing; broadcast is first-come.

**The bottom line on scale:** the wallet scales well for **individual users
and modest numbers of users**. It does not yet scale as a *shared
infrastructure*, and it is not trying to be one — it is a desktop wallet, and
the honest framing is that a 74 MB one-time download and a single indexer are
reasonable trade-offs for a personal wallet, while a serious exchange or a
validator would need a different design.

---

## Feature overview

| Area | What it does |
|---|---|
| **Vault** | Import an existing BIP39 phrase. There is **no** key-generation flow, by design. Two lock modes: a local password (scrypt + AES-256-GCM) or passwordless OS key-store encryption. |
| **Overview** | Confirmed/unconfirmed BSV balance, spendable BSV, BSV-21 holdings, one-tap balance sync with live progress. |
| **Assets** | Per-token balance, send, receive (QR), and the time-lock locker. |
| **Send / Receive** | BSV payments with an optional public note, or a BSV-21 token transfer. |
| **Activity** | Encrypted, wallet-scoped ledger with per-transaction net debit, change, and fee. Paginated 6 rows per page. |
| **Trading** | Peer-to-peer BSV-21 order book: list, buy, cancel, and live order discovery. |
| **BSV-21 Tools** | Mint a fixed-supply BSV-21 token with an embedded PNG/JPEG/WebP icon, atomically. |
| **Peer Chat** | On-chain messages anchored to a shared discovery address. |
| **Security center** | Vault status, active address, derivation path, and one-click lock. |
| **API key** | Optional BananaBlocks API key, encrypted with the OS key store. |

---

## How it works

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer  (src/*.jsx, sandboxed)                            │
│  React UI. Never sees the phrase, the private key, or raw    │
│  key material. Receives only the public address + summary.   │
└───────────────────────────┬──────────────────────────────────┘
                            │  contextBridge (electron/preload.cjs)
                            │  frozen, allow-listed API surface
┌───────────────────────────▼──────────────────────────────────┐
│  Main process  (electron/*.cjs)                              │
│  ┌──────────┐  ┌───────────┐  ┌────────┐  ┌──────────────┐  │
│  │  vault   │  │ wallet-   │  │  spv   │  │ token-wallet │  │
│  │ (keys)   │  │   data    │  │ (chain)│  │  (BSV-21)    │  │
│  └────┬─────┘  └─────┬─────┘  └───┬────┘  └──────┬───────┘  │
│       │               │             │              │          │
│  ┌────▼───────────────▼─────────────▼──────────────▼───────┐  │
│  │  chain.cjs · trading.cjs · market.cjs · peer-chat.cjs   │  │
│  │  transaction-tracker.cjs · admin-wallet-index.cjs       │  │
│  └───────────────────────┬──────────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │ HTTPS
                  ┌────────▼─────────┐
                  │   BananaBlocks   │  indexer + node + broadcast
                  └──────────────────┘
```

**Key files**

| File | Responsibility |
|---|---|
| `electron/main.cjs` | App lifecycle, window hardening, all IPC handlers. |
| `electron/preload.cjs` | The only renderer↔main bridge. Frozen allow-list. |
| `electron/vault.cjs` | Key custody: import, unlock, lock, derivation, key material. |
| `electron/wallet-data.cjs` | Encrypted persistence: the per-wallet state file. |
| `electron/spv.cjs` | Header chain validation, BEEF proof verification, reorgs. |
| `electron/chain.cjs` | Sync orchestration: balances, UTXOs, tokens, activity history. |
| `electron/token-wallet.cjs` | BSV/BSV-21 send, mint, lock, claim, peer-chat payloads. |
| `electron/market.cjs` | Order book, listing, purchase, cancellation. |
| `electron/trading.cjs` | Discovery: finds peer orders via the admin wallet. |
| `electron/admin-wallet-index.cjs` | Scans the admin wallet's history for peer activity. |
| `electron/peer-chat.cjs` | Parses and indexes on-chain chat messages. |
| `electron/transaction-tracker.cjs` | Persist-before-broadcast, status reconciliation. |
| `electron/bananablocks.cjs` | API-key storage and authenticated requests. |
| `electron/explorer.cjs` | Validated BananaBlocks explorer deep links. |
| `electron/constants.cjs` | The public discovery address. |

### The sync → verify → save pipeline

This is the heart of the wallet. A **balance sync** is the following sequence:

```
  ┌─ 1. RECONCILE ────────────────────────────────────────────┐
  │  Scan locally tracked transactions for a definitive        │
  │  rejection and release their reserved inputs.              │
  └──────────────────────────────┬─────────────────────────────┘
                                 ▼
  ┌─ 2. FETCH (3 requests in parallel) ───────────────────────┐
  │  GET /bsv/main/address/{addr}/balance                     │
  │  GET /address/{addr}/tokens                                │
  │  GET /bsv/main/address/{addr}/unspent?limit=500            │
  └──────────────────────────────┬─────────────────────────────┘
                                 ▼
  ┌─ 3. OBSERVE (unverified) ─────────────────────────────────┐
  │  The raw unspent list is recorded as "observed" UTXOs.     │
  │  These are a hint, NOT a spendable balance.                │
  │  If the response was complete (<500 rows), any verified     │
  │  UTXO missing from it is marked spent.                     │
  └──────────────────────────────┬─────────────────────────────┘
                                 ▼
  ┌─ 4. VERIFY (SPV) ─────────────────────────────────────────┐
  │  For each candidate UTXO:                                  │
  │    a. Ensure the local header chain is current.            │
  │    b. Fetch the parent transaction's BEEF proof.           │
  │    c. Check the Merkle proof against the header chain.     │
  │    d. Check PoW, difficulty, linkage, MTP, and the tip.    │
  │    e. Confirm the output script + value match the cache.   │
  │  Only now is a UTXO marked verified + spendable.          │
  └──────────────────────────────┬─────────────────────────────┘
                                 ▼
  ┌─ 5. CACHE (encrypted) ────────────────────────────────────┐
  │  Verified BSV UTXOs, verified token UTXOs, and their BEEF  │
  │  proofs are written to the encrypted wallet-data file.     │
  └──────────────────────────────┬─────────────────────────────┘
                                 ▼
  ┌─ 6. SNAPSHOT ─────────────────────────────────────────────┐
  │  A single chain snapshot is written: balance, token list,  │
  │  spendable/pending sat totals, per-section timestamps,    │
  │  and per-section error strings.                            │
  └────────────────────────────────────────────────────────────┘
```

Two design points worth calling out:

- **Observed ≠ verified.** The indexer's unspent list is stored in a separate
  `observedBsvUtxos` bucket precisely so that unverified data can never be
  mistaken for spendable funds. Only rows in `bsvUtxos` / `tokenUtxos` with
  `verified: true` (and, for confirmed outputs, `spvVerified: true`) can be
  spent.
- **Failure is partial, not total.** Each of the three fetch sections records
  its own error string. A token outage does not erase your BSV balance, and a
  UTXO verification failure does not discard the rest of the cache. The
  snapshot records all three error slots independently.

### How data is saved after syncing

Everything below is written to **one encrypted file per wallet address**:
`%APPDATA%\lbsx-desktop-wallet\wallet-data\<sha256(address)>.enc`.

The on-disk envelope is:

```json
{
  "version": 1,
  "addressHash": "e308f0d…2a4bd",
  "iv": "<base64, 12 random bytes>",
  "tag": "<base64, 16-byte GCM auth tag>",
  "ciphertext": "<base64, AES-256-GCM ciphertext of the JSON state>"
}
```

The plaintext inside that envelope is the wallet's entire state document:

```jsonc
{
  "version": 1,
  "address": "1ABC…",

  // ── What the wallet owns ────────────────────────────────────
  "importedTokens": [],       // BSV-21 tokens the user added by origin ID
  "tokenLocks": [],           // locker records (tranche, schedule, txid, status)

  // ── The ledger ──────────────────────────────────────────────
  "activities": [],           // merged activity rows, keyed by txid
  "transactions": [],         // wallet-created txs: raw hex, inputs, outputs, status

  // ── Spendable state ─────────────────────────────────────────
  "bsvUtxos": [],             // verified BSV UTXOs (script + raw tx bytes)
  "tokenUtxos": [],           // verified BSV-21 UTXOs (token id + amount)
  "observedBsvUtxos": [],     // indexer's unspent list — NOT verified
  "proofs": [],               // BEEF proofs, keyed by txid

  // ── Chain position ──────────────────────────────────────────
  "chainSnapshot": null,      // last successful balance snapshot
  "headerChain": null,        // tip height, tip hash, chain work, digest

  // ── Sync bookkeeping ────────────────────────────────────────
  "lastActivitySyncAt": null,
  "lastTransactionStatusCheckAt": null,
  "lastUtxoSyncAt": null,
  "historyBackfillComplete": false,
  "historyCursor": null,      // opaque BananaBlocks continuation cursor
  "historyPageCursor": 0,
  "historyBackfillQueue": [], // refs still awaiting a detail lookup

  // ── Peer Chat cache ─────────────────────────────────────────
  "peerChatMessages": [],
  "peerChatLastScannedTxid": null,
  "peerChatSyncedAt": null,

  // ── Admin-wallet discovery index ────────────────────────────
  "adminWalletTransactions": [],
  "adminWalletPendingTransactions": [],
  "adminWalletLastScannedTxid": null,
  "adminWalletSyncedAt": null,
  "adminWalletHistoryCursor": null,
  "adminWalletHistoryComplete": false
}
```

**The write path, in order:**

1. `updateWalletData(address, updater)` acquires a per-file write queue.
2. The current file is read and decrypted.
3. Your `updater` mutates the in-memory state.
4. `validateData()` re-checks the shape, the version, and that the state's
   address matches the requested address. Optional fields are sanitised and
   defaulted.
5. The state is serialised, encrypted with AES-256-GCM under a fresh random
   12-byte IV, and written to a temp file with mode `0o600` and the `wx` flag
   (exclusive create).
6. The temp file is `rename()`d over the target. `rename` is atomic on both
   NTFS and POSIX filesystems, so a crash mid-write can never leave a
   half-written state file.
7. If any step fails, the temp file is unlinked and the error propagates.

**The encryption key** is derived with HKDF-SHA256 from the BIP39 seed:

```
HKDF-SHA256(
  ikm  = bip39.mnemonicToSeedSync(mnemonic),
  salt = "LBSX Desktop Wallet local data v1",
  info = "wallet-data encryption",
  len  = 32
)
```

Because the key comes from the seed, the state file is useless without the
recovery phrase. It is also why the wallet cannot read its own cache while
locked — that is intentional.

**What gets written when**

| Trigger | What is written |
|---|---|
| Balance sync | `observedBsvUtxos`, verified `bsvUtxos`/`tokenUtxos`, `proofs`, `chainSnapshot`, `lastUtxoSyncAt` |
| Activity sync | `activities`, `transactions`, `historyCursor`, `historyPageCursor`, `historyBackfillQueue`, `historyBackfillComplete`, `lastActivitySyncAt` |
| Transaction status check | `transactions[].status`, `lastTransactionStatusCheckAt` |
| SPV header sync | `spv/mainnet.headers` (separate file), `headerChain`, `proofs` |
| Token send / mint / lock | `transactions`, `activities`, `tokenLocks`, `bsvUtxos`, `chainSnapshot` |
| Peer Chat sync | `peerChatMessages`, `peerChatLastScannedTxid`, `peerChatSyncedAt` |
| Trading discovery | `adminWalletTransactions`, `adminWalletPendingTransactions`, `adminWalletHistoryCursor` |

### What is stored on disk

All wallet state lives in the Electron `userData` directory, **never inside
the project folder** and never in the repository. On Windows this resolves to:

```
%APPDATA%\lbsx-desktop-wallet\
```

| File | Contents | Protection |
|---|---|---|
| `wallet-vault.json` | The BIP39 recovery phrase | **v2 password mode:** scrypt (N=2^15, r=8, p=1, 64 MB maxmem) → AES-256-GCM with a 16-byte salt, 12-byte IV, 16-byte tag. **v2 device mode:** Electron `safeStorage` (OS key store). Legacy v1 envelopes still decrypt. |
| `wallet-data\<sha256(address)>.enc` | The entire per-wallet state document described above | AES-256-GCM, HKDF-SHA256 key derived from the wallet seed, available only while the vault is unlocked |
| `bananablocks-api-key.json` | Optional BananaBlocks API key | Electron `safeStorage`; sent only to `bananablocks.com` as `X-API-Key` |
| `spv\mainnet.headers` | Cached BSV mainnet block headers | Public chain data only, unencrypted |
| `token-locks.json` | Legacy locker records | Migrated into the encrypted store on first load, then removed from use |

The recovery phrase and the private key never leave the main process. The
renderer receives only the derived public address and the wallet summary. When
the wallet locks (manually, or on `before-quit`), the in-memory phrase
reference is nulled and the derived key buffers are zero-filled.

To remove every trace of a wallet, delete the `lbsx-desktop-wallet` folder in
`%APPDATA%` (or `%APPDATA%\LBSX Desktop Wallet` for an installed build) and
clear the app's OS key-store entry if passwordless mode was used.

### Atomic writes and concurrency

Two independent mechanisms keep the state file consistent:

- **Per-file write queue.** `updateWalletData()` chains each mutation onto a
  promise stored in a `Map` keyed by file path. A read-modify-write cycle
  never interleaves with another, so two concurrent syncs cannot clobber each
  other's changes. `getWalletData()` awaits any in-flight write before
  reading.
- **Atomic replace.** Writes go to a uniquely named temp file and are
  `rename()`d into place. There is no window where the state file is
  truncated or partially written.

This matters because a balance sync, an activity sync, and a transaction
broadcast can all write to the same file at once.

### SPV header chain and reorganisation handling

The wallet maintains its own copy of the BSV mainnet header chain and uses it
to check BEEF proofs. It is not a full node: it does not validate every
transaction, only that the transactions it spends from were included in a
block on the chain it has independently validated.

- **Anchored at genesis.** The chain starts from the BSV genesis hash and
  header, both hardcoded as public constants.
- **Bounded ranges.** Headers are downloaded in ranges of at most 2,016
  blocks, with up to 4 ranges in flight, 300 ms between requests, and 3
  retries per request. The first sync may take several minutes and reports
  live progress in the UI.
- **Full validation per range.** Each header is checked for proof of work
  against the difficulty target, correct linkage to its predecessor, a valid
  median-time-past, and a timestamp no more than 2 hours in the future. The
  running chain work is accumulated as a BigInt.
- **Fork rules respected.** The BSV cash fork (height 478,559) and the DAA
  activation (height 504,032) are both encoded.
- **Reorgs are detected, not assumed away.** On each sync the wallet compares
  its local tip against the remote tip. If the hashes disagree it walks back
  to find the **common ancestor**, truncates the cache to the last aligned
  boundary, re-validates the surviving prefix, and continues from there.
  Cached proofs that no longer sit on the canonical chain are invalidated.
- **Proofs are versioned.** Header validation is at version 3 and BEEF proof
  validation at version 1. A cache written by an older build is detected and
  rebuilt rather than trusted.

SPV proves **inclusion**, not **unspentness**. The indexer remains the source
of truth for balances, history, and external spend state, and BananaBlocks is
still required to broadcast.

---

## Security model

### What the wallet protects

- **Key custody.** The phrase is encrypted at rest with a key derived either
  from your password (scrypt + AES-256-GCM) or from the OS key store
  (`safeStorage`). It is decrypted only in the main process, held in a
  module-level variable, and zeroed on lock.
- **Renderer isolation.** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. The renderer is served a frozen, allow-listed API through
  `contextBridge` and has no Node access. All window-opening is denied, and
  navigation is blocked except the dev server or the packaged `file://` page.
- **Local data encryption.** The whole state document is encrypted at rest
  with a seed-derived key, so the file is unreadable without the phrase.
- **Content Security Policy.** The packaged renderer runs under a strict CSP:
  `default-src 'self'`, `script-src 'self'`, `object-src 'none'`,
  `base-uri 'self'`, `frame-uri 'none'`.
- **SPV-verified spending.** The wallet refuses to sign from a UTXO it has
  not independently verified.
- **Write safety.** Atomic file replacement and per-file write queues prevent
  a corrupt or lost state file.

### What the wallet deliberately does *not* protect

This section is intentionally blunt. Please read it before using the wallet
with meaningful value.

- **Peer Chat is obfuscation, not secrecy.** Peer Chat message bodies are
  encrypted with AES-256-GCM under a key derived as `sha256(ADMIN_DISCOVERY_ADDRESS)`.
  That address is **public and hardcoded in this source**, so anyone can
  derive the key and decrypt any message body. The feature is intended to
  keep casual readers from reading the chain, not to hide anything from a
  motivated attacker. The app states this in the Peer Chat info popover and on
  the feature card.
- **Messages are permanently public.** Anything sent to Peer Chat is written
  to the blockchain and cannot be deleted, even if the sender's keys are
  compromised tomorrow. Treat every message as public.
- **On-chain notes are public.** The optional payment note on a BSV send is
  written as a public `OP_RETURN`. A tip announcement also embeds the
  recipient's wallet address in the message body, which is permanently
  public and linkable.
- **The indexer can see your address.** Balance and history reads are
  address-based, so BananaBlocks learns which addresses you query and when.
  There is no privacy layer or coin mixing.
- **No transaction screening.** The wallet does not filter recipients for
  sanctions or policy. That responsibility stays with the user.
- **The OS key store is the OS key store.** Device mode inherits the
  security of the OS account and its key store. On Linux, Electron's
  `basic_text` backend is explicitly detected and rejected, because it is not
  encrypted by a real key store.
- **No multi-sig, no hardware wallet, no signing policy.** This is a
  single-signature, single-recovery-phrase wallet.

See [`SECURITY.md`](./SECURITY.md) for the full disclosure policy and the
detailed threat model.

### A note on `ADMIN_DISCOVERY_ADDRESS`

`electron/constants.cjs` contains a single hardcoded address:

```js
ADMIN_DISCOVERY_ADDRESS: '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB',
```

This is **public by design** and is not a secret. It serves three roles:

1. A **discovery anchor** — a 1-satoshi output that address-history indexers
   can watch to find peer-trading orders and peer-chat messages.
2. A **fee anchor** — peer chat and trading transactions pay 1,000 satoshis
   to it, so a genuine participant pays a small, non-zero cost.
3. An **obfuscation key source** — the seed for the Peer Chat AES key, which
   is intentionally reversible (see above).

Because it is public, it is also a **single point of failure and a privacy
leak**: every peer-chat participant and every counterparty is visible to
anyone watching that address. This is a known, accepted trade-off of the
current design and is documented in `SECURITY.md`.

---

## Feature deep dives

### Vault and key custody

LBSX is an **import-only** wallet. There is no key-generation flow at all —
no `generateMnemonic`, no seed generator anywhere in the codebase — and that
is a deliberate choice. Generating a phrase is the one operation where a
subtle bug, a mistyped backup, or a shoulder-surfed screen can produce a
wallet whose owner can never recover the funds. LBSX removes that failure
mode by never asking you to trust a phrase it produced.

The full reasoning, including why this suits existing LocalBSV customers
specifically, is in
[Import-only by design](#import-only-by-design-lbsx-never-generates-a-recovery-phrase).

- **Derivation path:** `m/44'/236'/0'/0/0` (BIP44, BSV coin type 236).
- **The phrase is never displayed.** The wallet validates it, derives from
  it, and stores it encrypted — it has no "reveal phrase" or "copy phrase"
  function anywhere in the UI.
- **Password mode** enforces a minimum of 12 characters. The KDF is scrypt
  with N=2^15, r=8, p=1 and a 64 MB memory cap.
- **Device mode** uses `safeStorage.encryptString`. If the OS key store is
  unavailable, the wallet refuses to use device mode and says so.
- **Locking** nulls the in-memory phrase. `before-quit` locks the vault
  automatically.

### BSV-21 tokens

- **Import** any BSV-21 token by its full origin ID (e.g.
  `<txid>_1`). Imports are wallet-scoped and remain selectable in the market
  view even when the wallet holds no balance of that token.
- **Send** preserves the token amount in base units; any remainder is
  returned to the wallet as a BSV-21 transfer output.
- **Token carrier outputs are kept strictly separate from ordinary P2PKH fee
  inputs.** A token input is never accidentally spent as cash, and cash is
  never sent to a token script.
- **Icons** referenced by BSV-21 `_0` metadata are extracted from the wallet's
  locally tracked parent transaction first, falling back to the BananaBlocks
  transaction hex only when the image transaction is not cached. The same icon
  appears in Overview, Assets, and the Trading selector.

### The time-lock locker

Lock creation splits a token amount across **1–24 tranches** on a release
schedule (daily, weekly, monthly, or yearly). Each tranche is a separate
BSV-21 output with an `OP_CHECKLOCKTIMEVERIFY` clause, so the release time is
enforced by the consensus rules of the chain rather than by a cooperative
service. The final tranche absorbs the division remainder so no base units
are lost.

Claiming spends the matured CLTV output and returns the token amount to the
same wallet. A tranche can only be claimed after its unlock timestamp has
passed, and the on-chain inscription is re-checked against the local locker
record before the claim is signed — a mismatch aborts.

**Known limitation:** the current builders consume **one token carrier input
per transaction**. An action larger than the largest single verified output
is not yet combined across multiple token inputs.

### Minting a token

`BSV-21 Tools → Mint a token` creates a fixed-supply `deploy + mint` token in
**one atomic transaction**:

- **vout 0** — the icon, embedded as a 1-satoshi Ordinals output (PNG, JPEG,
  or WebP, up to 512 KB, with a magic-byte signature check).
- **vout 1** — the BSV-21 deploy output, referencing `_0` for the icon.
- **vout 2** — a 1-satoshi output to the admin discovery address for
  indexing.

Keeping the image and the deployment atomic avoids spending unconfirmed change
between two separate broadcasts. The supply must fit the BSV-21 amount range
(`2^64 - 1`), decimals are 0–18, and the ticker is 1–32 printable characters.
Fees are paid from verified wallet BSV UTXOs.

### Peer trading

The trading tab is a genuine peer-to-peer order book, not a hosted exchange.

- **Discovery.** Orders are found by scanning the admin discovery address's
  on-chain history. Each order is announced with a public `OP_RETURN` JSON
  record (`p: 'lbsx'`, `op: 'sell'`) alongside a 1-satoshi anchor payment, and
  the token amount is locked in an `OrdLock v2` output.
- **Live verification.** Before a listing is shown, the wallet re-checks that
  the anchor output is present, the order JSON matches, the `OrdLock` decodes
  to the same token id, amount, seller, and price, and the locked output is
  still **unspent**. A spent listing is dropped from the book.
- **Listing.** The token amount is locked to the seller's address with the
  asking price; change returns as a normal BSV-21 transfer.
- **Purchase.** The buyer spends the listing output via the `OrdLock`
  purchase template, receiving the token and returning the price.
- **Cancellation.** Only the owner can cancel, and the on-chain lock is
  checked against the wallet's own address first.
- **Isolation.** The parser tolerates other applications' `OP_RETURN`
  payloads on the same chain instead of failing on them.

**Known limitation:** discovery is anchored to the admin address, so it finds
fee-linked activity rather than a complete global order book. See
[`TRADING-PLAN.md`](./TRADING-PLAN.md) for the precise boundaries of this
design.

### Peer Chat

Peer Chat messages are written to the chain in a `safe` data output:

```
['LBSX', 'v2', 'peer_chat', <sender address>, <timestamp>, <base64 ciphertext>]
```

- 1,000 satoshis are paid to the admin discovery address.
- The body is AES-256-GCM encrypted under a **publicly derivable** key — see
  [the security model](#what-the-wallet-deliberately-does-not-protect).
- A message is only accepted as authentic if the sender's address appears
  among the transaction's input addresses, and if the transaction is
  confirmed.
- The local cache keeps the most recent 150 messages.

### Activity history

Activity refresh is incremental and designed for long-lived wallets:

- It retrieves confirmed and unconfirmed address history and **merges rows by
  txid**, so already-loaded transactions are never duplicated.
- After the initial backfill completes, a refresh scans the newest history
  pages until it reaches a page containing **no unseen transaction IDs**. It
  does not use a five-old-transaction threshold, so a wallet that receives
  many transactions in a burst still catches up completely.
- Detail requests are issued only for **new** rows, rows whose confirmation
  height changed, or rows whose previous lookup failed.
- It follows BananaBlocks' opaque continuation cursors for up to **500 index
  pages** and **500 transaction details** per refresh, paces requests to a
  minimum of 250 ms, and retries rate-limited responses up to 3 times.
- Failed and deferred lookups are preserved in the encrypted store, along with
  the page cursor, so the next refresh resumes instead of starting over.
- Pending local transactions are also checked against BananaBlocks' status
  endpoint when history still reports height 0, so a mined transaction can
  update the ledger and the local UTXO state without waiting for the history
  index to catch up.

The ledger shows 6 rows per page and clearly labels partial history as
"loaded so far" rather than presenting a truncated view as complete.

---

## Installation

### Windows installer

```powershell
npm ci
npm run dist:win
```

This produces an NSIS installer in `release-windows-1.2.1/`. It adds Start menu
and desktop shortcuts and launches the wallet when installation finishes.
Users then open **LBSX Desktop Wallet** like any other desktop application —
no command prompt required.

> The installer is currently **unsigned**, so Windows will show its standard
> unknown-publisher prompt.

The `package.json` version is the canonical SemVer `1.2.1`; the wallet UI
presents it as `v1.2.01`.

---

## Development

**Requirements:** Node.js LTS and Windows.

### One-click

Double-click **`Run Wallet.bat`**. It installs the dependencies on first run
and opens the desktop app.

### Terminal

```powershell
npm ci
npm run dev
```

`npm run dev` starts Vite on `127.0.0.1:5173` and launches Electron against
it. `npm run build` builds the renderer into `dist/`.

### Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Vite dev server + Electron. |
| `npm run build` | Build the renderer to `dist/`. |
| `npm run dist:win` | Build and package the Windows installer. |
| `npm start` | Run Electron against an existing build. |

---

## Testing

Every suite runs **offline** against synthetic fixtures and a mocked
broadcaster. None of them broadcast a mainnet transaction, and none of them
use a real wallet phrase — the BIP39 test vector `abandon … about` is the
published standard test vector, and test keys are derived from fixed
`Buffer.alloc` byte patterns.

| Script | Covers |
|---|---|
| `npm run test:wallet-data` | Encrypted wallet-scoped imports, balance snapshots, sync-time verification and caching, local-only input selection after sync, pagination beyond 100 history records, rate-limit retry and queue recovery, legacy locker migration, UTXO state changes, and 0-conf chaining. |
| `npm run test:token-wallet` | Token send conservation, lock tranche scripts, local locker persistence, and a matured claim. |
| `npm run test:token-mint` | Atomic Ordinals image + BSV-21 deployment, mint metadata, local token tracking, fee/change accounting, and the admin index output. |
| `npm run test:spv` | Genesis anchoring, BEEF inclusion, and invalid proof rejection. |
| `npm run test:trading` | Trading transaction construction. |
| `npm run test:discovery` | Trading discovery snapshot. |
| `npm run test:admin-index` | Admin-wallet index synchronisation. |
| `npm run test:peer-chat` | Peer chat parsing and crypto. |
| `npm run test:bsv-send` | BSV send construction and conservation. |
| `npm run test:bananablocks-key` | Encrypted API-key storage, enable/disable, and header scoping. |
| `npm run test:explorer` | Transaction/token explorer URL routing. |
| `node scripts/e2e-smoke.mjs` | Both vault modes in isolated temporary profiles. |
| `npm run test:packaged` | The packaged app's token-image rendering. |

Run everything:

```powershell
npm run test:wallet-data
npm run test:token-wallet
npm run test:token-mint
npm run test:spv
npm run test:trading
npm run test:discovery
npm run test:admin-index
npm run test:peer-chat
npm run test:bsv-send
npm run test:bananablocks-key
npm run test:explorer
```

The smoke tests honour `LBSX_TEST_USER_DATA_DIR` to isolate their data
directory, but only when the app is not packaged, or when
`LBSX_TEST_PACKAGED=1` is also set. A packaged build will never redirect its
data directory from an environment variable alone.

---

## Project layout

```
LBSX Desktop Wallet/
├── electron/                  # Main process (Node, CommonJS)
│   ├── main.cjs               #   lifecycle, window hardening, IPC
│   ├── preload.cjs            #   the renderer bridge
│   ├── vault.cjs              #   key custody
│   ├── wallet-data.cjs        #   encrypted persistence
│   ├── spv.cjs                #   header chain + BEEF proofs
│   ├── chain.cjs              #   sync orchestration
│   ├── token-wallet.cjs       #   BSV / BSV-21 / lock / chat builders
│   ├── market.cjs             #   order book, list, buy, cancel
│   ├── trading.cjs            #   discovery
│   ├── admin-wallet-index.cjs #   admin-wallet history scanning
│   ├── peer-chat.cjs          #   chat parsing
│   ├── peer-chat-crypto.cjs   #   chat obfuscation
│   ├── transaction-tracker.cjs#   persist-before-broadcast
│   ├── bananablocks.cjs       #   API key + authenticated fetch
│   ├── explorer.cjs           #   validated deep links
│   └── constants.cjs          #   the public discovery address
├── src/                       # Renderer (React, ES modules)
│   ├── App.jsx                #   shell + Overview, Activity, Security
│   ├── TradingPage.jsx
│   ├── Bsv21ToolsPage.jsx
│   ├── PeerChatPage.jsx
│   ├── TokenIcon.jsx
│   ├── ExplorerReference.jsx
│   └── *.css
├── scripts/                   # Offline smoke tests
├── assets/                    # Icons and branding
├── index.html                 # Vite entry + CSP
├── vite.config.js
├── package.json               # Canonical version 1.2.1
├── TRADING-PLAN.md            # Trading design and its limits
├── SECURITY.md                # Disclosure policy and threat model
├── CONTRIBUTING.md            # Contributor guide
└── LICENSE                    # MIT
```

---

## Known limitations

These are real, current, and worth knowing before you rely on the wallet.

1. **BananaBlocks is required.** Balances, history, token metadata, and
   broadcast all go through `https://bananablocks.com/api/v1`. The wallet
   degrades to its encrypted cache offline, but it cannot refresh balances or
   broadcast without the indexer.
2. **This is not a full node.** The header chain proves inclusion of the
   transactions being spent, not the validity of the whole chain.
3. **SPV proves inclusion, not unspentness.** The indexer remains the source
   of truth for current spend state.
4. **One token carrier input per transaction.** Token actions larger than the
   largest single verified token output are not yet combined across inputs.
5. **Peer Chat is reversible.** Its key is derived from a public address. See
   [the security model](#what-the-wallet-deliberately-does-not-protect).
6. **Trading discovery is anchor-limited.** It finds fee-linked peer activity
   via the admin address, not a complete global order book.
7. **The installer is unsigned.** Windows SmartScreen will warn on first run.
8. **Windows is the only supported platform today.** The code is
   cross-platform in principle; the packaging and the OS key-store behaviour
   are not yet verified elsewhere.
9. **No hardware-wallet, multi-sig, or coin-control support.**
10. **The indexer sees your addresses.** There is no privacy layer.
11. **No key generation.** LBSX cannot create a wallet for you; you must
    already hold a BIP39 phrase. This is a deliberate
    [design choice](#import-only-by-design-lbsx-never-generates-a-recovery-phrase),
    but it does mean a first-time BSV user cannot onboard into LBSX without
    bootstrapping a phrase elsewhere first.
12. **The first sync downloads the full header chain** — about 74 MB on
    mainnet today, growing by 80 bytes per block. Subsequent syncs are
    incremental. See [Does the wallet scale?](#3-does-the-wallet-scale).

---

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md)
first — in particular the rule that **no wallet data, keys, or phrases may
ever be committed**, and the requirement that the offline test suites keep
passing.

---

## License

MIT. See [`LICENSE`](./LICENSE).

Copyright © 2026 captainsvbot.
