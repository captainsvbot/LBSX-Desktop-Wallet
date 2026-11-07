# Contributing to LBSX Desktop Wallet

Thanks for your interest in improving LBSX. This guide covers setup, the
conventions the codebase follows, and the rules that keep real user funds
safe.

---

## The one rule that is not negotiable

**Never commit wallet data, keys, recovery phrases, or any file that could
contain them.**

This includes:

- `wallet-vault.json`
- `wallet-data/` and any `*.enc` file
- `bananablocks-api-key.json`
- `mainnet.headers`
- `token-locks.json`
- Any `.env`, `.npmrc`, `.netrc`, `*.pem`, `*.key`, `*.p12`, or `*.pfx` file
- Screenshots, logs, or crash dumps that might contain a phrase, an address
  you want to keep private, or a real txid from a funded wallet
- Build output (`dist/`, `release/`, `release-windows-*/`)

These paths are already listed in `.gitignore`, but the ignore rules are a
safety net, not a licence to be careless. The application itself stores
nothing in the project directory — all state lives in the Electron `userData`
directory — so there is never a legitimate reason to commit any of it.

If you accidentally commit something sensitive:

1. Do not push it.
2. Tell a maintainer immediately. A pushed secret must be rotated, and a
   pushed recovery phrase means the wallet is compromised.

### Before you open a pull request

Run the secret scan over your changes:

```powershell
# Look for anything resembling key material in the files you touched.
git diff --name-only origin/main | ForEach-Object {
  if (Test-Path $_) { Select-String -Path $_ -Pattern 'mnemonic|privateKey|xprv|secret|apiKey|BEGIN .*PRIVATE' }
}
```

Every match must be a **variable name or a test fixture**, never a literal.
The existing test suites use the published BIP39 test vector
(`abandon … about`), synthetic keys derived from `Buffer.alloc`, and the
placeholder `bb_live_smoke-test-key`. Keep it that way.

---

## Getting set up

**Requirements:** Node.js LTS, and Windows for the packaged build.

```powershell
git clone https://github.com/captainsvbot/LBSX-Desktop-Wallet.git
cd LBSX-Desktop-Wallet
npm ci
npm run dev
```

`npm run dev` starts Vite on `127.0.0.1:5173` and launches Electron against
it. You can also double-click **`Run Wallet.bat`**, which installs
dependencies on first run and opens the app.

### Building the installer

```powershell
npm run dist:win
```

Output lands in `release-windows-2.0.02/`. Update the output directory and NSIS
artifact name in `package.json` when preparing a release.

---

## Running the tests

Every suite is offline and uses synthetic fixtures with a mocked broadcaster.
**None of them broadcast a mainnet transaction, and none of them use a real
recovery phrase.**

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

There are two more that need a built app:

```powershell
node scripts/e2e-smoke.mjs   # Both vault modes in isolated temp profiles
npm run test:packaged        # Token-image rendering in the packaged app
```

**All of the above must pass before a pull request can be merged.** If you
change persistence, SPV, or transaction construction, the relevant suite is
not optional — those are the layers where a regression costs someone money.

---

## Architecture at a glance

```
src/        Renderer — React, sandboxed, no Node access
electron/   Main process — Node, CommonJS, owns keys and the network
scripts/    Offline smoke tests
```

The renderer never receives the recovery phrase or the private key. It gets
the public address and a wallet summary, through a frozen allow-list exposed
by `electron/preload.cjs`. Please keep it that way.

| Module | Owns |
|---|---|
| `electron/vault.cjs` | Key custody, derivation, encryption, lock/unlock |
| `electron/wallet-data.cjs` | The encrypted per-wallet state file |
| `electron/spv.cjs` | Header chain validation, BEEF proofs, reorgs |
| `electron/chain.cjs` | Balance/UTXO/token/activity sync orchestration |
| `electron/token-wallet.cjs` | BSV, BSV-21, mint, lock, claim, chat payloads |
| `electron/market.cjs` | Order book, listing, purchase, cancellation |
| `electron/trading.cjs` | Discovery of peer orders |
| `electron/admin-wallet-index.cjs` | Admin-wallet history scanning |
| `electron/peer-chat.cjs` / `peer-chat-crypto.cjs` | Chat parsing and obfuscation |
| `electron/transaction-tracker.cjs` | Persist-before-broadcast, status reconciliation |
| `electron/bananablocks.cjs` | API key storage, authenticated requests |
| `electron/main.cjs` | Lifecycle, window hardening, IPC handlers |
| `electron/preload.cjs` | The renderer bridge |

---

## Conventions

### Language and style

