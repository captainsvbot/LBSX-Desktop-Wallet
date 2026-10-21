const { getWalletData, prepareWalletTransaction, setWalletTransactionStatus } = require('./wallet-data.cjs');

function isDefinitiveBroadcastRejection(value) {
  const message = typeof value === 'string' ? value : String(value?.message || '');
  return value?.code === 'BROADCAST_REJECTED'
    || /(?:\btxStatus\b["']?\s*(?::|=|\s)\s*["']?REJECTED\b|transaction rejected by peer)/i.test(message)
    || /HTTP 400[\s\S]*(?:invalid outputs|transaction is invalid|dust)/i.test(message);
}

async function reconcileDefinitivelyRejectedTransactions(address) {
  const data = await getWalletData(address);
  const rejected = data.transactions.filter(transaction => transaction.status === 'broadcast-uncertain'
    && isDefinitiveBroadcastRejection(transaction.lastError));
  for (const transaction of rejected) {
    await setWalletTransactionStatus(address, transaction.txid, 'rejected', transaction.lastError);
  }
  return rejected.map(transaction => transaction.txid);
}

async function broadcastTrackedTransaction({ address, txid, rawHex, type, inputOutpoints, details, excludeTokenVouts, broadcast }) {
  await prepareWalletTransaction(address, {
    txid,
    rawHex,
    type,
    inputOutpoints,
    details,
    excludeTokenVouts,
  });
  try {
    await broadcast();
  } catch (error) {
    const rejected = isDefinitiveBroadcastRejection(error);
    await setWalletTransactionStatus(
      address,
      txid,
      rejected ? 'rejected' : 'broadcast-uncertain',
      error?.message || 'Broadcast acceptance could not be confirmed.',
    );
    if (rejected) throw new Error(`${error.message} The local transaction is marked rejected as ${txid}; its inputs were released.`);
    throw new Error(`${error.message || 'The transaction broadcast could not be confirmed.'} Its local record is marked uncertain as ${txid}; refresh Activity before retrying.`);
  }
  try {
    await setWalletTransactionStatus(address, txid, 'pending');
  } catch (error) {
    throw new Error(`Transaction ${txid} was accepted for broadcast, but local tracking could not be updated: ${error.message}`);
  }
  return txid;
}

module.exports = { broadcastTrackedTransaction, isDefinitiveBroadcastRejection, reconcileDefinitivelyRejectedTransactions };
