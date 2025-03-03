import { getConnection } from 'typeorm'
import { CONNECTION_NOT_FOUND_NAME } from '../database/chain/ormconfig'
import { FailedTransaction, TransactionPersistor } from '../services/tx'
import RpcService from '../services/rpc-service'
import NetworksService from '../services/networks'
import { TransactionStatus } from '../models/chain/transaction'
import TransactionWithStatus from '../models/chain/transaction-with-status'
import logger from '../utils/logger'
import { interval } from 'rxjs'

const getTransactionStatus = async (hash: string) => {
  const url: string = NetworksService.getInstance().getCurrent().remote
  const rpcService = new RpcService(url)
  const txWithStatus: TransactionWithStatus | undefined = await rpcService.getTransaction(hash)
  if (!txWithStatus) {
    return {
      tx: txWithStatus,
      status: TransactionStatus.Failed,
      blockHash: null,
    }
  }
  if (txWithStatus.txStatus.isCommitted()) {
    return {
      tx: txWithStatus.transaction,
      status: TransactionStatus.Success,
      blockHash: txWithStatus.txStatus.blockHash,
    }
  }
  return {
    tx: txWithStatus.transaction,
    status: TransactionStatus.Pending,
    blockHash: null,
  }
}

const trackingStatus = async () => {
  const pendingTransactions = await FailedTransaction.pendings()
  if (!pendingTransactions.length) {
    return
  }

  const pendingHashes = pendingTransactions.map(tx => tx.hash)
  const txs = await Promise.all(
    pendingHashes.map(async hash => {
      const txWithStatus = await getTransactionStatus(hash)
      return {
        hash,
        tx: txWithStatus.tx,
        status: txWithStatus.status,
        blockHash: txWithStatus.blockHash,
      }
    })
  )

  const failedTxs = txs.filter(tx => tx.status === TransactionStatus.Failed)
  const successTxs = txs.filter(tx => tx.status === TransactionStatus.Success)

  if (failedTxs.length) {
    await FailedTransaction.updateFailedTxs(failedTxs.map(tx => tx.hash))
  }

  if (successTxs.length > 0) {
    const url: string = NetworksService.getInstance().getCurrent().remote
    const rpcService = new RpcService(url)
    for (const successTx of successTxs) {
      const transaction = successTx.tx!
      const { blockHash } = successTx
      const blockHeader = await rpcService.getHeader(blockHash!)
      if (blockHeader) {
        transaction.setBlockHeader(blockHeader)
        await TransactionPersistor.saveFetchTx(transaction)
      }
    }
  }
}

export const register = () => {
  interval(5000).subscribe(async () => {
    try {
      getConnection()
      await trackingStatus()
    } catch (err) {
      logger.warn(`status tracking error: ${err}`)
      if (err.name !== CONNECTION_NOT_FOUND_NAME) {
        throw err
      }
    }
  })
}
