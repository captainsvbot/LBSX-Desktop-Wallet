# Security Policy

> **Audit status: no third-party audit has been performed.** Nothing in this
> document implies that an outside reviewer has verified any claim about this
> wallet. The claims below describe what the code in this repository does; the
> code is the evidence. Anyone evaluating this wallet for real value should
> read the source rather than rely on this summary.

## Reporting a vulnerability

If you believe you have found a vulnerability in LBSX Desktop Wallet, please
report it privately rather than opening a public issue.

- Open a **private** security advisory on the repository, or
- Contact the maintainer via the repository's issue tracker with a request for
  a private channel.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally with a test script.
- The wallet build version (`v2.0.01` / package version `2.0.1`) and platform.
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

**This is a deliberate design choice, and it is the intended behaviour.** The
purpose of the on-chain encoding is to keep the payload from being casually
read by someone browsing the chain or an indexer, without them needing to run
the wallet application or join the community feed. The messages remain
public by choice: the feature is a *community feed*, not a private channel.

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

The indexer meters broadcasting separately from reads. The broadcast route is
capped at **10 transactions per minute per IP**, counted in transactions
rather than requests, and status lookups are capped at **120 per minute per
IP**. A `free` API key raises the read budget but not the broadcast budget.
Because these caps are per IP, and because an LBSX installation holds
exactly **one wallet** behind **one** connection, separate wallets do not
contend with one another. A user who deliberately runs several wallets
behind a single NAT or carrier-grade NAT does share a bucket and is capped
together — and that is what the **configurable RPC provider fallback**
exists to solve, since a user-supplied node has no per-IP ceiling at all. An
attacker who can force a user behind a shared IP cannot steal the user's
funds or read the vault, but can slow that user's ability to broadcast
while the wallet is in use.

### 4. SPV proves inclusion, not unspentness

The local header chain proves that a transaction was included in a block on a
chain the wallet validated. It does **not** prove that an output is still
unspent, and it does **not** validate every transaction in the chain. The
indexer remains the source of truth for current balances, history, and
external spend state, and the wallet will not sign from an unknown or stale
external spend status.

### 5. The discovery (inclusion) address is public, by design

`ADMIN_DISCOVERY_ADDRESS` is a **public, application-level discovery and
obfuscation anchor** — the shared inclusion point where LBSX activity is
announced. It is published in this source on purpose. It is not a secret, it
is not a key, and it is not meant to be treated as one.

It exists to do three jobs, all of which work *because* it is public:

1. **A discovery anchor.** Peer-trading orders and Peer Chat posts pay a
   small fee to it so that anyone — including a wallet that is not running
   LBSX — can find and index that activity by scanning one address. A private
   address could not do this job: nobody could discover the transactions
   attached to it.
2. **A fee anchor.** The 1-satoshi outputs that anchor an order or a chat
   post go here, which is what makes the whole scheme work without an
   escrow operator or any custodial component.
3. **An obfuscation key source.** It is the seed for the Peer Chat AES key.
   Deriving the key from a value that is deliberately public is exactly what
   makes the encoding useful: it raises the effort for a casual reader while
   keeping the feed open to anyone running the wallet.

**The messages are public by choice.** Peer Chat is a community feed, not a
private channel. The on-chain encoding exists to keep payloads from being
read at a glance by someone browsing the chain or an indexer, and to make the
data readable by the wallet application without shipping secret material in
the source. It was never intended to provide confidentiality against someone
who is deliberately trying to read it, and the application says so in the
Peer Chat info popover and on the feature card.

The reason this is not a defect worth "fixing":

- Moving it to a config file or environment variable would **break
  discovery**. Peers need a stable, shared, publicly known value for
  discovery to work at all. A per-user address would mean nobody could find
  anybody's orders.
- It holds **no secret material**. There is no key to leak, because the
  value is published in the source by intent. Losing it would lose the
  discovery index; it would not expose a private key or a seed.
- Every user relies on the *same* value by design, so it is a shared
  constant rather than a shared secret. The trust model is explicitly
  "public and verifiable", not "secret and trusted".

**It outlives the application.** The address behaves like a URL: anything
written to it stays readable after the wallet is closed, uninstalled, or
replaced, and it stays readable by anything that knows the address —
including software that is not LBSX. That durability is the entire purpose.
It also means **changing it forks the network**: a user who points the
wallet at a different address is running a private LBSX network whose
participants must all know the new address, and the two networks do not
interoperate. Order books are per-network as a direct result.

If the project ever needed a stronger guarantee, the correct change would be
a different protocol design (per-user discovery keys, or a commitment scheme),
not a config-file change to this one.

### 6. Device mode inherits the OS key store's security

In passwordless mode the phrase is protected only as well as the operating
system's key store and the account it belongs to. On Linux, Electron's
`basic_text` backend is explicitly detected and rejected because it is not
encrypted by a real key store.

### 7. The wallet does not generate recovery phrases

LBSX contains **no key-generation code**. There is no `generateMnemonic`, no
`entropyToMnemonic`, and no seed-phrase generator anywhere in the codebase.
The only way a wallet comes into existence is by importing a BIP39 phrase the
user already holds.

This is a deliberate design choice with a security rationale: generating a
phrase is the operation most likely to cause permanent, unrecoverable loss
(a botched paper backup, a mistyped word, a screenshot, a screen share), and
an imported phrase comes with a recovery path the user has already
established and tested.

