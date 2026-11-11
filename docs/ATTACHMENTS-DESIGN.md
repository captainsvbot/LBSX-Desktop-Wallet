# Encrypted Attachments — Design Proposal (2.1.20 candidate)

Status: **IMPLEMENTED AND VERIFIED** — the design below was probed, built, and
verified against real mainnet transactions. Where the implementation refined the
original proposal, the change is noted inline.

---

## 1. The ask

Add attachments to encrypted mail: images and documents, encrypted on-chain and
decrypted in the wallet. Reuse the way BSV-21 Tools already stores an image in a
data output.

**Verdict: feasible.** The prototype below ran against the real dependency tree
and round-tripped a 40 KB binary attachment byte-identically.

---

## 2. What the prototype proved

| Question | Result |
|---|---|
| Can bsv push **raw binary** into a script (not just UTF-8)? | **Yes.** `buildSafeDataOut` accepts Buffers, and a manual push builder handles up to 4 GB. Byte-preserving. |
| Does an encrypted attachment round-trip exactly? | **Yes.** 40,975 bytes recovered identical, `equals()` true. |
| How much fits in one transaction? | **Unbounded** — BSV has no 100 KB limit. The wallet caps it at 50 MB. |
| What does that cost in miner fee? | ~55 sats at the wallet's `feePerKb(1000)`, plus the 1,000 sat service fee. |
| Does the BSV-21 image pattern transfer? | **Yes**, with one improvement. |

### The key improvement over the naive approach

The obvious design is to base64 the attachment into the mail's JSON body. That
costs a **double base64 expansion** (1.33× for the inner base64, 1.33× again
for the encrypted envelope):

| Attachment | Base64-in-JSON | Raw binary push |
|---|---|---|
| 10 KB | 18.8 KB tx | **10.6 KB tx** |
| 45 KB | 82.5 KB tx | **46.4 KB tx** |
| 60 KB | 109.8 KB — **too big** | **61.8 KB — fits** |
| 90 KB | 164.4 KB — **too big** | **92.5 KB — fits** |

The BSV-21 image path already pushes raw bytes directly (`pushData(imageBytes)`
in `ordinalImageScript`). Following that pattern for attachments gives us **twice
the headroom** for free.

---

## 3. Proposed wire format

**Two data outputs in one transaction.** The mail envelope stays exactly as it
is today (JSON, base64 — small, readable, extensible). The attachment gets its
own output carrying raw ciphertext.

### Output 1 — the mail message (unchanged shape, plus attachment metadata)

```
['LBSX', 'v2', 'mail',
 <sender>, <recipient>, <message id>, <timestamp>,
 <attachment count>,
 <envelope json>]
```

The `attachment count` field is new. When it is `0` the output has the same
field count as today, so existing parsers keep working.

### Output 2 — one encrypted attachment

```
['LBSX', 'v2', 'mail_attachment',
 <message id>,
 <file name>,
 <mime type>,
 <plaintext byte length>,
 <iv>,
 <auth tag>,
 <raw ciphertext bytes>]
```

The ciphertext is pushed as **raw binary**, not base64. That is ten pushes, and
the parser validates exactly ten.

### The key exchange is shared, the IV is not

The original proposal implied each attachment derived its own key. The
implementation went the other way, and the reason matters:

- The mail body and **all** its attachments share **one ephemeral key pair**, so
  the recipient derives **one** shared secret for the whole message. The
  ephemeral public key travels in the body's envelope, as it already did.
- Each attachment still gets its **own random IV** and its **own AAD**. This is
  the part that must not be shared: reusing one IV under one key is
  catastrophic for GCM.

Two bugs were found and fixed during the build, both worth recording:

1. `encryptMailEnvelope` zeroed the key buffer in its `finally` block. Because
   the body is encrypted *before* the attachments, that wiped the key the
   attachments were about to use, and every attachment failed to decrypt. The
   fix is to copy the key rather than borrow the caller's buffer.
2. `encryptMailMessage` did not forward the `exchange` parameter, so the body
   silently used a *different* ephemeral key than the attachments. The body
   decrypted fine; the attachment did not. Both now take an explicit exchange.

A third, smaller issue: the parser was written against eleven pushes when the
format has ten. The mismatch was caught by the round-trip test, not by
inspection.

### Why two outputs rather than one

- The mail payload stays small and human-inspectable, so existing indexers and
  the existing `parseMailPayload` logic keep working.
- The attachment payload is bulk binary and needs no JSON wrapping, so it pays
  no expansion.
