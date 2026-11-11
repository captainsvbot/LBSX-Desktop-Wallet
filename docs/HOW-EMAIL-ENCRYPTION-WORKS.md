# How Encrypted Mail Works — for a newcomer

A plain, no-jargon walkthrough of the LBSX Email feature. Everything here is
verified by running the real implementation: `npm run test:mail-key-exchange`.

---

## The short version

**Neither side ever sends the other a secret.** The sender encrypts to the
receiver's **public key**. The receiver decrypts with their **private key**,
which never leaves their device.

This is the same idea as a padlock: you send someone an open padlock (public
key), they lock the message and send it back, and only the person holding the
padlock's key (private key) can open it. The lock itself is public. The key is
not.

---

## The two kinds of keys

Every BSV wallet already has **one permanent key pair**, derived from your
recovery phrase. It is not created for Email — Email just uses it.

| | What it is | Shared? |
|---|---|---|
| **Private key** | The secret half. Signs your transactions, decrypts your mail. | **Never.** Never leaves your device. |
| **Public key** | The public half. Derived from the private key. | **Yes.** This is what people need in order to mail you. |

Your **address** is just a fingerprint of your public key:
`address = hash160(public key)`.

So when someone tells you "send mail to `1KHJR1VNRvXyfPK3rLVkTki1Y9dygBx7ut`",
they need to also give you the **public key** behind that address. The wallet
checks that the key really belongs to the address — if the two don't match, it
rejects the contact.

### Where does the sender get the recipient's public key?

Out of band, exactly like an email address:

- The recipient shows you their **contact card** (address + public key) — in
  the app, as text you can copy or a QR code to scan.
- You save it as a contact. The wallet verifies the pair.
- Now you can encrypt to them.

**Nobody can look this up for you from the blockchain.** Well — with effort,
anyone *can* recover a P2PKH public key from public history, because it sits in
the `script_sig` of every transaction that address signs. But that's a
*convenience*, not a security hole: a public key can only **encrypt**, never
decrypt. The wallet still makes you obtain and confirm the key deliberately, so
you always know which key you're encrypting to.

---

## Sending: what actually happens

When Alice sends mail to Bob, the wallet does five things:

**1. Alice makes a throwaway key pair — for this message only.**

```
Alice's temporary private key  → secret, used once, then discarded
Alice's temporary public key   → published on-chain
```

This is different from her identity key. Her identity key is permanent and used
for signing; this one exists only to encrypt this single message.

**2. Alice computes the shared secret.**

```
shared_secret = (Alice's temporary private key) × (Bob's public key)
```

**3. Bob computes the same secret, independently.**

```
shared_secret = (Bob's private key) × (Alice's temporary public key)
```

**These come out identical.** That's the magic. Elliptic curve multiplication
is commutative here:

```
(a × G) × b  ==  (b × G) × a
```

And since `Bob's public key = Bob's private key × G`, both sides land on the
exact same point — without either side ever transmitting a secret.

The demo prints it:

```
Alice computes  ephemeral_priv x bob_pub   = c57b15e190c4fa7c507a7992f0f3d732 ...
Bob computes    bob_priv     x ephemeral_pub = c57b15e190c4fa7c507a7992f0f3d732 ...
IDENTICAL?                                YES
```

**4. That secret becomes the encryption key.**

```
AES key = HKDF-SHA256(shared_secret, info="lbsx-mail-v1")
```

HKDF is a "key stretcher": it turns the raw ECDH output into a key of exactly
the right shape for AES, and mixes in a fixed label so this key can never be
reused for anything else.

**5. Alice encrypts the message with AES-256-GCM and publishes it.**

AES-GCM does two jobs at once:
- **Encrypts** the body so nobody without the key can read it.
- **Authenticates** it, so it can't be tampered with. If a single bit is
  changed, decryption fails loudly instead of silently returning garbage.

---

## Receiving: what happens on Bob's side

Bob's wallet scans his own address history. A mail transaction pays 1 satoshi
to his address, so it shows up there. He finds the transaction, reads the
`OP_RETURN` payload, and:

1. Takes Alice's temporary public key from the payload.
2. Computes `(his private key) × (her temporary public key)` → the same secret.
3. Derives the same AES key.
4. Decrypts. The body appears.

**If the message was addressed to a different key, decryption fails** — and the
wallet shows it as *"Cannot decrypt"* rather than pretending it wasn't there.

---

## Why the attacker can't read it

This is the important part, and it's where "the code is on GitHub" matters.

**What the attacker has:**
- The entire source code — every constant, every algorithm
- The transaction, the ciphertext, the envelope
- Alice's temporary public key
- Bob's **public** key (recoverable from public history)

**What they don't have:**
- Bob's **private** key

And here's the crucial distinction:

> Knowing the **function** doesn't tell you the **secret input**.

The AES key is `HKDF(ECDH(Bob's private key, Alice's temp public key))`. The
attacker knows this function perfectly. They have one of its two inputs. The
other is a 256-bit random number that never left Bob's device.

Reversing it means brute-forcing 2²⁵⁶ candidates — longer than the age of the
universe. The demo brute-forces 200,000 and finds nothing:

```
tried 200,000 candidates, found: nothing
```

### The contrast with Peer Chat

This is why Peer Chat and Email are different animals, and it's worth being
blunt about it:

| | Key derived from | Reversible from source alone? |
|---|---|---|
| **Peer Chat** | `sha256(ADMIN_DISCOVERY_ADDRESS)` — a **public constant** | **YES.** Anyone can decrypt it. |
| **Email** | `HKDF(ECDH(recipient_private, ephemeral_public))` | **NO.** A private key is required. |

Peer Chat's own source file says so in plain language: *"Anyone can derive the
key and decrypt any Peer Chat message body."* Email has no such public input.
That is the entire difference.

**`npm run test:mail-source-code-attack`** proves this against a real broadcast
transaction. It re-implements the wallet's decryption from the published
source, recovers the recipient's public key from public history, and tries
seven attacks. Every one is rejected by the GCM tag:

```
✓ rejected    ephemeral pubkey used as the private scalar
✓ rejected    recipient pubkey used as the private scalar
✓ rejected    HKDF(ephemeral pubkey) with no ECDH at all
✓ rejected    HKDF(ephemeral pub || recipient pub)
✓ rejected    sha256(recipient pub) as the key
✓ rejected    ECDH with both roles public
```

---

## Does knowing the message content help them?

This is the question a thoughtful reviewer asks next, and the answer deserves
precision rather than a blanket "no".

### What known plaintext actually gives an attacker

Suppose they know the message is *"Meet at 0900. Bring the signed contract."*
and they have the ciphertext. XOR them together and you get the **AES-CTR
keystream** for that block:

```
keystream: 83f0f9ea924fc30aa5f5cf12f2308884edfe3f6d56dbfd62 ...
```

That keystream is **useless on its own**. It is `AES_k(nonce||counter)` for one
counter value. Turning it back into the key means **inverting AES-256**, which
is exactly what AES is designed to prevent. There is no shortcut.

### The honest part: it *is* a fast verifier

Given a *candidate* key, the attacker can instantly check whether it is the
right one — decrypt and compare to the known plaintext:

```
Correct key      -> VERIFIED (opens)
Wrong key        -> rejected
```

That is real. But they still have to **guess** the 256-bit key. The oracle only
makes each wrong guess fail fast; it does not make guessing easier.

### Why lots of known messages don't combine

Three known-plaintext messages produce three independent equations:

```
ECDH(d, e1_pub) = K1
ECDH(d, e2_pub) = K2
ECDH(d, e3_pub) = K3
```

Three equations, three unknown keys plus `d`. Combining them does not eliminate
`d` — the discrete logarithm is still required for each. And because **every
message uses a fresh ephemeral key**, the keystreams cannot be chained together
either. There is no accumulation over time.

### The implementation is hardened on the points that matter

