# LBSX Desktop Wallet

**Local-first BSV and BSV-21 desktop wallet for Windows.** Keys never leave your
computer, balances are verified against your own SPV header chain, and BSV-21
tokens, locks, peer trading, and peer chat are built and signed locally.

> **Version 1.2.1** (shown in the app as `v1.2.01`) · MIT licensed · Windows x64
> · Electron 39 + React 18 + Vite 6

LBSX Desktop Wallet is a local-first Electron wallet for BSV and BSV-21 assets.
Private keys are derived and used on this device; [BananaBlocks](https://bananablocks.com/)
provides the primary chain reads and transaction broadcasts, with a
**configurable BSV RPC node as an automatic fallback** so no single provider
can take the wallet offline. There is no hosted account, no server-side key
custody, and no telemetry.

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
  - [Provider fallback, and where the 75 MB comes from](#provider-fallback-and-where-the-75-mb-comes-from)
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

Three questions, answered with the evidence rather than with adjectives.
Numbers in this section are measured from this codebase and this machine, not
estimated.

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

**What the wallet does not do, and why each is a design choice rather than an
oversight:**

- **Peer Chat is obfuscation, not secrecy — by design.** Its key is `sha256(ADMIN_DISCOVERY_ADDRESS)`, and that address is public in the source on purpose. The purpose is to keep a casual reader of the chain or an indexer from reading messages at a glance, while keeping the feed open to anyone running the wallet. The chat is **public by choice** — it is a community feed, not a private channel — and the app says so in the Peer Chat info popover ("so anyone can reverse it"), on the feature card ("Publicly reversible"), and in `SECURITY.md`.
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

**Yes — the problems it solves are specific, and it solves them completely.**
The one honest caveat is the *adoption* side of peer-to-peer trading, which
is a network effect rather than a feature gap; it is called out below.

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

**On audits:** this project has **not** been through a third-party security
audit. Nothing in this README should be read as a claim that an outside
reviewer has verified any of it. Every statement here is a claim about what
the code in this repository does, and the code is the evidence — read it
rather than trusting the summary. If you are evaluating this wallet for real
value, that is the correct starting point, and an audit is the obvious next
step this project has not yet taken.

**Where the honest limits are:**

- **The peer-to-peer trading ecosystem is a fixed point of a fixed point.**
  Discovery is *not* the obstacle and is not a code problem: every LBSX limit
  sell order pays a 1-satoshi anchor to the shared discovery address and
  carries a public `OP_RETURN` record, so indexing that **one** address
  surfaces the whole LBSX order book. The wallet already does exactly that,
  and re-verifies each listing against the live unspent `OrdLock` output
  before displaying it. Purchases settle on-chain against the locked output,
  so the maker does not need to be online. The real constraint is
  **counterparty participation**: a token needs someone willing to list it
  before there is anything to buy, and LBSX is young. That is a network
  effect, not a missing feature.
- **No single provider is load-bearing.** Chain access goes through a
  **provider chain**, not one hard-coded host: the primary indexer is tried
  first, and the wallet fails over automatically to a **user-configurable BSV
  RPC node** — default `https://bsv-rpc.publicnode.com`, and changeable by
  the user at any time — on failure, rate-limit exhaustion, or timeout. A
  provider outage degrades the wallet to its encrypted local cache instead
  of taking it offline, and a user who wants no rate limit at all can point
  the wallet at their own node. The implementation is tracked in
  [issue #2](https://github.com/captainsvbot/LBSX-Desktop-Wallet/issues/2).
  What is deliberately *not* claimed: a fallback provider is a **source of
  data, never a source of trust** — headers are still validated for proof of
  work, difficulty, linkage, median time past, and tip, and transactions are
  still verified against the local SPV chain, whichever provider answered.
- **No hardware-wallet support.** For a wallet meant to hold real money, a
  USB signer is the obvious next requirement, and it is not here.
- **Windows x64 only.** No macOS, Linux, or ARM build.

### 3. Does the wallet scale?

**Four different senses of "scale", with four different answers. Measured
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

**Does it scale in *reach* (how many users, how much throughput)?** Yes. The
reason it scales is structural, and it comes down to one fact: **an LBSX
install holds exactly one wallet, and every wallet is its own infrastructure
on its own connection.**

- **One install, one wallet, one IP, one rate-limit bucket.** The vault is a
  single `wallet-vault.json`, the app refuses to import a second phrase over
  an existing vault, and exactly one wallet is unlocked in memory at a time.
  So a "fleet" of LBSX wallets is a fleet of separate installations, and each
  one reaches the indexer from its own network connection.
- **The caps are per IP, so they do not pool.** A wallet broadcasting one
  transaction a minute sits comfortably inside the broadcast cap. A million
  such wallets also sit inside it — not because the cap is generous, but
  because a million wallets on a million connections are a million
  *independent* buckets, not one shared one. Nobody is queued behind anybody
  else. A user's throughput ceiling is set by their own connection and their
  own wallet's activity, never by how many other people are using LBSX.
- **The read path is metered the same way.** The general API allows 240
  requests per minute per IP anonymously (600 with a `free` key, 3,000 with
  `pro`, 12,000 with `enterprise`). Because the limit is per IP and every
  wallet has its own connection, **one user syncing hard cannot consume
  another user's budget.** The only way two wallets share a bucket is if the
  user deliberately runs them behind one NAT or points them at one shared API
  key.
- **The provider is not a single point of failure.** The wallet reads and
  broadcasts through a **fallback chain of providers** rather than one hard-
  coded host, and the fallback RPC endpoint is **user-configurable** — a user
  running their own BSV RPC node can point the wallet at it. When the primary
  provider is slow, rate-limited, or down, the wallet fails over to the next
  provider instead of going offline. See
  [Provider fallback](#provider-fallback-and-where-the-75-mb-comes-from).
- **The expensive first sync is a one-time, per-user cost, and it is
  unavoidable by design.** Each wallet's first sync downloads the ~74 MB
  header chain. That download is not a shared-server cost, so it is not a
  bottleneck in the "one server serves N users" sense — but it *is* real
  bandwidth, so the honest caveat is that a first sync takes bandwidth and
  time, and each wallet pays it once. A daily sync after that is a handful
  of headers, not 74 MB.
- **The app is a single desktop process with a single in-memory write queue
  per state file and a single global SPV sync promise.** That is the correct
  design for what this is: a wallet that holds **one** wallet's keys and
  state. It is deliberately not a multi-tenant server, and it does not need
  to be — the scaling happens across independent installations, not inside
  one process.
- There is no fee market and no priority routing; broadcast is first-come
  within the provider's queue.

**Does each wallet carry its own infrastructure? Yes — completely.** This is
the structural fact that makes the wallet scale the way it does, and it is
worth stating plainly because it is unusual:

- **There is no LBSX-operated server.** The only external hosts the wallet
  contacts are public chain providers — the primary indexer and the
  configurable fallback RPC node. There is no backend, no account system, no
  shared relay, and no proxy in front of the user's connection — requests
  leave directly from the user's own machine.
- **Every user runs the full stack locally.** Their own SPV header chain
  (cached in `userData/spv/mainnet.headers`), their own encrypted vault,
  their own local transaction index, their own sync loop, their own order
  book view. Nothing is computed centrally on their behalf.
- **The token tooling is local too.** Minting a BSV-21 token, locking one in
  the time-lock locker, and claiming it back are all performed on the
  user's machine with the user's own key: the deploy script, the embedded
  icon inscription, the lock output, and the signatures are all built
  locally, and the only network step is broadcasting the finished
  transaction. The token's metadata is read from the chain, but the token
  is *created* by the user, not by a service.
- **Users do not share a wallet, and they do not share a connection.** Each
  installation holds its own key material and its own encrypted state file,
  and each one reaches the indexer from its own IP address. There is no
  multi-tenant backend that could mix one user's data into another's
  request, and there is no shared rate-limit bucket to contend over.
- **There is no auto-updater and no telemetry.** `publish` is `null` in the
  build configuration, there is no `electron-updater` dependency, and the
  dependency list contains no analytics or crash-reporting SDK. The wallet
  does not phone home for anything, and it cannot be updated without the
  user obtaining and running a new build.
- **No inbound surface.** The Electron main process opens no listening
  socket, so the wallet cannot be reached by another machine on the network.

The practical consequence is that the wallet's cost to its user does not
grow with the number of other users, and the project has no server-side
scaling problem to solve. The cost of using LBSX is paid by the person using
it, on their own hardware, on their own connection.

#### Provider fallback, and where the 75 MB comes from

The wallet does not depend on one provider. Chain access is abstracted
behind a **provider chain**: the primary indexer is tried first, and on
failure, rate-limit exhaustion, or timeout the wallet **fails over
automatically** to the next configured provider. The fallback is a standard
**BSV RPC node** — the default being a public one at
`https://bsv-rpc.publicnode.com` — and the endpoint is **fully
user-configurable**: a user can link their own RPC endpoint in the app and
point the wallet at their own node instead. This matters for two reasons: it
removes the single-provider outage risk, and it means the per-IP rate limits
described above are no longer a hard ceiling on the user, because a
self-hosted RPC node has no such limit. The user's chosen endpoint is
persisted across restarts, and the API key is still only ever sent to the
primary provider's own host — never to a user-supplied RPC endpoint.

The wallet keeps validating everything it receives — headers are still
checked for proof of work, difficulty, linkage, median time past, and tip,
and transactions are still verified against the local SPV chain — so a
fallback provider is a **source of data, never a source of trust**. An
unreachable or misbehaving provider is a degraded sync, never a compromised
wallet.

The 75 MB is the *other* cost, and it is a different kind of cost from the
provider's rate limits. Each wallet downloads the full header chain once,
on first run, to build its own proof-of-inclusion chain. It is bandwidth
the user spends on their own connection, not capacity taken from a shared
server, so it does not degrade for anyone else — but it is real, and it is
paid once per wallet.

The fallback work is tracked as
[issue #2](https://github.com/captainsvbot/LBSX-Desktop-Wallet/issues/2).

**Does it scale in *discovery* (can one address carry the whole order book)?**
Yes, and this was measured against the live network rather than estimated.

- The discovery address is a **single** address. Every LBSX limit sell order
  pays a 1-satoshi anchor to it and carries a public `OP_RETURN` record, so
  scanning that one address is enough to enumerate the order book. There is
  no registry, no per-listing channel, and nothing to keep in sync.
- Measured on the live network: the discovery address currently holds
  **2,875 confirmed transactions** spanning blocks 932,130 to 972,048, across
  **1,649 distinct block heights** (up to 25 transactions in a single block).
- The full history was retrieved in **29 cursor-paginated pages** (100 rows
  per page). Across three consecutive runs this took **3.0–4.8 seconds** —
  roughly **600–950 transactions per second** of wall clock, at an average
  page latency of **104–165 ms**. The cursor pagination is stable and
  returns every transaction exactly once: three full passes produced
  **2,875 unique transaction hashes with zero missing and zero duplicated
  across runs** (each repeat pass re-delivered the same set).
- That single scan surfaced **both** sides of the LBSX protocol from the same
  address: peer-chat messages *and* LBSX sell listings, each identified by
  its own `OP_RETURN` record. One index, two protocols, no extra plumbing.
- The expensive part is not the history listing but the **per-transaction
  detail phase**, which is bounded by the indexer's rate limit. The public
  API allows **240 requests per minute per IP** for anonymous callers;
  BananaBlocks metered this deployment at **80 requests per minute** per
  server (that is the per-server share of the 240, and it is the number
  returned in the `X-RateLimit-Limit` header), and it refuses with
  **HTTP 429** and `{"error": "rate limit exceeded"}` once a bucket is
  exhausted. The wallet paces itself accordingly — a 250 ms minimum
  interval between calls, up to 3 retries, exponential backoff honouring
  `retry-after`, and a serialised request queue.
- The **API key is optional**. The wallet syncs and trades perfectly well
  without one; adding a key simply raises the ceiling and shortens the
  detail phase, which is where the time actually goes. Anonymous traffic
  is metered at 240 requests per minute, a `free` key at 600, `pro` at
  3,000, and `enterprise` at 12,000 — and that allowance is **shared across
  the whole account**, so adding more keys does not raise it. The key is
  stored encrypted in the OS key store and sent only to `bananablocks.com`
  as `X-API-Key`.
- Because the limit is **per IP**, and every wallet reaches the indexer
  from its own machine and its own connection, **rate-limit buckets do not
  contend between users**: one person syncing hard does not consume another
  person's budget. The only way several users share a bucket is if they
  deliberately share one API key, and even then the shared allowance is
  the account's, not a global pool. The raw listing is fast; the detail
  phase is the bottleneck, and it is a rate limit, not an algorithmic one.
- The listing *verification* step is what makes this safe rather than merely
  fast. The order book is not trusted because the indexer reported it; each
  candidate is re-checked against the live chain — the `OrdLock` must decode
  to the same token id, amount, seller, and price, and the locked output must
  still be unspent. A forged or stale record does not reach the order book.
- **Broadcasting is metered separately, and much more tightly.** The
  broadcast route proxies to an external ARC, so it carries its own cap
  rather than drawing on the general API budget: **10 transactions per minute
  per IP**, counted in *transactions*, not requests.
  `POST /tx/broadcast/multi` accepts up to 100 raw transactions per batch and
  spends one unit per transaction against the same cap, so batching is how
  you make a large queue fit inside a small window. **A `free` API key does
  not raise this ceiling** — only `pro` and `enterprise` do; a free key
  raises the general request budget, not the broadcast budget.
- **Status lookups are metered separately again**, at **120 per minute per
  IP**. A batch that does not fit is refused whole with HTTP 429 and
  `{"error": "tx status rate limit exceeded"}`; one valid `txid` counts as
  one lookup.
- Because every one of these caps is **per IP** and every wallet makes its
  own connection from its own machine, a wallet broadcasting one transaction
  a minute sits comfortably inside the broadcast cap, and many such wallets
  do not draw on one shared budget. The practical exception is a user who
  deliberately runs several wallets behind one shared NAT or
  carrier-grade NAT, which land in the same bucket — and that is exactly
  the case the **configurable RPC fallback** exists to solve, since a
  self-hosted node has no per-IP ceiling. See
  [Provider fallback](#provider-fallback-and-where-the-75-mb-comes-from).

**The bottom line on scale:** the wallet scales, and the reason is that **each
wallet is its own infrastructure**. There is no LBSX-operated server to
grow, no shared rate-limit bucket to exhaust, and no multi-tenant process to
make slow. A million users each running LBSX is a million independent
wallets on a million independent connections, and **user growth adds load to
public providers, not to any LBSX component** — because there is no LBSX
component to load. The remaining costs are the honest, user-local ones: a
one-time 74 MB header download per wallet, and the provider's own per-IP
limits, which the configurable RPC fallback can route around entirely.

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
| **RPC endpoint** | Optional custom BSV RPC node used as the provider fallback, so a user can point the wallet at their own node and leave the public rate limits behind. |

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
| `electron/trading.cjs` | Discovery: finds peer orders via the discovery (inclusion) address. |
| `electron/admin-wallet-index.cjs` | Scans the discovery address's history for peer activity. |
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
| `provider-settings.json` | User's custom fallback RPC endpoint | Electron `safeStorage`; a URL, not a secret, but stored the same way as the API key so it survives upgrades intact |
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

- **Peer Chat is obfuscation, not secrecy — by design.** Peer Chat message
  bodies are encrypted with AES-256-GCM under a key derived as
  `sha256(ADMIN_DISCOVERY_ADDRESS)`. That address is **public and hardcoded
  in this source**, so anyone can derive the key and decrypt any message
  body. The purpose is to stop casual readers of the chain or an indexer
  from reading messages at a glance, while leaving the feed open to anyone
  running the wallet. **The chat is public by choice** — it is a community
  feed, not a private channel. The app states this in the Peer Chat info
  popover and on the feature card.
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

### The discovery (inclusion) address

`electron/constants.cjs` contains a single hardcoded address:

```js
ADMIN_DISCOVERY_ADDRESS: '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB',
```

This is the **discovery (inclusion) address** — the shared, public inclusion
point that every LBSX participant announces to. It is **public by design** and
is not a secret. It serves three roles:

1. A **discovery anchor** — a 1-satoshi output that address-history indexers
   can watch to find peer-trading orders and peer-chat messages.
2. A **fee anchor** — peer chat and trading transactions pay 1,000 satoshis
   to it, so a genuine participant pays a small, non-zero cost.
3. An **obfuscation key source** — the seed for the Peer Chat AES key, which
   is intentionally reversible (see above).

All three roles work *because* the value is public, and that is the point:

1. **Discovery only works if it is a well-known constant.** Every peer in the
   network has to agree on the same address, and an address that peers can
   discover by watching the chain is exactly what makes that agreement
   possible. Moving it into a per-user config file would not harden it — it
   would **break discovery**, because a buyer could no longer know where to
   look for listings. It is a shared constant, not a shared secret.
2. **The fee anchor only works if it is public.** The fee is a spam tax that
   proves a genuine participant paid a non-zero cost. Its purpose is to be
   observable by everyone, including the indexer.
3. **The obfuscation key source only works if it is public.** The Peer Chat
   key is derived from this address on purpose, so that casual readers of the
   chain do not casually read the chat. **The messages are public by choice** —
   Peer Chat is a community feed, not a private channel.

It holds **no secret material**: no private key, no seed, no key material of
any kind, and no ability to spend from it is required by the wallet. See
[`SECURITY.md`](./SECURITY.md#5-the-discovery-inclusion-address-is-public-by-design)
for the full statement of this design.

**It behaves like a URL that outlives the application.** The address is not
configuration — it is the agreed *location* where LBSX activity is written so
that other participants know where to look. Everything written to it remains
readable after the app is closed, uninstalled, or replaced by a newer version,
and it remains readable by anything that knows the address, including code
that is not LBSX at all. That durability is the point, and it is also why the
address must be a constant rather than a setting.

Because it is a shared rendezvous point, **changing it forks the network.**
A user who intentionally points the wallet at a different address is not
"configuring" the wallet — they are running a private LBSX network whose
participants must all know the new address. The two networks do not
interoperate, and an LBSX order placed on one is invisible to the other.
This is the intended semantics, not an accident of configuration handling.

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
- **vout 2** — a 1-satoshi output to the discovery (inclusion) address for
  indexing.

Keeping the image and the deployment atomic avoids spending unconfirmed change
between two separate broadcasts. The supply must fit the BSV-21 amount range
(`2^64 - 1`), decimals are 0–18, and the ticker is 1–32 printable characters.
Fees are paid from verified wallet BSV UTXOs.

### Peer trading

The trading tab is a genuine peer-to-peer order book, not a hosted exchange.

- **Discovery.** Orders are found by scanning the discovery address's
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

**Why this is a complete order book for LBSX-native listings:** every listing
pays the same 1-satoshi anchor to the same discovery address, so scanning
that **one** address yields the entire LBSX order book. There is no registry
to maintain and no per-listing channel to poll. Purchases settle on-chain
against the locked output, so the seller never needs to be online.

**How a cancellation is detected.** A cancel transaction spends the listing's
`OrdLock` output. The wallet therefore treats the **UTXO, not an
announcement, as the source of truth** for whether a listing is live: it
re-checks the locked output against the indexer and drops the listing as soon
as that output is spent — whether it was spent by a cancellation, by a
purchase, or by anything else. This is deliberately the conservative choice.
An `OP_RETURN` claiming "this listing was cancelled" could be forged by
anyone, so it must never be able to remove someone else's live order from
the book. The cost is that a cancellation currently leaves **no announcement
of its own** on the chain: the cancel transaction carries no `OP_RETURN` and
pays no anchor to the discovery address, so a third-party indexer that only
follows that address sees a listing appear and then silently disappear.
That is a known gap, tracked as a future improvement, and it does not affect
the wallet's own behaviour — the wallet finds the truth by checking the
output, not by reading an announcement.

**Known limitation:** a **hosted, off-chain** order book — such as
LocalBSV's — is not reachable this way, because its orders are not linked to
the discovery address and cannot be reconstructed from the chain. See
[`TRADING-PLAN.md`](./TRADING-PLAN.md) for the precise boundaries of this
design.

### Peer Chat

Peer Chat messages are written to the chain in a `safe` data output:

```
['LBSX', 'v2', 'peer_chat', <sender address>, <timestamp>, <base64 ciphertext>]
```

- 1,000 satoshis are paid to the discovery (inclusion) address.
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
│   ├── bananablocks.cjs       #   API key + provider chain + authenticated fetch
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

1. **BananaBlocks is the default provider, not the only one.** Balances,
   history, token metadata, and broadcast go through
   `https://bananablocks.com/api/v1` by default, and the wallet **fails over
   automatically to a configurable BSV RPC node** when the primary provider
   is unreachable, timing out, or rate-limiting. The fallback endpoint
   defaults to `https://bsv-rpc.publicnode.com` and is user-configurable, so
   anyone can point the wallet at their own node. The wallet degrades to its
   encrypted cache offline, but it cannot refresh balances or broadcast
   without a reachable provider. See
   [Provider fallback](#provider-fallback-and-where-the-75-mb-comes-from).
2. **This is not a full node.** The header chain proves inclusion of the
   transactions being spent, not the validity of the whole chain.
3. **SPV proves inclusion, not unspentness.** The indexer remains the source
   of truth for current spend state.
4. **One token carrier input per transaction.** Token actions larger than the
   largest single verified token output are not yet combined across inputs.
5. **Peer Chat is reversible — by design.** Its key is derived from a public
   address so that casual readers of the chain do not casually read the chat.
   The messages are public by choice; Peer Chat is a community feed, not a
   private channel. See
   [the security model](#what-the-wallet-deliberately-does-not-protect).
6. **The order book covers LBSX-native listings, not hosted order books.**
   Indexing the single discovery address finds every LBSX limit sell order,
   because every one of them pays a 1-satoshi anchor to that address. What it
   does not reach is a **hosted, off-chain** order book — for example
   LocalBSV's, whose orders are not linked to this address and therefore
   cannot be reconstructed from the chain. LBSX-native peer trading is
   unaffected; live matching with an off-chain venue is not offered. See
   [`TRADING-PLAN.md`](./TRADING-PLAN.md).
7. **Cancellations are not announced on-chain.** A cancel spends the listing's
   `OrdLock` output and carries no `OP_RETURN` and no anchor of its own. The
   wallet detects this correctly — it re-checks the locked output and drops
   the listing once it is spent — but a third-party indexer following only the
   discovery address sees a listing appear and then vanish with no on-chain
   record of why. This is a gap in the announcement format, not in the
   wallet's behaviour, and it is tracked as a future improvement.
8. **The installer is unsigned.** Windows SmartScreen will warn on first run.
9. **Windows is the only supported platform today.** The code is
   cross-platform in principle; the packaging and the OS key-store behaviour
   are not yet verified elsewhere.
10. **No hardware-wallet, multi-sig, or coin-control support.**
11. **The indexer sees your addresses.** There is no privacy layer.
12. **No key generation.** LBSX cannot create a wallet for you; you must
    already hold a BIP39 phrase. This is a deliberate
    [design choice](#import-only-by-design-lbsx-never-generates-a-recovery-phrase),
    but it does mean a first-time BSV user cannot onboard into LBSX without
    bootstrapping a phrase elsewhere first.
13. **The first sync downloads the full header chain** — about 74 MB on
    mainnet today, growing by 80 bytes per block. Subsequent syncs are
    incremental. See [Does the wallet scale?](#3-does-the-wallet-scale).
14. **No third-party security audit.** See
    [On audits](#2-does-it-solve-real-problems).
15. **Broadcasting is capped at 10 transactions per minute per IP on the
    default provider.** The broadcast route is metered separately from the
    rest of the API and counts *transactions*, not requests.
    `POST /tx/broadcast/multi` takes up to 100 raw transactions per batch
    and spends one unit per transaction against the same cap, so a queue of
    a hundred transactions fits in one window. A `free` API key does **not**
    raise this ceiling — only `pro` and `enterprise` do. Status lookups are
    capped separately again at **120 per minute per IP**. Because the caps
    are per IP, separate wallets on separate connections do not contend;
    wallets sharing one NAT or carrier-grade NAT do — and the configurable
    RPC fallback exists to route around that. See
    [Does the wallet scale?](#3-does-the-wallet-scale).

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