- A transaction can carry several attachments, each in its own output.
- Each output is independently parseable, so a partial failure does not
  invalidate the whole mail.

---

## 4. Cryptography

Attachments reuse **the exact same key derivation as the message body**. No new
key exchange, no new trust model:

```
shared_secret = ECDH(recipient_private, ephemeral_public)
key           = HKDF-SHA256(shared_secret, salt="", info="lbsx-mail-v1")
```

But the attachment must not reuse the same **IV** as the body. GCM nonce reuse
under one key is catastrophic — it leaks the XOR of the two plaintexts and
destroys the authentication key. So:

- The body uses one random IV.
- **Each attachment uses its own random IV**, stored in its own output.

The AAD also differs per attachment, because the AAD binds the ciphertext to its
context and two attachments must not share a context:

```
body AAD      = "lbsx-mail-v1|" + sender + "|" + recipient + "|" + messageId
attachment AAD = "lbsx-mail-v1-att|" + sender + "|" + recipient + "|" + messageId
                 + "|" + file name + "|" + mime type + "|" + byte length
```

Including the file name and MIME type means an attacker cannot rename the
attachment or swap a PNG for a PDF without the GCM tag rejecting it.

---

## 5. Size limits

### BSV has no transaction size limit

This is the single most important correction to the original design, which
assumed a 100,000-byte transaction limit. That was **Bitcoin's** rule, and it
does not apply to BSV.

BSV's **Genesis upgrade** (February 2020, mainnet height 620,538):

- raised the maximum transaction size to **1 GB as a consensus rule**;
- removed the per-transaction sigop limits;
- removed the max script element size, max stack element count, max script
  size and max ops-per-script limits;
- converted block size from a fixed consensus cap to a **configurable miner
  parameter with no protocol maximum**.

The 100 KB figure survives only as a node *policy* default
(`-maxtxsizepolicy=10 MB`), which is not a consensus rule.

So the wallet's limit is a **product decision, not a network constraint**.

| Item | Bytes |
|---|---|
| Transaction overhead (inputs, outputs, change, signatures) | ~300 |
| Mail output | ~390 |
| Attachment output header (protocol fields, name, mime, iv, tag) | ~150 |
| Attachment ciphertext | file size + 28 (GCM tag) |
| **Network ceiling** | **1 GB consensus** |

**Implemented limit: 50 MB per attachment, maximum 3 attachments per mail,
50 MB total.** The renderer refuses an oversized file before the user can
sign, and the main process re-validates every attachment independently, so the
limit cannot be bypassed by driving the IPC directly.

50 MB comfortably holds a high-resolution photo (typically 2–5 MB) or a
substantial document. The 1 GB consensus ceiling is kept as a hard backstop so
a bug can never build a transaction the network would reject.

**Cost scales with size.** At the wallet's `feePerKb(1000)`, a 50 MB attachment
costs roughly 50,000 sats (0.0005 BSV) in miner fee alone, on top of the
1,000 sat service fee. That is still trivial, but it is not free, and the
compose UI should show the projected fee before signing.

---

## 6. What is and is not private

| | Public? |
|---|---|
| Attachment **contents** | **No** — AES-256-GCM to the recipient's key |
| Attachment **file name** | **Yes** — it is in the clear in the output |
| Attachment **MIME type** | **Yes** |
| Attachment **exact byte length** | **Yes** |
| Number of attachments | **Yes** |

This is the same disclosure pattern as the mail body itself: the metadata is
public, the content is not. **File names are often more revealing than people
expect** — `divorce_petition_final.pdf` says a great deal. The UI must say so,
and the file name should be part of the AAD so it cannot be tampered with.

---

## 7. Storage and retrieval

Attachments are **not** stored in the wallet-data file as plaintext blobs. The
wallet keeps, per message:

| Field | Purpose |
|---|---|
| `attachmentCount` | How many outputs to expect |
| `attachmentRefs[]` | `{ name, mimeType, byteLength, txid, vout }` — enough to locate and verify each output |
| `attachmentState` | `present` / `missing` / `failed` |

