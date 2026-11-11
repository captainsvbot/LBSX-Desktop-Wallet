# LBSX Desktop Wallet — Encrypted Mail

Status: **IMPLEMENTED AND VERIFIED.** This document was written as the design
proposal before the feature was built; it is kept because it records the
reasoning behind the shipped design. Where the implementation refined the
original proposal, the change is noted inline.

---

## 1. The question

Can the wallet send and receive **encrypted email** on BSV, where the only party who
can read a message is its intended recipient?

**Answer: yes.** The cryptography is standard ECIES-style E2EE, and every primitive
required by it is already present in the 2.1.00 dependency tree. All primitives below
were executed and verified against the real `bsv@1.5.6` and Node 26 runtime — not
assumed.

---

## 2. Verified cryptography

The design is ECIES (Elliptic Curve Integrated Encryption Scheme) using ECDH on
secp256k1 + HKDF-SHA256 + AES-256-GCM.

### 2.1 What was tested and passed

| Property | Test | Result |
|---|---|---|
| Round trip | Alice encrypts → Bob decrypts | PASS |
| Confidentiality | Eve (wrong private key) attempts decrypt | PASS — rejected |
| Integrity | 1 bit flipped in ciphertext | PASS — GCM tag rejects |
| Context binding | AAD swapped to a different recipient | PASS — GCM rejects |
| Key derivation | HKDF-SHA256 over ECDH shared secret | PASS |
| Address binding | `hash160(pubkey)` → P2PKH address | PASS — matches `priv.toAddress()` |
| Pubkey round trip | `bsv.PublicKey.fromBuffer(compressed)` | PASS — identical address + hex |

### 2.2 Why these primitives and not others

`bsv@1.5.6` exposes `bsv.crypto.ECDSA` for **signing** but has **no ECDH primitive**
and no ECIES helper. Two options were considered:

- `@bsv/sdk@2.6.0` exposes an `ECIES` class — but its exposed API is
  `electrumEncrypt` / `electrumDecrypt` / `bitcoreEncrypt` / `bitcoreDecrypt`,
  **not** the generic `encrypt`/`decrypt` pair. It also runs on `@bsv/sdk`'s own key
  types, not `bsv@1.5.6`'s `PrivateKey`, so it would require a key-conversion layer
  across two incompatible crypto stacks.

- **Node's native `crypto.createECDH('secp256k1')`** — available in the Electron main
  process, zero new dependencies, and consumes the same compressed SEC1 bytes that
  `bsv@1.5.6` already produces via `publicKey.point.toBuffer()`.

**Decision: Node native ECDH.** No new packages, no cross-library key conversion,
and the shared secret never leaves the process.

### 2.3 Envelope format

```
ephemeral public key  (33 bytes, compressed SEC1)  → base64   [88 chars]
AES-256-GCM IV        (12 bytes)                    → base64   [16 chars]
AES-256-GCM tag       (16 bytes)                    → base64   [24 chars]
ciphertext            (variable)                    → base64
```

Key derivation:

```
shared_secret = ECDH(recipient_priv, ephemeral_pub)      // 32 bytes
key           = HKDF-SHA256(ikm=shared_secret, salt="", info="lbsx-mail-v1", 32)
cipher        = AES-256-GCM(key, iv, aad)
```

**AAD (authenticated associated data)** binds the ciphertext to its context and is
what prevents cross-recipient replay:

```
aad = "lbsx-mail-v1|" + sender_address + "|" + recipient_address + "|" + message_id
```

A recipient who is not the intended one cannot decrypt at all (wrong ECDH peer).
A recipient who *is* the intended one cannot silently redirect the message to a
different address (AAD mismatch → GCM tag failure).

### 2.4 Security properties — what this does and does not give you

**Gives you:**
- Only the holder of the recipient's private key can read the body.
- The chain observer, the indexer, the discovery-address operator, and the wallet
  author all see only ciphertext.