The phrase is **never displayed**. The wallet validates it, derives from it,
and stores it encrypted. There is no "reveal phrase" or "copy phrase" action
in the UI.

**The trade-off:** a first-time BSV user with no existing phrase cannot
onboard directly and must bootstrap one elsewhere first. This is listed in
the README's Known limitations.

### 8. No additional protections are offered

- No multi-signature support.
- No hardware wallet or cold-storage signing.
- No coin control, UTXO labelling, or allowlists.
- No recipient screening, sanctions filtering, or policy engine.
- No auto-lock timer or idle timeout beyond the explicit Lock button and
  `before-quit`.
- The wallet is import-only: it never generates a recovery phrase.

### 9. Order cancellations are not announced on-chain

A cancellation spends the listing's `OrdLock` output. It carries **no
`OP_RETURN` record and no anchor payment** to the discovery address, so a
third-party indexer that follows only that address cannot distinguish a
cancellation from any other spend of the locked output.

This is a gap in the **announcement format**, not in the wallet's security
model, and it is deliberately handled in a conservative way:

- **The wallet does not rely on an announcement to decide liveness.** It
  re-checks the locked output against the indexer and treats a spent output
  as "no longer a live listing". This is the correct direction, because an
  `OP_RETURN` claiming "cancelled" can be forged by anyone — so an
  announcement must never be able to remove another party's live order from
  the order book.
- **The cost** is that a third-party indexer sees a listing appear and then
  silently disappear, with no on-chain record of the reason. Adding a cancel
  announcement is tracked as a future improvement.

Adding one would need care: the announcement must remain *advisory*, and the
spend-based UTXO check must remain authoritative, or a third party could
suppress a live listing by broadcasting a forged cancel record.

### 10. Each wallet is its own infrastructure

LBSX Desktop Wallet has **no server-side component of any kind**. There is no
LBSX-operated backend, no account system, no shared relay, and no telemetry.
This is a security property, not only an operational one, and it is
deliberate:

- **No user data is pooled.** Every installation holds its own key material
  and its own encrypted state file, and every network request originates
  from that user's own machine. There is no multi-tenant backend where one
  user's address, balance, or transaction could be mixed into another
  user's request, and no shared database that could be breached to expose
  many wallets at once. A compromise of one user's machine compromises that
  user alone.
- **Key material never leaves the machine.** Minting a BSV-21 token,
  creating a time-lock, and claiming a locked token are all signed locally
  with the user's own key. The deploy script, the embedded icon inscription,
  the lock output, and every signature are produced on the user's machine;
  the only network step is broadcasting a transaction that is already
  finished and signed. There is no service that holds, escrow, or
  co-signs anything on the user's behalf.
- **No shared rate-limit bucket.** The indexer's limit is **per IP**, and
  each wallet reaches it from its own connection. Users do not contend for
  one another's request allowance, and one user syncing hard cannot exhaust
  another user's budget. The only shared bucket is the one an account owner
  creates deliberately by sharing their own API key or by running several
  wallets behind one NAT — and the latter is a limit the configurable RPC
  fallback removes, since a user-supplied node has no per-IP cap. This holds
  for **broadcast** as well as reads, because the fallback broadcasts
  through `sendrawtransaction` rather than through the metered API.
- **No single-provider dependency.** Chain access goes through a **provider
  chain**, not one hard-coded host: the primary indexer is tried first, and
  the wallet fails over automatically to a configurable BSV RPC node —
  default `https://bsv-rpc.publicnode.com`, and fully user-configurable so
  a user can point it at their own node — on failure, rate-limit
  exhaustion, or timeout. **Broadcast fails over on the same chain**, via
  the node's `sendrawtransaction`, so a transaction the primary provider
  refuses is retried rather than left unsent; the wallet's
  `broadcast-uncertain` state still applies, so a broadcaster that accepts
  a transaction and then times out is never reported as a rejection. A
  provider outage degrades the wallet to its encrypted cache rather than
  taking it offline. Crucially, **a provider is a source of data, never a
  source of trust**: headers are still validated for proof of work,
  difficulty, linkage, median time past, and tip, and transactions are still
  verified against the local SPV chain, whichever provider answered.
- **No auto-update channel.** `publish` is `null` in the build
  configuration and there is no `electron-updater` dependency, so the wallet
  cannot be silently updated — including by a compromised or coerced
  distribution point. Updating requires the user to obtain and run a new
  build, which is a conscious act. This is also why a build is not signed:
  see the README's known limitations.
- **No phone-home of any kind.** The dependency list contains no analytics,
  tracking, or crash-reporting SDK. The only external hosts the wallet
  contacts are public chain providers — the primary indexer and the
  configurable fallback RPC node — and only for data the user asked it to
  fetch. The API key is attached only for the primary provider's own host
  and is never sent to a user-supplied RPC endpoint.
- **No inbound surface.** The Electron main process opens no listening
  socket, so the wallet cannot be reached by another machine on the local
  network, and there is no remote-control or RPC channel into a running
  wallet.

The trade-off is that the wallet's cost is paid by the person using it, on
their own hardware: the 74 MB header download, the local SPV validation, and
the request pacing all happen on the user's machine. That is the same
property that makes it private, and it is worth keeping both.

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

- The address is the public **discovery (inclusion) address**, not a secret.
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