| Check | Status |
|---|---|
| Ephemeral scalar in valid range `[1, n-1]` | enforced before use |
| Shared point at infinity | rejected |
| Fresh IV per message | 1000/1000 unique — *and* a fresh AES key every time, so nonce reuse is doubly impossible |
| secp256k1 small subgroups | none — prime order curve |
| MOV embedding degree | high — the shared secret cannot be transferred to a weaker curve |

That last one matters: without it, an attacker could theoretically weaken the
curve to make the discrete logarithm tractable.

`npm run test:mail-known-plaintext` demonstrates all of the above with real
execution.

---

## The extra safety net: the AAD

Beyond encryption, the wallet binds each message to its context:

```
aad = "lbsx-mail-v1|" + sender address + "|" + recipient address + "|" + message id
```

This is authenticated as part of the ciphertext. It means:

- You can't take a message addressed to Bob and move it to Carol — the
  decryption fails, because Carol's address is part of what was signed.
- You can't replay the same message under a different message id.
- You can't swap the claimed sender.

So even if someone copies ciphertext around the chain, it only ever opens in
the one context it was created for.

---

## What is *still* public

Honesty matters more than a good story here:

| | Public? |
|---|---|
| The message body | **No** |
| Sender's address | Yes |
| Recipient's address | Yes |
| Timestamp | Yes |
| Message size | Yes |
| How many messages | Yes |
| Can a message be deleted | No |

The **body** is private. The **metadata** is not — permanently, on a public
blockchain. That's arguably worse than SMTP, where a mail server holds the
headers privately rather than publishing a permanent archive. If the size or
timing of your mail is sensitive, that's a real leak.

**There is also no forward secrecy.** Mail is encrypted to a long-lived identity
key. If Bob's private key is compromised *later*, every message ever sent to
Bob can be decrypted from the public chain. Signal avoids this with per-message
ephemeral keys; mail here does not (yet).

---

## So, practically speaking

**To receive mail:** share your contact card (address + public key). Anyone
with it can encrypt to you; only you can decrypt what's sent.

**To send mail:** get the recipient's contact card, save it as a contact, and
compose. The wallet does the cryptography.

**If your device is seized, or your seed phrase is stolen:** the attacker has
your private key, and can read your mail — both received and sent. That's not a
flaw in the design; it's the rule of any encrypted system. Your vault is the
root of trust, which is why the wallet keeps the phrase on your device and
never sends it to a server.

Related: an attacker who can read your **wallet data file** gets the decrypted
plaintext directly, because bodies are stored in the wallet's encrypted-at-rest
store. Protecting the key protects that too.

**If the chain is public and the code is public:** the body is still unreadable.

---

## Reproduce all of it yourself

Every claim in this document is backed by a runnable script. Nothing here is
asserted without being executed.

```bash
npm run test:mail-key-exchange    # the shared secret, and why it can't be reversed
npm run test:mail-crypto          # round-trip, tamper, wrong-key, AAD-swap, replay
npm run test:mail-cross-runtime   # Node and Electron produce interchangeable mail
npm run test:mail-public-attack   # attacks using ONLY public chain data
npm run test:mail-source-attack   # attacks using the FULL PUBLISHED SOURCE
npm run test:mail-known-plaintext # does known message content help them?
npm run test:mail-address-derivation # contact keys must derive the right address
npm run test:mail-tx              # the on-chain transaction format
npm run test:mail-ui              # the Email tab renders in the packaged app
```

The two attack scripts work against the **real** broadcast transaction
`c77bfa2e831f97f7bf449ead1805442e2514e952ae33512a9745397184ba4205`, fetching it
from the public API each time — so they are not testing against a mock.

---

## The three questions a reviewer asks

| Question | Answer | Proof |
|---|---|---|
| Does it actually work? | Yes — two wallets, one real mainnet mail, decrypted on the receiving side | the broadcast transaction above; `test:mail-ui` |
| Can it be broken? | Not with public data or with the full source published | `test:mail-public-attack`, `test:mail-source-attack`, `test:mail-known-plaintext` |
| What is still exposed? | Metadata: who, when, how big, how often. And no forward secrecy. | `SECURITY.md` §4 and the app's own info panel |
Only the metadata leaks.