- Tamper detection: the body cannot be altered in transit.
- Forward-secrecy within a message is **not** provided — see below.

**Does NOT give you (must be stated in the UI):**
- **Metadata is public.** Sender address, recipient address, timestamp, message size,
  and message count are all visible on-chain. This is the same limitation as any
  email protocol, but on a public blockchain the metadata is *permanently* public and
  trivially indexable — more exposed than SMTP email.
- **No forward secrecy.** If the recipient's private key is later compromised, every
  past message ever sent to them can be decrypted from the public chain. This is
  inherent to encrypting to a long-lived identity key.
- **No sender authentication inside the ciphertext.** The wallet verifies that the
  transaction was *funded by* the claimed sender address (the input address must
  match), which is a strong signal, but a full proof-of-possession scheme is
  recommended (see §5, item 3).
- **No deniability.** The transaction is a public, permanent record that the message
  was sent.

---

## 3. Wire format on chain

Follows the **existing live LBSX format**, verified against a real mainnet
transaction (`02f60da5d60eaae95675e48c5dcf563d74ffb4fb1fab9ffb1cc56175fff14a00`):

```
OP_RETURN:  006a 04 4c425358 02 7632 08 6273655f63686174 ...
            ^^^^^ ^^ ^^^^^^ ^^ ^^^^^ ^^^^^^^^^^^^^
            |     |  |      |  |     "bsv_send" (the 2.1.00 op name)
            |     |  |      |  "v2"
            |     |  |      "LBSX"
            |     |  opcode 0x6a = OP_RETURN
            |     OP_FALSE prefix (safe data output)
            OP_RETURN
```

The 2.1.00 peer-chat payload is exactly 6 pushes:

```
['LBSX', 'v2', 'peer_chat', <sender address>, <timestamp ISO>, <base64 ciphertext>]
```

### 3.1 Proposed mail payload — 8 pushes

```
['LBSX', 'v2', 'mail', <sender address>, <recipient address>,
 <message id>, <timestamp ISO>, <base64 envelope>]
```

Rationale for the field choices:

- **`v2`, not `v3`** — the version string is **per-protocol, not global**. Every
  existing 2.1.00 protocol (`bsv_send`, `peer_chat`, `mint`) uses `v2`; only the
  `payment` protocol uses `v1`. The version identifies the *payload schema*, and
  the payload schema is what is being versioned. `mail` is a new protocol, so it
  starts at `v2` to match the current schema generation. `peer-chat.cjs` gates on
  `fields[2] !== 'peer_chat'` **and** `fields.length !== 6`, so an 8-field `mail`
  payload is already invisible to it — no regression risk either way.
- **The op name `mail` is free** — verified: no occurrence of `mail` as a protocol
  op anywhere in the 2.1.00 `electron/` or `src/` tree.
- **Sender and recipient in plaintext** — they must be, so the receiving wallet can
  route and filter the message before attempting decryption. This is standard
  practice (e.g. Signal stores the sender unencrypted) and keeps the recipient's
  decryption attempt from becoming an oracle for other mail.
- **Message id** — a random 32-hex value used in the AAD and as the dedupe key,
  so the same message can never be replayed into a different context.
- **Timestamp** — mirrors `bsv_send` and `peer_chat`, which both carry an ISO
  timestamp as a distinct field. It gives the mailbox ordering a source that does
  not depend on the indexer.
- **Envelope base64** — the compressed envelope from §2.3, base64'd so it survives
  the OP_RETURN push as clean UTF-8.

### 3.2 Transaction construction

The mail transaction pays **two** outputs, exactly as `bsv_send` does:

