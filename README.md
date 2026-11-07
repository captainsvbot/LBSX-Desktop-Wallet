# LBSX Desktop Wallet

A desktop wallet for **BSV** and **BSV-21 tokens**, for Windows. You import an
existing recovery phrase; the wallet signs transactions on your computer and
uses [BananaBlocks](https://bananablocks.com/) to read balances and broadcast.

> **Version 2.1.00** · Windows x64 · Electron 39, React 18, Vite 6 · MIT licensed

> ## ⚠️ Read this first
>
> **This is independent, community-built software provided "AS IS", without
> warranty of any kind.** It has **not been audited** by a third party. It
> handles real money. Bugs can cause **permanent, irreversible loss of funds**.
> Only use amounts you can afford to lose, keep your own offline backup of your
> recovery phrase, and test with a small amount first. See
> [Disclaimer](#disclaimer-no-warranty-no-liability).

---

## What it does

- **Import a wallet** from an existing BIP39 recovery phrase (it cannot create
  one; see [Limitations](#limitations)).
- **Send and receive BSV**, with a QR code for your address.
- **View BSV-21 tokens** with their decimals, and **send** them with amount
  validation based on each token's decimals.
- **Token locker:** lock tokens into time-released tranches using on-chain CLTV.
- **Mint a BSV-21 token** with an image (see [Fees](#fees)).
- **Peer trading:** list tokens for sale and buy other listings (OrdLock v2).
- **Peer Chat:** a public on-chain message feed (see [Peer Chat](#peer-chat-is-public)).
- **Activity history** of transactions, saved locally.
- **Delete Wallet** from the Security page, which removes the encrypted vault
  and local data from this computer. It does **not** move any funds.

## What it does not do

- It is **not a full node.** It relies on BananaBlocks for chain data.
- It does **not** create wallets, support hardware wallets, multi-sig, or coin
  control, and runs on **Windows only** (not tested elsewhere).
- It does **not** provide privacy: BananaBlocks sees the addresses you query.
- It does **not** guarantee uptime or accuracy of balances. If BananaBlocks is
  down or rate-limiting, the wallet cannot refresh balances and normally cannot
  broadcast (see [Limitations](#limitations) for the one narrow exception).

---

## Install

1. Download `LBSX Desktop Wallet Setup <version>.exe` from the
   [Releases](../../releases) page.
2. Run it. Windows SmartScreen may warn about an unknown publisher, since the
   installer is not distributed through a trusted code-signing publisher.
3. Open **LBSX Desktop Wallet** and import your recovery phrase.

## BananaBlocks API key

The wallet reads chain data from BananaBlocks. It works without a key, but
anonymous use has lower rate limits. To get a key:

1. Go to **https://bananablocks.com/account** and sign in or create an account.
2. Create an API key there and copy it.
3. In the wallet, open the **API key** tab, paste the key, and enable it.

The key is stored encrypted using the operating system key store (Electron
`safeStorage`) and is only sent to BananaBlocks. A free key raises general read
limits; it does **not** raise the transaction broadcast limit (10 per minute
per IP on the default provider). Plans and limits are set by BananaBlocks and
may change.

## Fees

The wallet charges small service fees, paid in the same transaction to an LBSX
admin address and recorded in an `OP_RETURN` output. They are shown on the
review screen before you confirm. These are in addition to normal network fees.

| Action | Service fee |
|---|---|
| BSV send | 10,000 sats (0.0001 BSV) |
| Mint a token | 0.5 BSV |
| Peer Chat message | 1,000 sats |
| Token listing | 0.0001 BSV anchor to the discovery address |
| Buy a listing | 10,000 sats service fee plus the platform payment shown in review |

Fees are not refundable. Check the review screen for the exact amounts.

---

## How your keys are handled

- Your recovery phrase is **encrypted on disk** and decrypted in memory only
  while the wallet is unlocked. You choose either **device protection** (the OS
  key store via Electron `safeStorage`, no password) or a **vault password**
  (at least 12 characters, scrypt key derivation, AES-256-GCM).
- The phrase is never displayed again, copied from the app, or sent over the
  network. Transactions are signed locally.
- **Locking** the wallet clears the unlocked phrase reference from memory.
- This repository contains no wallet data or keys.

Local encryption does not protect against malware or someone with access to
your unlocked Windows account. Keep your original phrase backed up offline.

## Peer Chat is public

Peer Chat messages are stored on the BSV blockchain. The message key is derived
from a public address, so anyone can read them. Do not post anything private.
Messages cannot be deleted.

---

## Limitations

1. **Single data provider.** BananaBlocks is a hard dependency today. A
   configurable fallback provider is being worked on in
   [issue #2](../../issues/2) and is **not available yet**. In practice this is
   not a known failure today; the work is hardening, not a bug fix. All balance,
   token and history reads go through BananaBlocks only.
   The single exception is broadcasting: if BananaBlocks rejects a transaction
   with an ARC 461 script error (this affects some marketplace purchases), the
   wallet retries the already-signed transaction through GorillaPool ARC and then
   WhatsOnChain. Those services then see that transaction. This is a narrow,
   hard-coded workaround, not a general fallback, and it is not configurable.
2. **Not a full node.** SPV header checks prove a transaction's inclusion, not
   full chain validity or that an output is unspent. The indexer remains the
   source of truth for spend state.
3. **One token input per transaction.** A token action larger than your single
   largest token output is not combined across inputs.
4. **Order book scope.** Only LBSX-native listings are found. Off-chain order
   books are not included.
5. **Cancellations are not announced on-chain** beyond spending the listing.
6. **Import only.** You must already hold a BIP39 phrase.
7. **First sync downloads the header chain** (tens of MB), then syncs
   incrementally.
8. **Windows only**, no hardware wallet, multi-sig, or coin control.
9. **No third-party security audit.**

---

## Development

Requires Node.js LTS on Windows.

```powershell
npm ci
npm run dev        # Vite + Electron
npm run build      # build the renderer to dist/
npm run dist:win   # build the Windows installer
```

`Run Wallet.bat` installs dependencies and starts the app.

### Tests

The test scripts in `scripts/` run offline against synthetic fixtures, for
example:

```powershell
npm run test:bsv-send
npm run test:token-wallet
npm run test:trading
npm run test:wallet-data
```

See `package.json` for the full list. Passing tests do not make the software
safe to use; they only reduce known regressions.

## Contributing and security reports

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`SECURITY.md`](./SECURITY.md).
Never commit wallet data, keys, or recovery phrases.

---

## Disclaimer (no warranty, no liability)

This software is released under the [MIT License](./LICENSE) and is provided
**"AS IS", without warranty of any kind**, express or implied, including but not
limited to merchantability, fitness for a particular purpose, accuracy,
availability, and non-infringement.

**To the maximum extent permitted by law, the author and contributors are not
liable for any claim, damages, or loss**, including loss of funds, tokens, or
data, failed or mistaken transactions, fees, third-party service outages
(including BananaBlocks), or security issues, arising from the use of or
inability to use this software, whether in contract, tort, or otherwise.

- You are solely responsible for your recovery phrase, backups, device
  security, and every transaction you sign.
- Blockchain transactions are **irreversible**. There is no support desk,
  recovery service, or refund.
- Nothing here is financial, investment, legal, or tax advice.
- This is not an offering of any token, security, or financial product. Tokens
  shown in the wallet are created by third parties; the author does not endorse
  or verify them.
- You are responsible for complying with the laws that apply to you.
- BananaBlocks and other third-party services are not affiliated with or
  controlled by the author.

If you do not accept these terms, do not use the software.

## License

MIT. Copyright © 2026 captainsvbot. See [`LICENSE`](./LICENSE).
