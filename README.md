# LBSX Desktop Wallet

See [TRADING-PLAN.md](./TRADING-PLAN.md) for the local-first peer-trading design and the limits of admin-wallet discovery.

LBSX Desktop Wallet is a local-first Electron wallet for BSV and BSV-21 assets. Private keys are derived and used on this device; BananaBlocks provides public chain reads and transaction broadcasts.

## Current foundation

- First run opens the import screen. Only existing BIP39 phrases can be imported; there is no phrase/key generation flow.
- Validate and derive the BSV mainnet address in Electron's main process using `m/44'/236'/0'/0/0`.
- Choose either a vault password (scrypt + AES-256-GCM; prompt on each launch) or passwordless opening (encrypted by the OS user key store; opens automatically for the same OS account). The renderer does not receive the phrase back from the main process.
- Sync BSV balances, address UTXOs, and BSV-21 holdings from BananaBlocks with a visible button on Overview and Assets. Confirmed cash/token inputs are checked against BEEF transaction-inclusion proofs and a locally validated mainnet header chain, then saved with transaction bytes and outpoints in the encrypted wallet store. The first SPV sync downloads and validates headers in bounded ranges; later syncs check the remote tip and reconcile reorganizations. Transaction builders use cached inputs first, so wallet-created transaction chains and already-verified parents do not need to be fetched again. BananaBlocks remains necessary to refresh balances and current unspent status, discover missing inputs, and broadcast.
- Import any BSV-21 token by its full origin ID in Trading. Imports are wallet-scoped and remain available in the market selector even when the wallet has no balance for that token.
- Each synced token in Assets has **Send**, **Receive**, and **Locker** actions. Receive shows a QR code and the wallet's public BSV address.
- BSV-21 token transfers, marketplace purchases, and CLTV locker transactions are built and signed in Electron's main process, then broadcast through BananaBlocks. Token carrier outputs are kept separate from ordinary P2PKH fee inputs; accepted local change can fund a follow-up send or purchase before confirmation.
- Activity refresh retrieves confirmed and unconfirmed address history, records locally initiated wallet actions, updates transaction status, and incrementally backfills transaction details without repeatedly fetching known details. After a complete initial backfill, refresh scans newest history pages until it reaches a page with no unseen transaction IDs; it does not use a five-old-transaction threshold. Rows merge by txid, so already-loaded transactions are not duplicated, and detail requests are limited to new rows, changed confirmation heights, or previous lookup failures. Pending local transactions are also checked against BananaBlocks transaction status when address history still reports height zero, so a mined transaction can update Activity and its local UTXO state without waiting for the history index to catch up. It follows BananaBlocks continuation cursors for up to 500 index pages and 500 transaction details per refresh, paces requests, retries rate limits, and preserves failed/deferred lookups and the encrypted page cursor for later refreshes. The ledger shows six saved entries per page, clearly labels partial history as loaded so far, shows the latest cached BSV balance, and provides per-transaction net debit, change, and fee details when available.
- **BSV-21 Tools → Mint a token** creates a fixed-supply `deploy+mint` token in one transaction. A PNG, JPEG, or WebP image (up to 512 KB) is embedded as a 1-satoshi Ordinals output at vout 0; the token output at vout 1 references `_0`, followed by a separate 1-satoshi output to the existing admin discovery address for indexing. Keeping the image and deployment atomic avoids spending unconfirmed change between broadcasts. Network fees are paid from verified wallet BSV UTXOs.
- Token icons referenced by BSV-21 `_0` metadata are extracted from the wallet's locally tracked parent transaction first, with BananaBlocks transaction hex used only when the image transaction is not cached. The same icon appears in Overview, Assets, and the Trading market selector.
- Imported tokens, Activity, verified/observed UTXOs, pending transactions, and locker records are stored per wallet in an AES-256-GCM encrypted local file. The encryption key is derived from the wallet seed and held only while the vault is unlocked. Existing plaintext locker records are migrated on first wallet-data load.
- Wallet-created transactions are persisted locally before broadcast, including raw transaction bytes, input and output outpoints, and spend/reservation state. This supports local transaction chaining after sync. BananaBlocks remains necessary for refreshing balances and external spend state, discovering missing inputs, marketplace/indexer data, and broadcasting transactions; an encrypted cache is not a substitute for current network state.
- The wallet UI includes Overview, Assets, Trading, BSV-21 Tools, Send, Receive, Activity, Security, and BananaBlocks API key settings in the dark, green-accented LBSX style.
- Transaction IDs, BSV-21 token IDs, and outpoints link to their BananaBlocks explorer pages. Each reference has a dedicated copy control; Assets displays each token's complete origin ID.
- Balance-sync progress remains visible through spendable cash/token verification after header validation. Repeated balance-sync requests are coalesced, and validated header caches are reused.
- BananaBlocks requests work anonymously by default. An optional API key can be configured in the wallet's **API key** tab and is encrypted with the operating system's secure storage. When enabled, the key is sent only to BananaBlocks in the `X-API-Key` header. An internet connection is needed to sync public balances.

## Where wallet data is stored

All wallet state lives in the Electron `userData` directory, **never inside the
project folder** and never in the repository. On Windows this resolves to:

```
%APPDATA%\lbsx-desktop-wallet\
```

| File | Contents | Protection |
|------|----------|------------|
| `wallet-vault.json` | The BIP39 recovery phrase | AES-256-GCM with a scrypt-derived key, or Electron `safeStorage` (OS key store) in passwordless mode |
| `wallet-data\<address-hash>.enc` | Per-wallet encrypted state: imported tokens, activity ledger, verified/observed UTXOs, pending transactions, BEEF proofs, SPV header chain, locker records | AES-256-GCM, keyed from the wallet seed while the vault is unlocked |
| `bananablocks-api-key.json` | Optional BananaBlocks API key | Encrypted with Electron `safeStorage`; sent only to `bananablocks.com` in the `X-API-Key` header |
| `spv\mainnet.headers` | Cached BSV mainnet block headers | Public chain data only |
| `trading-chain-cache.json` | Trading discovery cache | Public chain data only |

The recovery phrase and the private key never leave the main process. The
renderer receives only the derived public address and the wallet summary.

To remove every trace of a wallet, delete the `lbsx-desktop-wallet` folder in
`%APPDATA%` (or `%APPDATA%/LBSX Desktop Wallet` for an installed build) and
clear the app's OS key-store entry if passwordless mode was used.

### What is not in this repository

- No keys, recovery phrases, mnemonics, or private keys.
- No wallet databases, vault files, or API keys.
- No `.env`, `.npmrc`, `.pem`, or credential files.
- Test scripts use only the published BIP39 test vector
  (`abandon … about`), synthetic keys derived from `Buffer.alloc`, and a
  placeholder API key.
- The only hardcoded blockchain values are **public**: the BSV genesis hash
  and header, and the shared admin discovery address
  (`15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB`), which is an application-level
  obfuscation key for peer-chat payloads and is not a secret.
- `release-windows-*/`, `release/`, and `dist/` are build output and are
  excluded by `.gitignore`.

## Install on Windows

Run `npm run dist:win` on a Windows development machine to create the v1.2.1 Windows installer in `release-windows-1.2.1/`. The installer adds Start menu and desktop shortcuts and launches the wallet when installation finishes. Users can then open **LBSX Desktop Wallet** like any other desktop application; they do not need to open a command prompt. The installer is currently unsigned, so Windows may show its standard unknown-publisher prompt. The package version is the valid SemVer `1.2.1`; the wallet UI presents it as `v1.2.01`.

## Run in development

On Windows, double-click **Run Wallet.bat**. It installs the project packages on first run and opens the desktop app. Node.js LTS is required for this development build.

For a terminal:

```powershell
npm ci
npm run dev
```

`npm run build` builds the renderer into `dist/`. `npm run dist:win` builds the renderer and packages the Windows installer. Run `npm run test:explorer` to check transaction/token explorer routing and `npm run test:spv` to test local header-cache validation.

## Transaction safety notes

- Token actions require a synced token balance and an available spendable inscription output. If the source UTXO cannot be verified, the wallet refuses to sign.
- Current BSV-21 send/lock transaction builders consume one token carrier input per transaction; the cache can hold multiple verified outputs, but an action larger than the largest single output is not yet combined across token inputs.
- The send path preserves the token amount as base units and returns any remainder to the wallet as a BSV-21 transfer output.
- Lock creation splits token base units across 1–24 tranches; the final tranche receives any division remainder. Claiming spends the CLTV output and returns its token amount to the same wallet.
- BananaBlocks broadcasts are irreversible. Verify the recipient, amount, unlock schedule, and resulting txid. A timeout can be ambiguous, so check the saved txid before retrying a lock.

## SPV and BEEF boundary

Confirmed wallet inputs must pass two separate checks before they are cached as spendable: the parent transaction's BEEF Merkle proof is checked against a locally maintained BSV mainnet header chain (anchored at genesis and validated for proof of work, difficulty, linkage, median-time-past, and chain tip), and BananaBlocks' current UTXO/spend data plus the parent output script/value are checked. The wallet saves BEEF proof records inside its per-wallet encrypted data; public 80-byte block headers are cached locally. A first-time header sync may take several minutes and reports progress in the UI. Later syncs reuse validated headers and cached transaction proofs, checking for tip changes and invalidating proofs after detected reorganizations.

SPV proves transaction inclusion, not that an output is still unspent. The indexer remains the current source for balances, history, and external spend-state refresh, and BananaBlocks is still needed to broadcast. Wallet-created pending outputs are locally tracked and may be chained before confirmation; once confirmed, they must also pass the BEEF/header proof check. These guarantees do not make the app a full node, and the wallet should not sign from an unknown or stale external spend status.

Relevant references:

- [Simplified Payment Verification (SPV)](https://docs.bsvblockchain.org/important-concepts/high-level/simplified-payment-verification-spv)
- [BEEF transaction format](https://docs.bsvblockchain.org/guides/sdks/concepts/beef)
- [BananaBlocks](https://bananablocks.com/) provides the current indexer/node and broadcast connection.
- [ElectrumSVP](https://github.com/TruthMachine/ElectrumSVP), [Simply Cash Wallet](https://github.com/simplycash/simplycashwallet), and [b-open-io/txex](https://github.com/b-open-io/txex) are additional implementation references.

After an input has been verified and cached, local transaction construction, signing, and chaining can use the encrypted wallet records without another parent-transaction or token-history lookup. Sync still contacts BananaBlocks for external balance/UTXO changes and current spend status; broadcasting always requires network access. The wallet must not treat its cache or a BEEF bundle as proof of current unspent status.

## Smoke test

Run `node scripts/e2e-smoke.mjs` to exercise both vault modes in isolated temporary profiles. It uses the published BIP39 test vector `abandon … about`, never uses a real wallet phrase, and removes the temporary test data when it finishes. `npm run test:packaged` additionally checks the packaged Windows app's token-image rendering in Overview, Assets, and Trading using an isolated synthetic fixture.

Run `npm run test:token-wallet` to exercise token send conservation, lock tranche scripts, local locker persistence, and a matured claim using synthetic UTXOs and a mocked broadcaster. Run `npm run test:wallet-data` to exercise encrypted wallet-scoped imports and balance snapshots, sync-time verification and caching of BSV/token inputs, local-only input selection after sync, pagination beyond 100 history records, rate-limit retry/queue recovery, legacy locker migration, UTXO state changes, and 0-conf BSV/token chaining. Run `npm run test:token-mint` to verify an atomic Ordinals image/BSV-21 deployment, requested mint metadata, local token tracking, fee/change accounting, and the admin index output with a mocked broadcaster. These tests use synthetic data and do not send a mainnet transaction.

Run `npm run test:spv` to check genesis anchoring, BEEF inclusion, and invalid proof rejection offline. Run `npm run test:bananablocks-key` to verify encrypted API-key storage, enable/disable behavior, and header scoping without contacting BananaBlocks. The mint smoke test uses a synthetic wallet and a mocked broadcaster with the requested `LBSXWALLET` / `100000` / 8-decimal parameters; it does not mint on mainnet.

On-chain reads and broadcasts still require network access to public nodes/indexers. “Local” here means local key custody, derivation, transaction building/signing, and app state; no hosted wallet account is required.