```js
const MAIL_SERVICE_FEE_SATS = 1000;              // same as Peer Chat

const tx = new bsv.Transaction().from(inputs)
  .to(recipientAddress, 3)                          // anchor to the RECIPIENT (discovery)
  .to(ADMIN_DISCOVERY_ADDRESS, MAIL_SERVICE_FEE_SATS)   // service fee (discovery)
  .addOutput(new bsv.Transaction.Output({
    script: bsv.Script.buildSafeDataOut([
      'LBSX', 'v2', 'mail', senderAddress, recipientAddress,
      messageId, timestamp, envelopeB64,
    ]),
    satoshis: 0,
  }));
tx.change(senderAddress).feePerKb(1000).sign(privateKey);
```

**The service fee is 1,000 sats, matching Peer Chat** (not the 10,000 sats used by
`bsv_send` and token listings). This was a deliberate product decision: mail is a
low-stakes messaging action, and 1,000 sats keeps it in line with the other
messaging feature. The 2.1.00 fee table is:

| Action | Service fee |
|---|---|
| BSV send | 10,000 sats |
| Mint a token | 0.5 BSV |
| **Peer Chat message** | **1,000 sats** ← mail matches this |
| Token listing | 0.0001 BSV anchor |
| Buy a listing | 10,000 sats + platform payment |

Mail is added to that table at **1,000 sats**.

**Why mail must also pay the discovery address.** The recipient-side discovery
works by scanning the *recipient's own address history*. A 1-sat output to the
recipient is what makes the transaction appear there. The service-fee output to the
discovery address is a separate, existing convention (it is what makes the
transaction visible to third-party indexers following the discovery address, and
what funds the project). Both are needed, and they are distinct outputs:

- 1 sat → recipient: **discovery** for the recipient's wallet.
- 1,000 sats → discovery address: **service fee** (project convention).

Note the ordering matters for the change output: `tx.change()` must be called
after both `.to()` calls so the change calculation accounts for them.

**Critical difference from Peer Chat:** peer chat pays the *shared discovery address*
(`15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB`) because it is a broadcast feed. Mail must pay
the **recipient's own address**, because that is what makes the message discoverable
in the recipient's address history.

**This was verified live:** an address-history query for the sender of a real
transaction returned that transaction as its first row. Address history therefore
includes **both sent and received** transactions — so:

- The **recipient** discovers incoming mail by scanning their own address history.
- The **sender** discovers their own sent mail by scanning their own address history.

This is the single most important transport fact in the whole design, and it is
confirmed against live mainnet data.

### 3.3 Live wire formats — decoded from mainnet

Three real 2.1.00 transactions were fetched and their OP_RETURN payloads decoded
byte-by-byte. These are the authoritative formats:

**`bsv_send` — 8 pushes** (`02f60da5d60eaae95675e48c5dcf563d74ffb4fb1fab9ffb1cc56175fff14a00`):

```
006a044c425358027632086273765f73656e642231344b314776757245646d64736b34536a4c4e5a34314763744264465a375743387022313643707069584a486e6868396b683155627572686e52645061624b7761717356500936323030303030303018323032362d31312d30395431343a35353a35382e3834315a27736572766963655f6665653a31303030307361743a77616c6c65745f6d61696e74656e616e6365

[0] "LBSX"
[1] "v2"
[2] "bsv_send"
[3] "14K1GvurEdmdsk4SjLNZ41GctBdFZ7WC8p"    (sender)
[4] "16CppiXJHnhh9kh1UburhnRdPabKwaqsVP"    (recipient)
[5] "620000000"                             (amount sats)
[6] "2026-11-09T14:55:58.841Z"              (timestamp)
[7] "service_fee:10000sat:wallet_maintenance"
```

Outputs: `620000000` → recipient, `10000` → discovery address, OP_RETURN, change.
Note the **`service_fee:<n>sat:wallet_maintenance`** convention in the last field —
mail should follow it: `service_fee:1000sat:wallet_maintenance`.

**`peer_chat` — 6 pushes** (`d4817e6837178a…`):

```
[0] "localBSV"          ← NOTE: legacy tag, not "LBSX"
[1] "v1"
[2] "peer_chat"
[3] "sender:Captainbsv"
[4] "date:2026-11-08"
[5] "Nj1QShUqWCogGwFjAjsnbl0IEyo0AUgXJwUGQj5aFhcDP0ELCSFYAH9aDTcZPiZ0HkYfYSQaBVklBApWPFsADBUwVFhJ"
```