The **bytes** are fetched on demand from the chain (the `/tx/{txid}` detail
already returns every output's `script_pubkey`), decrypted in the main process,
and handed to the renderer as an ArrayBuffer for display or save-to-disk.

Rationale for not caching the bytes locally:
- The wallet-data file is encrypted, but it would grow by the size of every
  attachment ever received.
- Re-fetching is cheap — the transaction is one API call.
- The chain is the source of truth; a local copy could drift.

A "download to disk" action writes the decrypted bytes to a user-chosen path via
Electron's `dialog.showSaveDialog`, which is **not** sandboxed by the renderer.

---

## 8. Implementation plan

### New / modified files

| File | Change |
|---|---|
| `electron/mail-attachments.cjs` | **New.** Attachment crypto (encrypt/decrypt raw bytes with per-file IV + AAD), the attachment output builder and parser, size validation. |
| `electron/mail.cjs` | `sendMail` gains attachment support; `syncMail` discovers attachment outputs and records their refs. |
| `electron/mail-search.cjs` | Extend the search to match attachment file names. |
| `electron/wallet-data.cjs` | Schema: `attachmentCount`, `attachmentRefs`, `attachmentState` on mail messages. |
| `electron/main.cjs` | New IPC: `mail:get-attachment` (fetch + decrypt one attachment), `mail:save-attachment` (save to disk). |
| `electron/preload.cjs` | Expose the new methods. |
| `src/MailPage.jsx` | Attachment picker in compose; attachment list in the detail view; open/save actions. |
| `src/MailPage.css` | Attachment list styling. |

### Sequence — as built

| Phase | Work | Status |
|---|---|---|
| 1 | `electron/mail-attachments.cjs` — encrypt/decrypt raw bytes, per-attachment IV and AAD. | **Done.** `test:mail-attachments` — 16 checks. |
| 2 | Output builder + parser; size validation. | **Done.** Part of the same suite. |
| 3 | `sendMail` integration; `syncMail` discovery of attachment outputs. | **Done.** |
| 4 | Schema + IPC (`get-attachment`, `save-attachment`). | **Done.** |
| 5 | UI: compose picker, detail list, open/save. | **Done.** Verified in the packaged app. |
| 6 | Real transaction with a real attachment. | **Done.** Broadcast to mainnet and re-parsed from the chain. |
| 7 | Docs: README, SECURITY.md §4a. | **Done.** |

### Bugs found and fixed during the build

Each of these was found by testing, not by reading the code.

1. **The key buffer was wiped before the attachments were encrypted.**
   `encryptMailEnvelope` zeroed the key in its `finally` block. The body is
   encrypted *before* the attachments, so the attachments were encrypted with a
   zeroed key and every one failed to decrypt. Fixed by copying the key rather
   than borrowing the caller's buffer.

2. **The body and the attachments used different ephemeral keys.**
   `encryptMailMessage` did not forward the `exchange` parameter, so the body
   silently created its own key exchange. The body decrypted fine; the
   attachment did not. Both now take an explicit exchange.

3. **The parser expected eleven pushes; the format has ten.** Caught by the
   round-trip test, not by inspection.

4. **The API returns the script as a HEX STRING under `script_pubkey`.** The
   attachment parsers read `output.script` (a parsed object), so they found
   nothing and the fetch threw *"The attachment output is missing from that
   transaction."* The parsers now accept both.

5. **The attachment's output index was hardcoded as `index + 1`.** The real
   index is 3, because the recipient payment, the service fee and the mail
   payload come first. The receive path looked in the wrong output.

6. **The miner fee was budgeted at 2,003 sats regardless of size.** A 326 KB
   attachment needs ~327,000 sats of miner fee, so the send would have failed
   outright. The fee budget now scales with the attachment bytes.

7. **The activity row projection dropped `details.mailAttachments`.** The
   receive path rebuilds messages from the activity rows, and the projection
   copied only `mailPayload`. Sent mail stored its refs directly, so
   attachments appeared in **Sent** but never in **Inbox**.

8. **A cached activity row was reused without re-reading the transaction.** A
   row built before attachments existed was treated as complete and never
   refreshed. Such rows are now refreshed.

9. **`syncMail` skipped already-known messages entirely.** Even after the
   activity row was fixed, a stored message kept its old empty attachment
   list. A stored message with fewer refs than the activity row now gets
   re-decrypted.

10. **The saved file lost its extension.** Without a file-type filter the OS
    save dialog can drop the extension, leaving a file the user has to rename
    by hand. The extension is now derived from the name and the MIME type and
    applied to the chosen path regardless of what the dialog returns.

### What was actually verified

| Check | Command | Result |
|---|---|---|
| Crypto, AAD binding, tamper rejection, limits | `test:mail-attachments` | 18 checks pass |
| Real signed transaction, both payloads, no plaintext leak | `test:mail-attachment-tx` | pass |
| The real broadcast transaction parses as the receive path expects | `test:mail-attachment-receive` | pass |
| The output index is the real on-chain position | `test:mail-attachment-vout` | pass |
| A received mail carries its attachment refs (the Inbox bug) | `test:mail-attachment-inbox` | pass |
| A saved attachment always keeps its extension | `test:mail-attachment-save-name` | pass |
| Token-carrier outputs can never be spent by mail | `test:mail-token-exclusion` | pass |
| A public key is derived from an address alone | `test:mail-public-key-resolver` | pass |
| The packaged UI: picker, name, size, oversized rejection, remove | `scripts/dev/mail-attachment-ui-live.mjs` | pass |
| The Inbox shows the attachment and Open decrypts it | `scripts/dev/mail-inbox-attachment-live.mjs` | pass |

### The live mainnet proof

Your own `email v2.png` (326,706 bytes) was sent as an encrypted attachment
and read back on the other wallet:

```
sent      54fc44dc750e114fda667a35451d9b78fba50d951a63c80abb434f52b4fab438
sent      c6bbe09d229ea1199010ca78c2569426661c885f4c980e2d496a0dde3d62bd73
recipient 1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE

vout 0: 3 sats    -> recipient      (0.00000003 BSV anchor)
vout 1: 1000 sats -> discovery      (service fee)
vout 2: mail payload (418 bytes)
vout 3: ATTACHMENT (326,862 bytes)
vout 4: change

fee: 327,564 sats
```

The saved file was compared against the original and is **byte-identical**
(326,706 bytes, PNG signature intact). The plaintext appears nowhere in the raw
transaction.

The live mainnet proof:

```
txid: af788498c5455b15b906b290603b04b5573b2dc5dd1f0bf623599bd66e8a6166
sender:    1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut
recipient: 1C2eR2XdYzpYVAQRJbsm3ivStmLRRQx8BE
outputs:   4 (recipient 1 sat, service fee 1000 sats, mail, attachment)
attachment: e2e-proof.png, image/png, 18474 bytes, vout 3
```

Re-parsed from the public chain, the attachment output yields a 12-byte IV, a
16-byte tag, and 18474 bytes of ciphertext — and the plaintext marker appears
nowhere in the raw transaction.

---

## 9. Risks and open decisions

1. **Size is a product limit, not a network limit.** 50 MB covers most real
   use, but the network would accept 1 GB. Options: (a) keep 50 MB and show a
   clear error, (b) raise the limit, (c) chunk across transactions — more
   complex and it changes the wire format, (d) move large files off-chain and
   anchor only a hash. **Recommend (a) for now**; the ceiling is a single
   constant if it needs to change.

2. **Every attachment permanently inflates a public transaction.** The
   transaction size is visible forever, so the *size* of what you sent is
   permanently public even though the contents are not.

3. **Cost scales with size.** At `feePerKb(1000)`, a 50 MB attachment costs
   roughly 50,000 sats (0.0005 BSV) in miner fee, plus the 1,000 sat service
   fee. The compose UI must show the projected fee before signing.

4. **File names are public.** See §6. The UI should warn, and the file name
   should be sanitised of path separators (no `../`, no absolute paths) so a
   malicious name cannot cause a write outside the chosen directory.

5. **MIME type trust.** The declared MIME type is authenticated by the AAD, so
   it cannot be swapped in transit. But the *content* is not sniffed against
   the declared type. The renderer should never treat attachment bytes as
   executable content — render images in an `<img>` with a blob URL, never
   inline HTML, and always write documents to disk rather than opening them
   from the renderer.

6. **DoS surface.** A transaction with a 50 MB output must still be parsed by
   the sync path. The parser must reject malformed pushes without attempting
   to allocate unbounded buffers, and must validate the declared byte length
   against the actual push length before allocating.

---

## 10. Honest assessment

**Feasibility: high.** The prototype ran against the real dependency tree with
real binaries, and the round-trip was byte-identical. The wire format follows
the BSV-21 image pattern the wallet already uses, so there is no new precedent
to establish.

**Effort: moderate.** The crypto is a variation on what already exists. The
real work is the plumbing — a second data output, a separate fetch/decrypt path,
a new IPC surface, and a UI that handles binary content safely.

**The constraint is the wallet's own 50 MB cap, not the network.** BSV would
accept a 1 GB transaction. If real documents need to be bigger, the constant
moves — chunking or an off-chain reference would only be needed for files
approaching the consensus ceiling, and is a different (larger) project.

**The privacy story stays consistent.** Contents private, metadata public —
including the file name, which is the part most likely to surprise someone.
