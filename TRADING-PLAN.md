# Local-first BSV-21 trading plan

## Goal

Keep wallet custody and the trading client usable when LocalBSV's hosted website is unavailable. The wallet must hold keys locally, reconstruct public chain history where possible, and settle BSV-21 transfers with reviewed, locally signed transactions.

## What the current Trading tab does

- Uses the hardcoded LocalBSV discovery address `15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB` as a read-only chain anchor.
- Reads recent confirmed address history from BananaBlocks and checks transaction details for validated BSV-21 transfer outputs and outputs paying the anchor.
- Labels matches as **settlement candidates**. The combination is useful evidence, but does not prove a trade: the anchor output could be change or an unrelated payment.
- Saves a de-duplicated transaction snapshot locally in the Electron app data folder. It does not access the seed phrase or any private key.
- Shows token ids, metadata when BananaBlocks can resolve it, observed input addresses, block height, and value sent to the anchor.

## Important discovery boundary

LocalBSV's `TokenOrder` and `TokenTrade` entities describe the hosted order book and trade records. The order-placement code puts a `localbsv / dex-order` OP_RETURN marker in a trader's own order transaction. That order transaction does not need to pay the admin wallet. Therefore, scanning the admin wallet can discover some completed fee-linked chain activity, but cannot rebuild the complete open order book or guarantee a complete trade history.

The `BsvToken` entity informs LocalBSV metadata (`token_outpoint`, ticker, decimals, and protocol), but it is also hosted data. On-chain token IDs and BananaBlocks metadata are the fallback when that entity is unavailable. A desktop client must not treat a ticker alone as token identity; use the canonical BSV-21 deploy outpoint.

## Recommended implementation sequence

1. **Read-only chain index (implemented first):** sync anchor history, deduplicate by txid, retain raw token id/outpoint and confirmation evidence, and visibly distinguish indexed facts from inferred candidates.
2. **Local market reconstruction:** parse versioned LBSX order markers found through the admin-wallet anchor and verify each record against its BSV-21/OrdLock output plus the live 1Sat unspent listing index. The current scanner checks recent address history only; broader peer-distributed, checkpointed indexing remains future work.
3. **Peer discovery:** make order announcements signed and self-authenticating, containing network, token outpoint, side, amount, price, maker address, funding outpoint, sequence/nonce, and expiry. Distribute them through multiple independent peers or a DHT; keep the admin address as an optional bootstrap peer, never the only source.
4. **Safe settlement:** negotiate directly with the counterparty, fetch and validate current UTXOs, assemble the BSV-21 transfer plus BSV payment in one transaction, display all inputs/outputs/fees, sign locally, then broadcast through BananaBlocks. Recheck token lineage and outpoint spends immediately before signing.
5. **Recovery and reconciliation:** persist order/settlement intent locally before broadcast, key all retries by deterministic intent id and txid, distinguish accepted/mempool/confirmed/rejected/unknown, and reconcile with independent indexers. Do not reopen an order merely because one provider's lookup is stale.

## Ordinal Lock and token escrow

The referenced 1Sat Ordinal Lock contract describes an on-chain ordinal listing: the seller locks an ordinal, a buyer supplies the specified payment output and destination, or the seller cancels with a signature. The documentation warns the contract is experimental and insufficiently tested. Audit the exact contract and transaction construction before relying on it for production settlement. Do not confuse it with the current wallet's CLTV token locker: CLTV time-lock tranches and Ordinal Lock purchase/cancel are different scripts and have different safety properties.

Current desktop sell listings include a versioned `lbsx` OP_RETURN announcement with the network, BSV-21 token id, listed amount in base units, total price in sats, maker address, source token outpoint, OrdLock output index, and optional token-change output index. The same listing transaction pays 1 sat to the hardcoded discovery address so address-history scanning can find the transaction and read its OP_RETURN. The OP_RETURN itself is not addressed to or indexed by an address. The 1-sat anchor is a real payment and is disclosed because it is not returned on cancellation. Sellers can list part or all of one spendable token UTXO; the transaction writes the unlisted remainder to a separate BSV-21 output owned by the seller. The Trading tab syncs anchored records and shows only confirmed announcements whose token inscription, OrdLock seller/price, and live unspent listing outpoint all match.

## Completion criteria for actual P2P trading

- Market discovery remains usable while hosted wallet services are unavailable.
- Two independent wallet installations can discover each other's orders without trusting the admin wallet.
- Invalid token lineage, stale/spent order funding, duplicate announcements, replayed orders, and conflicting spends are rejected.
- End-to-end tests use regtest/test fixtures first; mainnet broadcast must be an explicit user action after the wallet displays a transaction review.
- A recovery test demonstrates state reconstruction from the local journal plus chain/indexer data after deleting the app cache.