This is an **older-format** peer_chat message (legacy `localBSV`/`v1`/`sender:` tag
style, plus a large `bbs`/`bsocial`-style payload rather than the 2.1.00
`LBSX`/`v2`/`peer_chat`/address/timestamp/ciphertext form). It confirms that the
protocol has evolved and that the current 2.1.00 code only parses the newer form.

**Important:** the current 2.1.00 code writes and reads `LBSX`/`v2`. Mail must use
the same tag. `admin-wallet-index.cjs` matches protocol payloads by substring
(`text.includes('peer_chat')`), so it is tolerant of tag differences — but the
mail parser should be strict.

### 3.4 Piggyback opportunity — no extra API calls

Verified: the `/tx/{txid}` detail endpoint returns the OP_RETURN output with its
full `script_pubkey`. The existing `chain.cjs` activity pipeline already fetches
transaction details for every transaction in the wallet's own address history —
the same set that contains incoming mail.

That means the receive path can **piggyback on the existing activity sync** instead
of running a second history scan:

```
chain.cjs syncWalletActivity
  └── fetches /tx/{txid} for each new txid  ← already happening
        └── outputs[].script_pubkey  ← contains the mail OP_RETURN
              └── parse for ['LBSX','v2','mail',...]
```

This is a significant efficiency win: mail discovery becomes **free** in terms of
API calls, because the wallet is already paying for those detail lookups. It also
removes the need for a separate cursor, pagination state, and rate-limit budget.

**Recommended:** extend `summarizeWalletTransaction` to recognise mail payloads and
attach a `mailMessage` row to the activity, then have `syncMail` read those rows
from the persisted activity list rather than performing its own scan.

The tradeoff: `summarizeWalletTransaction` currently drops the OP_RETURN payload
(it only computes satoshi/token flows), so the mail payload must be parsed there
and carried through in `details`. That is a small, contained change.

A standalone `syncMail` scan remains viable as a fallback (and is simpler to
reason about), but it would double the transaction-detail API calls — which
matters given the provider's rate limits (120 status lookups/min, 10 broadcasts/min).

### 3.5 Size budget (measured)

| Body | Envelope (base64) | OP_RETURN bytes |
|---|---|---|
| 200 chars | 644 | 732 |
| 1 000 chars | 2 064 | 2 152 |
| 4 000 chars | 7 396 | 7 484 |
| 10 000 chars | 18 064 | 18 152 |

BSV's standard transaction limit is 100 000 bytes. A 10 000-character message fits
comfortably with room to spare. **Proposed limit: 8 000 characters** of body text,
which keeps the transaction well under 15 KB and keeps the 1 000-byte-per-kB fee
model reasonable.

---

## 4. Architecture — how it plugs into 2.1.00

### 4.1 New files

| File | Responsibility |
|---|---|
| `electron/mail-crypto.cjs` | ECDH + HKDF + AES-GCM encrypt/decrypt. Pure functions, no I/O, no Electron imports — mirrors `peer-chat-crypto.cjs`. |
| `electron/mail.cjs` | Send path, receive/sync path, OP_RETURN parsing, discovery. |
| `src/MailPage.jsx` | Renderer UI: inbox, thread view, compose, contact list. |
| `src/MailPage.css` | Styles, matching the existing page conventions. |
| `scripts/mail-crypto-smoke.mjs` | Offline round-trip + tamper + wrong-key tests. |
| `scripts/mail-transaction-smoke.mjs` | Offline transaction-build + parse tests. |

### 4.2 Modified files