- **`electron/` is CommonJS** (`.cjs`) because it runs in Electron's main
  process. **`src/` is ES modules** because it runs through Vite. Do not
  convert one to the other.
- Two-space indentation, semicolons, single quotes for strings, trailing
  commas in multi-line literals.
- Prefer `const`; use `let` only when a binding is reassigned.
- Use `===` / `!==`. Avoid `==` and `!=`.
- Prefer `async`/`await` over chained `.then()`.

### Comments

Comment the *why*, not the *what*. The codebase already carries detailed
comments where the reasoning is non-obvious — for example, why the admin
discovery address is public, why a broadcaster is wrapped before use, and why
a lock is preserved as `broadcast-uncertain` when a broadcast times out. Match
that density. Do not narrate obvious code.

### Error handling

- Throw `Error` objects with a **user-readable, actionable** message. These
  strings surface directly in the UI.
- Never swallow an error silently. If a failure is genuinely ignorable,
  comment why.
- Rejecting early with a clear message is always better than failing later
  with a confusing one.

### Security invariants

These are load-bearing. Do not weaken them:

1. **The renderer never gets key material.** Only the public address and
   summary cross the bridge.
2. **Key derivation and transaction signing stay in the main process.**
3. **A UTXO must be SPV-verified before it is treated as spendable.** Observed
   data lives in a separate bucket from verified data for exactly this reason.
4. **State writes stay atomic** — temp file, `0o600`, `wx`, then `rename()`.
5. **A wallet-created transaction is persisted before it is broadcast**, and
   its inputs are reserved in a blocklist so they cannot be double-spent by
   a concurrent action.
6. **The API key goes only to `bananablocks.com`**, only in the
   `X-API-Key` header.
7. **The discovery address stays public.** It is not a secret, and moving it
   to a config file breaks discovery. See `electron/constants.cjs` and
   `SECURITY.md`.
8. **The wallet stays import-only.** Do not add a key-generation flow. There
   is deliberately no `generateMnemonic` or `entropyToMnemonic` in
   `electron/vault.cjs`, and no "create wallet" or "reveal phrase" action in
   `src/`. The only creation path is `importVault()`. The rationale — that
   generating a phrase is the operation most likely to cause unrecoverable
   loss, and that the phrase is never displayed — is documented in the
   README and `SECURITY.md`. If you believe this should change, raise it as
   an issue first; it is a product decision, not a refactor.

### Adding a new persisted field

1. Add it to `emptyData()` in `electron/wallet-data.cjs`.
2. Add sanitisation and a default to `validateData()`.
3. Bump `DATA_VERSION` **only** if existing files become unreadable. A
   backwards-compatible addition should not need a version bump.
4. Add coverage to `scripts/wallet-data-smoke.mjs`.

### Adding a new IPC handler

1. Register it in `electron/main.cjs` with `ipcMain.handle`.
2. Expose it in `electron/preload.cjs` — the bridge is an explicit allow-list.
3. Validate every argument in the main process. The renderer is untrusted
   input, even though it is your own code.
4. Never return key material, raw key bytes, or the phrase.

### Versioning

`package.json`'s `version` is the canonical SemVer. The UI shows a separate
display form (`v2.0.02`). If you change the version, update the display
string in `src/App.jsx` to match, and update `SECURITY.md`'s supported-versions
table.

---

## Reporting security issues

Please do not open a public issue for a security vulnerability. Follow the
private reporting process in [`SECURITY.md`](./SECURITY.md).

Note that some scanners flag `electron/constants.cjs` and
`electron/peer-chat-crypto.cjs`. Both are intentional and explained in
`SECURITY.md` — the discovery address is public by design, and the Peer Chat
key is intentionally derivable from it. The application already discloses
this to users.

---

## Reporting a bug

Open an issue with:

- The wallet version (`v2.0.02` / package version `2.0.2`) and platform.
- What you did, what you expected, and what happened.
- Steps to reproduce, ideally as a test script.
- **A synthetic wallet only.** Do not include a real recovery phrase, a
  real API key, or a txid from a funded wallet.

---

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make the change. Keep the diff focused; unrelated refactors make review
   harder and are better as a separate PR.
3. Add or update the relevant test. Tests are expected for behaviour changes.
4. Run the full test suite and confirm everything passes.
5. Update `README.md` if you changed behaviour, storage layout, or a user-facing
   workflow. The README is the product documentation — if it is wrong, users
   are misled.
6. Open the pull request with a clear description of what changed and why.

---

## License

By contributing, you agree that your contributions are licensed under the
MIT License that covers this project. See [`LICENSE`](./LICENSE).