| File | Change |
|---|---|
| `electron/main.cjs` | Add 4 IPC handlers: `mail:get`, `mail:sync`, `mail:send`, `mail:contacts` (save/list contacts). |
| `electron/preload.cjs` | Expose the 4 new methods on the frozen `lbsx` bridge. |
| `electron/wallet-data.cjs` | Add `mailMessages: []`, `mailContacts: []`, `mailLastScannedTxid: null`, `mailSyncedAt: null` to the persisted schema + validation. |
| `electron/vault.cjs` | Add `getWalletPublicKey()` — returns the compressed SEC1 public key for the active derivation path. **Public data only**, safe to expose to the renderer. |
| `src/App.jsx` | Add the `mail` nav entry + page route. |
| `package.json` | Bump the version, retarget the output directory, add the new test scripts. |

### 4.3 The crypto module — `electron/mail-crypto.cjs`

Public API:

```js
encryptMailEnvelope({ recipientPubKey, plaintext, aad })  → { e, i, t, c }
decryptMailEnvelope({ recipientPrivKey, envelope, aad })    → Buffer
buildMailAad({ sender, recipient, messageId })             → string
```

Implementation notes:
- `recipientPubKey` / `recipientPrivKey` are `bsv` 1.5.6 `PublicKey` / `PrivateKey`.
- Compressed SEC1 bytes come from `publicKey.point.toBuffer()` (33 bytes) and
  `privateKey.toBuffer()` (32 bytes).
- Node ECDH requires the private key as a 32-byte buffer — `privateKey.toBuffer()`
  satisfies this directly.
- All buffers holding key material are zeroed in a `finally` block, matching the
  existing `peer-chat-crypto.cjs` discipline.
- The envelope must be validated on decrypt (base64 round-trip equality, length
  bounds) before use, exactly as `peer-chat-crypto.cjs` does, to avoid accepting
  malformed input.

### 4.4 Receive path — how a recipient finds their mail

**Recommended approach: piggyback on the existing activity sync** (see §3.4).

The wallet already scans its own address history and fetches `/tx/{txid}` detail for
every new transaction. Those are exactly the transactions that can contain incoming
mail, and the detail response already contains the OP_RETURN `script_pubkey`.

The change to `chain.cjs` is small and contained:

```
summarizeWalletTransaction(tx, address, ref, existing)
  └── NEW: parse tx.outputs[].script_pubkey for the mail payload
        └── if fields[0]==='LBSX' && fields[1]==='v2' && fields[2]==='mail':
              attach { mailMessage: {...} } to the returned details
```

Then `syncMail(address)` reads the persisted activity list, picks up rows carrying a
`mailMessage`, decrypts them, and maintains the mailbox:

```
1. Load prior mail snapshot (dedupe set of message ids + txids).
2. Read the persisted activity rows that carry a mailMessage payload.
   (Populated by the activity sync above.)
3. For each not-yet-seen mail payload:
   a. Verify fields[4] (recipient) === our address. Skip otherwise.
   b. Verify the transaction has an input owned by fields[3] (the claimed sender).
   c. Rebuild the AAD from (sender, recipient, messageId).
   d. Decrypt with the wallet private key. If it fails → mark 'undecryptable'
      (an email to a different recipient, or a corrupted payload) — do NOT drop it.
   e. Parse { subject, body }, persist, and return the snapshot.
```

**Fallback (standalone scan)** — if piggybacking proves too invasive to
`summarizeWalletTransaction`, a dedicated `syncMail` can run its own history scan
using the same pagination (`HISTORY_PAGE_SIZE=100`, `HISTORY_PAGE_LIMIT=500`,
cursor-based). It is simpler to reason about and to test in isolation, but it
**doubles the transaction-detail API calls** — which matters given the provider's
rate limits. This is a real trade-off to decide at implementation time; the
piggyback path is the better engineering answer if it can be done cleanly.

### 4.5 Send path

```
1. Look up (or accept) the recipient's public key from the contact list.
2. Build messageId = 32 random bytes hex.
3. AAD = "lbsx-mail-v1|" + senderAddress + "|" + recipientAddress + "|" + messageId.
4. Encrypt { subject, body } → envelope.
5. Build the OP_RETURN payload + 1-sat anchor to the recipient
   + 1,000-sat service fee to the discovery address.
6. Sign, persist intent via broadcastTrackedTransaction, broadcast.
7. Save a local 'pending' copy of the message.
```

The OP_RETURN payload (8 pushes, matching the live `bsv_send` shape):

```js
['LBSX', 'v2', 'mail', senderAddress, recipientAddress,
 messageId, timestamp, envelopeB64]
```

`broadcastTrackedTransaction` already provides persist-before-broadcast, status
reconciliation (accepted/mempool/confirmed/rejected/unknown) and deterministic
retry keying — all reused as-is.

**Review screen.** The 2.1.00 wallet shows service fees on a review screen before
the user confirms ("They are shown on the review screen before you confirm, in
addition to normal network fees"). Mail must do the same: show the 1,000-sat
service fee and the network fee, separately, before signing.

### 4.6 Contact list — where recipient public keys come from

As established: **the sender already has the recipient's public key**, obtained
out-of-band. The wallet must therefore provide a way to *store* it:

- **Add contact:** paste or scan a contact card. The card format should be a
  base64/JSON blob containing `{ address, pubkey, label }`.
- **Own card:** the wallet can display/export its own card (address + compressed
  public key) as a QR code, so two users can exchange keys by camera.
- **Validation on import:** recompute `hash160(pubkey)` and confirm it derives the
  claimed address. Reject mismatches — this is what makes the contact list
  self-authenticating rather than a trust-on-first-use blob.

The contact list is stored in the **existing encrypted wallet-data file**, so
contact public keys are protected at rest exactly like the rest of the wallet state.

### 4.7 Renderer surface

`src/MailPage.jsx`, following the `PeerChatPage.jsx` conventions:

- **Inbox** — list of decrypted messages, newest first, showing sender, subject,
  timestamp, status (pending/confirmed/undecryptable).
- **Thread / detail view** — subject + body, sender, timestamp, txid link to the
  explorer via the existing `openExplorer` bridge.
- **Compose** — recipient picker (from contacts), subject, body, "Encrypt & send"
  with a clear review step before broadcast (per the project's stated rule that
  mainnet broadcast is an explicit user action after a transaction review).
- **Contacts** — add/remove/list, show each contact's public key fingerprint so the
  user can verify a key out-of-band.
- **Info popover** — the honest disclosure of §2.4 (public metadata, no forward
  secrecy, etc.), mirroring how Peer Chat surfaces its own obfuscation trade-off.

---

## 5. Risks and required hardening

1. **Message size vs. fee.** The fee model is `feePerKb(1000)`. An 8 000-character
   message produces a ~14 KB transaction → ~14 sats of fee. Acceptable, but the
   compose UI must show the projected fee **before** the user signs.

2. **Broadcast rate limit.** The default provider caps broadcast at 10 transactions
   per minute per IP. A mail client that auto-sends could hit this. The compose flow
   should be manual-send only, with a visible queue status.

3. **Provider dependency.** Receiving mail requires BananaBlocks (or the configured
   RPC fallback) to serve the address history and transaction details. Without a
   provider the wallet can still *read* cached mail but cannot discover new mail.
   This matches the existing degradation behaviour of the app.

4. **Do not reuse the peer-chat key.** `sha256(ADMIN_DISCOVERY_ADDRESS)` is public by
   design — the comments in `constants.cjs` say so explicitly. Mail must use real
   ECDH against a recipient key.

5. **Reply routing.** A reply must encrypt to the *original sender's* public key.
   The recipient's key is recovered from the received message's own payload, so the
   wallet must persist `senderPubKey` alongside each message — not just the address.

6. **Forward secrecy.** If it is required later, the upgrade path is per-message
   ephemeral ECDH keys with pre-published keys, which is a significantly larger
   change. **Recommended: ship without it, disclose it clearly, defer.**

7. **Proof of possession.** The current check — the sender address appears as a
   transaction input — is good but not cryptographic proof of possession of the
   private key in the general case. A stronger scheme would have the sender sign the
   AAD with their wallet key. This is a natural §5.1 follow-up.

8. **No local plaintext store.** Decrypted bodies must live in the encrypted
   wallet-data file only (which is already encrypted with a key derived from the
   seed). The renderer receives decrypted text over IPC and holds it in memory only.

9. **Service fee is a new product line.** 2.1.00 has an established fee table and
   states "Fees are not refundable. Check the review screen for the exact amounts."
   Mail adds a row at 1,000 sats. The README fee table, the fee constants block in
   `token-wallet.cjs` (currently `BSV_SEND_SERVICE_FEE_SATS` / `TOKEN_MINT_SERVICE_FEE_SATS`),
   and the review screen all need to agree. If the fee is ever changed, the
   `service_fee:<n>sat:wallet_maintenance` marker in the OP_RETURN is what a
   third-party indexer reads — so the constant and the marker must stay in sync.

10. **Two discovery surfaces, one payload.** Because mail pays both the recipient
    (1 sat) and the discovery address (1,000 sats), a mail transaction appears in
    **two** address histories. A third-party indexer following the discovery address
    will see mail payloads it cannot decrypt. That is fine and intended, but the
    `admin-wallet-index.cjs` `hasRelevantProtocolPayload` check does
    `text.includes('peer_chat')` — mail payloads will not match it, so they will
    not trigger a BEEF proof fetch on that path. If mail should be provable via the
    discovery-address path too, that check needs a `mail` case added.

11. **Protocol-tag drift.** Live mainnet contains an *older* peer_chat format
    (`localBSV`/`v1`/`sender:Captainbsv`/`date:`) alongside the current
    (`LBSX`/`v2`/address/timestamp/ciphertext). The 2.1.00 parser only accepts the
    current one. Mail should ship with a strict parser and a documented version
    policy, so future format changes are explicit rather than silent.

---

## 6. Recommended implementation sequence

| Phase | Work | Exit criterion |
|---|---|---|
| 0 | Working tree is already staged from `captainsvbot-wallet-spv-mainnet-port` (verified identical to the shipped 2.1.00 `app.asar`). Install deps, confirm the app builds and the existing test suites pass. | Baseline green. |
| 1 | `electron/mail-crypto.cjs` + `scripts/mail-crypto-smoke.mjs`. | Round-trip, tamper, wrong-key, AAD-swap all pass offline. |
| 2 | `electron/mail.cjs` — OP_RETURN parse/build (8-field `v2`/`mail` format), `sendMail` (2 outputs: 1 sat to recipient + 1,000 sat service fee), `syncMail`. | Offline fixture tests: build a tx, parse it back, decrypt it. |
| 3 | Decide piggyback vs. standalone scan. Extend `summarizeWalletTransaction` to carry the mail payload in `details`, or implement a separate history scan. | A received mail appears in the mailbox from a real history scan. |
| 4 | Wire into `vault.cjs` (`getWalletPublicKey`), `wallet-data.cjs` (schema), `main.cjs` + `preload.cjs` (IPC). | IPC surface returns correct shapes. |
| 5 | `src/MailPage.jsx` + nav + contact list + QR card + review screen showing the 1,000-sat service fee. | Feature-complete UI. |
| 6 | End-to-end on testnet/regtest first, then explicit mainnet review-and-broadcast. | Two independent wallets exchange a real encrypted mail. |
| 7 | Docs: README feature section **+ the fee table row**, SECURITY.md trust model, and the §2.4 limitations stated plainly. | Docs match behaviour. |

Phase 6 is the real acceptance test: **two independent installs, one sends, the
other receives and reads, and a third party with no recipient key cannot read it.**

---

## 7. Honest assessment

**Feasibility: high.** No new dependencies, no protocol changes, no changes to the
cryptographic assumptions the wallet already makes. The primitives are verified
working against the exact dependency versions that ship in 2.1.00.

**Effort: moderate.** Roughly the same shape as the existing Peer Chat feature —
new crypto module, new main-process module, new page, schema extension, IPC
wiring — plus the contact/identity management that Peer Chat does not need.

**The real work is not the cryptography.** It is:
- contact/key management UI,
- the receive-side discovery pass,
- and being honest in the UI about what a public blockchain reveals even when the
  body is encrypted.

**Biggest risk:** not technical. It is shipping a feature whose users assume
"encrypted on-chain mail = private", when the metadata (who, when, how often, how
large) is permanently public and trivially linkable. The UI must say so plainly —
the project has already set this precedent with the Peer Chat obfuscation notice,
and the same discipline should apply here.

---

## Appendix A — Files inspected

- `electron/main.cjs`, `preload.cjs`, `vault.cjs`, `wallet-data.cjs`, `chain.cjs`,
  `token-wallet.cjs`, `market.cjs`, `trading.cjs`, `spv.cjs`, `peer-chat.cjs`,
  `peer-chat-crypto.cjs`, `admin-wallet-index.cjs`, `bananablocks.cjs`,
  `constants.cjs`, `explorer.cjs`, `transaction-tracker.cjs`, `bsv-unspent.cjs`,
  `wallet-deletion.cjs`
- `src/App.jsx`, `src/PeerChatPage.jsx`, `src/TradingPage.jsx`, `src/UtxoStorePanel.jsx`
- `package.json`, `TRADING-PLAN.md`, `README.md`, `SECURITY.md`
- the previously shipped `app.asar` (extracted and diffed
  against both `main` and `captainsvbot-wallet-spv-mainnet-port`)
- Live BananaBlocks API responses: a real `bsv_send` transaction, a real
  (legacy-format) `peer_chat` transaction, and address-history queries for a
  sender address, a recipient address, and the discovery address.

## Appendix B — Verification log

All checks executed with Node v26.7.0 against the 2.1.00 dependency tree.

```
ECDH secp256k1 (node native)          OK, shared secret 32 bytes, symmetric
bsv PublicKey.point.toBuffer()         33 bytes compressed SEC1
bsv PublicKey.fromBuffer() round trip  identical address + identical hex
hash160(pubkey) -> P2PKH address       matches priv.toAddress()
AES-256-GCM round trip                 PASS
wrong-key decrypt                      PASS (rejected)
single-bit ciphertext tamper           PASS (rejected)
AAD recipient swap                     PASS (rejected)
OP_RETURN push parse (006a + PUSHDATA) PASS, 8-field mail payload parses
tx build + reparse                      PASS, 641 bytes for a short mail tx
address history includes sent txs      PASS (live mainnet check)
app.asar == branch (CRLF-normalised)   PASS, 18/18 electron files identical
live bsv_send payload decode            PASS, 8 fields, service_fee marker found
live peer_chat payload decode           PASS, 6 fields, legacy localBSV/v1 tag
/tx detail exposes opreturn script      PASS (piggyback viable)
'mail' op name unused in 2.1.00         PASS (no collision)
```

### Corrections made during planning

The first draft of this plan proposed a `v3` tag and a 1-output transaction. Live
mainnet decoding showed both were wrong, and surfaced the service-fee model:

| Draft said | Reality | Corrected to |
|---|---|---|
| `v3` version tag | version is per-protocol; all 2.1.00 protocols use `v2` | `v2` |
| 7 pushes | `bsv_send` uses 8 (adds an explicit timestamp field) | 8 pushes |
| 1 output (recipient only) | 2.1.00 pays a service fee to the discovery address | 2 outputs, 1,000 sats |
| no service fee | fee table exists; mail adds a 1,000-sat row | documented in §3.2 |
| separate history scan | activity sync already fetches the same tx details | piggyback (§3.4) |
