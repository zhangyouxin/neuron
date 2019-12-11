import { v4 as uuid } from 'uuid'
import { AccountExtendedPublicKey, PathAndPrivateKey } from 'models/keys/key'
import Keystore from 'models/keys/keystore'
import Store from 'models/store'
import LockUtils from 'models/lock-utils'
import { TransactionWithoutHash, Input, OutPoint, WitnessArgs } from 'types/cell-types'
import ConvertTo from 'types/convert-to'
import { WalletNotFound, IsRequired, UsedName } from 'exceptions'
import { Address as AddressInterface, Address } from 'database/address/address-dao'
import Keychain from 'models/keys/keychain'
import { WalletListSubject, CurrentWalletSubject } from 'models/subjects/wallets'
import { AddressPrefix, serializeWitnessArgs } from '@nervosnetwork/ckb-sdk-utils'

import NodeService from './node'
import FileService from './file'
import { TransactionsService, TransactionPersistor, TransactionGenerator } from './tx'
import AddressService from './addresses'
import { deindexLockHashes } from './indexer/deindex'
import NetworksService from 'services/networks'
import AddressesService from 'services/addresses'
import { Cell, DepType } from 'types/cell-types'
import TypeConvert from 'types/type-convert'
import DaoUtils from 'models/dao-utils'
import FeeMode from 'models/fee-mode'
import { CellIsNotYetLive, TransactionIsNotCommittedYet } from 'exceptions/dao'
import TransactionSize from 'models/transaction-size'
import TransactionFee from 'models/transaction-fee'
import logger from 'utils/logger'
import ProcessUtils from 'utils/process'

const { core } = NodeService.getInstance()
const fileService = FileService.getInstance()

const MODULE_NAME = 'wallets'

export interface Wallet {
  id: string
  name: string

  loadKeystore: () => Keystore
  accountExtendedPublicKey: () => AccountExtendedPublicKey
}

export interface WalletProperties {
  id: string
  name: string
  extendedKey: string // Serialized account extended public key
  keystore?: Keystore
}

export class FileKeystoreWallet implements Wallet {
  public id: string
  public name: string
  private extendedKey: string = ''

  constructor(props: WalletProperties) {
    const { id, name, extendedKey } = props

    if (id === undefined) {
      throw new IsRequired('ID')
    }
    if (name === undefined) {
      throw new IsRequired('Name')
    }

    this.id = id
    this.name = name
    this.extendedKey = extendedKey
  }

  accountExtendedPublicKey = (): AccountExtendedPublicKey => {
    return AccountExtendedPublicKey.parse(this.extendedKey) as AccountExtendedPublicKey
  }

  static fromJSON = (json: WalletProperties) => {
    return new FileKeystoreWallet(json)
  }

  public update = ({ name }: { name: string }) => {
    if (name) {
      this.name = name
    }
  }

  public toJSON = () => {
    return {
      id: this.id,
      name: this.name,
      extendedKey: this.extendedKey,
    }
  }

  public loadKeystore = () => {
    const data = fileService.readFileSync(MODULE_NAME, this.keystoreFileName())
    return Keystore.fromJson(data)
  }

  saveKeystore = (keystore: Keystore) => {
    fileService.writeFileSync(MODULE_NAME, this.keystoreFileName(), JSON.stringify({ ...keystore, id: this.id }))
  }

  deleteKeystore = () => {
    fileService.deleteFileSync(MODULE_NAME, this.keystoreFileName())
  }

  keystoreFileName = () => {
    return `${this.id}.json`
  }
}

export default class WalletService {
  private static instance: WalletService
  private listStore: Store // Save wallets (meta info except keystore, which is persisted separately)
  private walletsKey = 'wallets'
  private currentWalletKey = 'current'

  public static getInstance = () => {
    if (!WalletService.instance) {
      WalletService.instance = new WalletService()
    }
    return WalletService.instance
  }

  constructor() {
    this.listStore = new Store(MODULE_NAME, 'wallets.json')

    this.listStore.on(
      this.walletsKey,
      (previousWalletList: WalletProperties[] = [], currentWalletList: WalletProperties[] = []) => {
        if (ProcessUtils.isMain()) {
          const currentWallet = this.getCurrent()
          WalletListSubject.next({ currentWallet, previousWalletList, currentWalletList })
        }
      }
    )
    this.listStore.on(this.currentWalletKey, (_prevId: string | undefined, currentID: string | undefined) => {
      if (undefined === currentID) {
        return
      }
      if (ProcessUtils.isMain()) {
        const currentWallet = this.getCurrent() || null
        const walletList = this.getAll()
        CurrentWalletSubject.next({
          currentWallet,
          walletList,
        })
      }
    })
  }

  public getAll = (): WalletProperties[] => {
    return this.listStore.readSync(this.walletsKey) || []
  }

  public get = (id: string): Wallet => {
    if (id === undefined) {
      throw new IsRequired('ID')
    }

    const wallet = this.getAll().find(w => w.id === id)
    if (!wallet) {
      throw new WalletNotFound(id)
    }

    return FileKeystoreWallet.fromJSON(wallet)
  }

  public generateAddressesIfNecessary = () => {
    for (const wallet of this.getAll()) {
      if (AddressService.allAddressesByWalletId(wallet.id).length === 0) {
        this.generateAddressesById(wallet.id, false)
      }
    }
  }

  public generateAddressesById = (
    id: string,
    isImporting: boolean,
    receivingAddressCount: number = 20,
    changeAddressCount: number = 10
  ) => {
    const accountExtendedPublicKey: AccountExtendedPublicKey = this.get(id).accountExtendedPublicKey()
    AddressService.checkAndGenerateSave(
      id,
      accountExtendedPublicKey,
      isImporting,
      receivingAddressCount,
      changeAddressCount
    )
  }

  public create = (props: WalletProperties) => {
    if (!props) {
      throw new IsRequired('wallet property')
    }

    const index = this.getAll().findIndex(wallet => wallet.name === props.name)

    if (index !== -1) {
      throw new UsedName('Wallet')
    }

    const wallet = new FileKeystoreWallet({ ...props, id: uuid() })

    wallet.saveKeystore(props.keystore!)

    this.listStore.writeSync(this.walletsKey, [...this.getAll(), wallet.toJSON()])

    this.setCurrent(wallet.id)
    return wallet
  }

  public update = (id: string, props: Omit<WalletProperties, 'id' | 'extendedKey'>) => {
    const wallets = this.getAll()
    const index = wallets.findIndex((w: WalletProperties) => w.id === id)
    if (index === -1) {
      throw new WalletNotFound(id)
    }

    const wallet = FileKeystoreWallet.fromJSON(wallets[index])

    if (wallet.name !== props.name && wallets.findIndex(storeWallet => storeWallet.name === props.name) !== -1) {
      throw new UsedName('Wallet')
    }

    wallet.update(props)

    if (props.keystore) {
      wallet.saveKeystore(props.keystore)
    }
    wallets[index] = wallet.toJSON()
    this.listStore.writeSync(this.walletsKey, wallets)
  }

  public delete = async (id: string) => {
    const wallets = this.getAll()
    const walletJSON = wallets.find(w => w.id === id)

    if (!walletJSON) {
      throw new WalletNotFound(id)
    }

    const wallet = FileKeystoreWallet.fromJSON(walletJSON)
    const newWallets = wallets.filter(w => w.id !== id)

    const current = this.getCurrent()
    const currentID = current ? current.id : ''

    if (currentID === id) {
      if (newWallets.length > 0) {
        this.setCurrent(newWallets[0].id)
      } else {
        this.setCurrent('')
      }
    }

    this.listStore.writeSync(this.walletsKey, newWallets)
    wallet.deleteKeystore()
    const addressInterfaces = AddressService.deleteByWalletId(id)
    this.deindexAddresses(addressInterfaces.map(addr => addr.address))
  }

  private deindexAddresses = async (addresses: string[]) => {
    const prefix = NetworksService.getInstance().isMainnet() ? AddressPrefix.Mainnet : AddressPrefix.Testnet
    const addressesWithEnvPrefix: string[] = addresses.filter(addr => addr.startsWith(prefix))

    if (addressesWithEnvPrefix.length === 0) {
      return
    }
    const addrs: string[] = AddressService.findByAddresses(addressesWithEnvPrefix).map(addr => addr.address)
    const deindexAddresses: string[] = addresses.filter(item => addrs.indexOf(item) < 0);
    // only deindex if no same wallet
    if (deindexAddresses.length !== 0) {
      const lockHashes: string[] = await Promise.all(
        deindexAddresses.map(async address => {
          return new LockUtils(await LockUtils.systemScript()).addressToLockHash(address)
        })
      )
      // don't await
      deindexLockHashes(lockHashes)
    }
  }

  public setCurrent = (id: string) => {
    if (id === undefined) {
      throw new IsRequired('ID')
    }

    if (id !== '') {
      const wallet = this.get(id)
      if (!wallet) {
        throw new WalletNotFound(id)
      }
    }

    this.listStore.writeSync(this.currentWalletKey, id)
  }

  public getCurrent = () => {
    const walletId = this.listStore.readSync(this.currentWalletKey) as string
    if (walletId) {
      return this.get(walletId)
    }
    return undefined
  }

  public validate = ({ id, password }: { id: string; password: string }) => {
    const wallet = this.get(id)
    if (!wallet) {
      throw new WalletNotFound(id)
    }

    return wallet.loadKeystore().checkPassword(password)
  }

  public clearAll = () => {
    this.getAll().forEach(w => {
      const wallet = FileKeystoreWallet.fromJSON(w)
      wallet.deleteKeystore()
    })
    this.listStore.clear()
  }

  public sendTx = async (walletID: string = '', tx: TransactionWithoutHash, password: string = '', description: string = '') => {
    const wallet = this.get(walletID)
    if (!wallet) {
      throw new WalletNotFound(walletID)
    }

    if (password === '') {
      throw new IsRequired('Password')
    }

    const txHash = core.utils.rawTransactionToHash(ConvertTo.toSdkTxWithoutHash(tx))

    const addressInfos = this.getAddressInfos(walletID)
    const paths = addressInfos.map(info => info.path)
    const pathAndPrivateKeys = this.getPrivateKeys(wallet, paths, password)
    const findPrivateKey = (blake160: string) => {
      const { path } = addressInfos.find(i => i.blake160 === blake160)!
      const pathAndPrivateKey = pathAndPrivateKeys.find(p => p.path === path)
      if (!pathAndPrivateKey) {
        throw new Error('no private key found')
      }
      return pathAndPrivateKey.privateKey
    }

    const witnessSigningEntries = tx.inputs!.map((input: Input, index: number) => {
      const blake160: string = input.lock!.args!
      const witnessArgs: WitnessArgs = (tx.witnessArgs && tx.witnessArgs[index]) || {
        lock: undefined,
        inputType: undefined,
        outputType: undefined
      }
      return {
        // TODO: fill in required DAO's type witness here
        witnessArgs,
        lockHash: input.lockHash!,
        witness: '',
        blake160,
      }
    })

    const lockHashes = new Set(witnessSigningEntries.map(w => w.lockHash))

    for (const lockHash of lockHashes) {
      const witnessesArgs = witnessSigningEntries.filter(w => w.lockHash === lockHash)
      // A 65-byte empty signature used as placeholder
      witnessesArgs[0].witnessArgs.lock = '0x' + '0'.repeat(130)

      const privateKey = findPrivateKey(witnessesArgs[0].blake160)

      const serializedWitnesses = witnessesArgs
        .map((value: any, index: number) => {
          const args = value.witnessArgs
          if (index === 0) {
            return args
          }
          if (args.lock === undefined && args.inputType === undefined && args.outputType === undefined) {
            return '0x'
          }
          return serializeWitnessArgs(args)
        })
      const signed = core.signWitnesses(privateKey)({
        transactionHash: txHash,
        witnesses: serializedWitnesses
      })

      for (let i = 0; i < witnessesArgs.length; ++i) {
        witnessesArgs[i].witness = signed[i] as string
      }
    }

    tx.witnesses = witnessSigningEntries.map(w => w.witness)

    const txToSend = ConvertTo.toSdkTxWithoutHash(tx)
    await core.rpc.sendTransaction(txToSend)

    tx.description = description
    await TransactionPersistor.saveSentTx(tx, txHash)

    // update addresses txCount and balance
    const blake160s = TransactionsService.blake160sOfTx(tx)
    const prefix = NetworksService.getInstance().isMainnet() ? AddressPrefix.Mainnet : AddressPrefix.Testnet
    const usedAddresses = blake160s.map(blake160 => LockUtils.blake160ToAddress(blake160, prefix))
    await WalletService.updateUsedAddresses(usedAddresses, core.rpc.node.url)
    return txHash
  }

  // TODO: move this method and generateTx/sendTx out of this file
  public static async updateUsedAddresses(addresses: string[], url: string) {
    const addrs = await AddressService.updateTxCountAndBalances(addresses, url)
    const walletIds: string[] = addrs
      .map(addr => (addr as Address).walletId)
      .filter((value, idx, a) => a.indexOf(value) === idx)
    for (const id of walletIds) {
      const wallet = WalletService.getInstance().get(id)
      const accountExtendedPublicKey: AccountExtendedPublicKey = wallet.accountExtendedPublicKey()
      // set isImporting to undefined means unknown
      AddressService.checkAndGenerateSave(id, accountExtendedPublicKey, undefined, 20, 10)
    }
  }

  public calculateFee = async (tx: TransactionWithoutHash) => {
    const inputCapacities = tx.inputs!
      .map(input => BigInt(input.capacity!))
      .reduce((result, c) => result + c, BigInt(0))
    const outputCapacities = tx.outputs!
      .map(output => BigInt(output.capacity!))
      .reduce((result, c) => result + c, BigInt(0))

    return (inputCapacities - outputCapacities).toString()
  }

  public generateTx = async (
    walletID: string = '',
    items: {
      address: string
      capacity: string
    }[] = [],
    fee: string = '0',
    feeRate: string = '0',
  ): Promise<TransactionWithoutHash> => {
    const wallet = this.get(walletID)
    if (!wallet) {
      throw new WalletNotFound(walletID)
    }

    const addressInfos = this.getAddressInfos(walletID)

    const addresses: string[] = addressInfos.map(info => info.address)

    const lockHashes: string[] = new LockUtils(await LockUtils.systemScript()).addressesToAllLockHashes(addresses)

    const targetOutputs = items.map(item => ({
      ...item,
      capacity: BigInt(item.capacity).toString(),
    }))

    const changeAddress: string = this.getChangeAddress()

    const tx: TransactionWithoutHash = await TransactionGenerator.generateTx(
      lockHashes,
      targetOutputs,
      changeAddress,
      fee,
      feeRate
    )

    return tx
  }

  public generateSendingAllTx = async (
    walletID: string = '',
    items: {
      address: string
      capacity: string
    }[] = [],
    fee: string = '0',
    feeRate: string = '0',
  ): Promise<TransactionWithoutHash> => {
    const wallet = this.get(walletID)
    if (!wallet) {
      throw new WalletNotFound(walletID)
    }

    const addressInfos = this.getAddressInfos(walletID)

    const addresses: string[] = addressInfos.map(info => info.address)

    const lockHashes: string[] = new LockUtils(await LockUtils.systemScript()).addressesToAllLockHashes(addresses)

    const targetOutputs = items.map(item => ({
      ...item,
      capacity: BigInt(item.capacity).toString(),
    }))

    const tx: TransactionWithoutHash = await TransactionGenerator.generateSendingAllTx(
      lockHashes,
      targetOutputs,
      fee,
      feeRate
    )

    return tx
  }

  public generateDepositTx = async (
    walletID: string = '',
    capacity: string,
    fee: string = '0',
    feeRate: string = '0',
  ): Promise<TransactionWithoutHash> => {
    const wallet = this.get(walletID)
    if (!wallet) {
      throw new WalletNotFound(walletID)
    }

    const addressInfos = this.getAddressInfos(walletID)

    const addresses: string[] = addressInfos.map(info => info.address)

    const lockHashes: string[] = new LockUtils(await LockUtils.systemScript()).addressesToAllLockHashes(addresses)

    const address = AddressesService.nextUnusedAddress(walletID)

    const changeAddress: string = this.getChangeAddress()

    const tx = await TransactionGenerator.generateDepositTx(
      lockHashes,
      capacity,
      address!.address,
      changeAddress,
      fee,
      feeRate,
    )

    return tx
  }

  public startWithdrawFromDao = async (
    walletID: string,
    outPoint: OutPoint,
    fee: string = '0',
    feeRate: string = '0'
  ): Promise<TransactionWithoutHash> => {
    const wallet = this.get(walletID)
    if (!wallet) {
      throw new WalletNotFound(walletID)
    }

    const sdkOutPoint = ConvertTo.toSdkOutPoint(outPoint)
    const cellStatus = await core.rpc.getLiveCell(sdkOutPoint, false)
    if (cellStatus.status !== 'live') {
      throw new CellIsNotYetLive()
    }
    const prevTx = await core.rpc.getTransaction(outPoint.txHash)
    if (prevTx.txStatus.status !== 'committed') {
      throw new TransactionIsNotCommittedYet()
    }

    const addressInfos = this.getAddressInfos(walletID)
    const addresses: string[] = addressInfos.map(info => info.address)
    const lockHashes: string[] = new LockUtils(await LockUtils.systemScript()).addressesToAllLockHashes(addresses)

    const depositBlockHeader = await core.rpc.getHeader(prevTx.txStatus.blockHash!)

    const changeAddress = await AddressesService.nextUnusedChangeAddress(walletID)
    const prevOutput = TypeConvert.toOutput(cellStatus.cell.output)
    const tx: TransactionWithoutHash = await TransactionGenerator.startWithdrawFromDao(
      lockHashes,
      outPoint,
      prevOutput,
      depositBlockHeader.number,
      depositBlockHeader.hash,
      changeAddress!.address,
      fee,
      feeRate,
    )

    return tx
  }

  public withdrawFromDao = async (
    walletID: string,
    depositOutPoint: OutPoint,
    withdrawingOutPoint: OutPoint,
    fee: string = '0',
    feeRate: string = '0'
  ): Promise<TransactionWithoutHash> => {
    const DAO_LOCK_PERIOD_EPOCHS = BigInt(180)

    const feeInt = BigInt(fee)
    const feeRateInt = BigInt(feeRate)
    const mode = new FeeMode(feeRateInt)

    const sdkWithdrawingOutPoint = ConvertTo.toSdkOutPoint(withdrawingOutPoint)
    const cellStatus = await core.rpc.getLiveCell(sdkWithdrawingOutPoint, true)
    if (cellStatus.status !== 'live') {
      throw new CellIsNotYetLive()
    }
    const prevTx = await core.rpc.getTransaction(withdrawingOutPoint.txHash)
    if (prevTx.txStatus.status !== 'committed') {
      throw new TransactionIsNotCommittedYet()
    }
    const content = cellStatus.cell.data!.content
    const buf = Buffer.from(content.slice(2), 'hex')
    const depositBlockNumber: bigint = buf.readBigUInt64LE()
    const depositBlockHeader = await core.rpc.getHeaderByNumber(depositBlockNumber)
    const depositEpoch = this.parseEpoch(BigInt(depositBlockHeader.epoch))
    const depositCapacity: bigint = BigInt(cellStatus.cell.output.capacity)

    const withdrawBlockHeader = await core.rpc.getHeader(prevTx.txStatus.blockHash!)
    const withdrawEpoch = this.parseEpoch(BigInt(withdrawBlockHeader.epoch))

    const withdrawFraction = withdrawEpoch.index * depositEpoch.length
    const depositFraction = depositEpoch.index * withdrawEpoch.length
    let depositedEpoches = withdrawEpoch.number - depositEpoch.number
    if (withdrawFraction > depositFraction) {
      depositedEpoches += BigInt(1)
    }
    const lockEpoches = (depositedEpoches + (DAO_LOCK_PERIOD_EPOCHS - BigInt(1))) / DAO_LOCK_PERIOD_EPOCHS * DAO_LOCK_PERIOD_EPOCHS
    const minimalSinceEpochNumber = depositEpoch.number + lockEpoches
    const minimalSinceEpochIndex = depositEpoch.index
    const minimalSinceEpochLength = depositEpoch.length

    const minimalSince = this.epochSince(minimalSinceEpochLength, minimalSinceEpochIndex, minimalSinceEpochNumber)

    const outputCapacity: bigint = await this.calculateDaoMaximumWithdraw(depositOutPoint, withdrawBlockHeader.hash)

    const { codeHash, outPoint: secpOutPoint, hashType } = await LockUtils.systemScript()
    const daoScriptInfo = await DaoUtils.daoScript()

    const address = await AddressesService.nextUnusedAddress(walletID)
    const blake160 = LockUtils.addressToBlake160(address!.address)

    const output: Cell = {
      capacity: outputCapacity.toString(),
      lock: {
        codeHash,
        hashType,
        args: blake160,
      },
      data: '0x'
    }

    const outputs: Cell[] = [output]

    const previousOutput = TypeConvert.toOutput(cellStatus.cell.output)
    const input: Input = {
      previousOutput: withdrawingOutPoint,
      since: minimalSince.toString(),
      lock: previousOutput.lock,
      lockHash: LockUtils.computeScriptHash(previousOutput.lock),
      capacity: previousOutput.capacity,
    }

    const withdrawWitnessArgs: WitnessArgs = {
      lock: '0x' + '0'.repeat(130),
      inputType: '0x0000000000000000',
      outputType: undefined,
    }
    const tx: TransactionWithoutHash = {
      version: '0',
      cellDeps: [
        {
          outPoint: secpOutPoint,
          depType: DepType.DepGroup,
        },
        {
          outPoint: daoScriptInfo.outPoint,
          depType: DepType.Code,
        },
      ],
      headerDeps: [
        depositBlockHeader.hash,
        withdrawBlockHeader.hash
      ],
      inputs: [input],
      outputs,
      outputsData: outputs.map(o => o.data || '0x'),
      witnesses: [],
      witnessArgs: [withdrawWitnessArgs],
      interest: (BigInt(outputCapacity) - depositCapacity).toString(),
    }
    if (mode.isFeeRateMode()) {
      const txSize: number = TransactionSize.tx(tx) + TransactionSize.witness(withdrawWitnessArgs)
      const txFee: bigint = TransactionFee.fee(txSize, BigInt(feeRate))
      tx.fee = txFee.toString()
      output.capacity = (outputCapacity - txFee).toString()
    } else {
      tx.fee = fee
      output.capacity = (outputCapacity - feeInt).toString()
    }

    logger.debug('withdrawFromDao fee:', tx.fee)

    return tx
  }

  public generateDepositAllTx = async (
    walletID: string = '',
    fee: string = '0',
    feeRate: string = '0',
  ): Promise<TransactionWithoutHash> => {
    const wallet = this.get(walletID)
    if (!wallet) {
      throw new WalletNotFound(walletID)
    }

    const addressInfos = this.getAddressInfos(walletID)

    const addresses: string[] = addressInfos.map(info => info.address)

    const lockHashes: string[] = new LockUtils(await LockUtils.systemScript()).addressesToAllLockHashes(addresses)

    const address = AddressesService.nextUnusedAddress(walletID)

    const tx = await TransactionGenerator.generateDepositAllTx(
      lockHashes,
      address!.address,
      fee,
      feeRate,
    )

    return tx
  }

  public calculateDaoMaximumWithdraw = async (depositOutPoint: OutPoint, withdrawBlockHash: string): Promise<bigint> => {

    const result = await (core.rpc as any).calculateDaoMaximumWithdraw(
      ConvertTo.toSdkOutPoint(depositOutPoint),
      withdrawBlockHash,
    )

    return BigInt(result)
  }

  public parseEpoch = (epoch: bigint) => {
    return {
      length: (epoch >> BigInt(40)) & BigInt(0xFFFF),
      index: (epoch >> BigInt(24)) & BigInt(0xFFFF),
      number: epoch & BigInt(0xFFFFFF)
    }
  }

  public epochSince = (length: bigint, index: bigint, number: bigint) => {
    return (BigInt(0x20) << BigInt(56)) + (length << BigInt(40)) + (index << BigInt(24)) + number
  }

  // path is a BIP44 full path such as "m/44'/309'/0'/0/0"
  public getAddressInfos = (walletID: string): AddressInterface[] => {
    const wallet = this.get(walletID)
    if (!wallet) {
      throw new WalletNotFound(walletID)
    }
    return AddressService.allAddressesByWalletId(walletID)
  }

  public getChangeAddress = (): string => {
    const walletId = this.getCurrent()!.id
    return AddressService.nextUnusedChangeAddress(walletId)!.address
  }

  // Derive all child private keys for specified BIP44 paths.
  public getPrivateKeys = (wallet: Wallet, paths: string[], password: string): PathAndPrivateKey[] => {
    const masterPrivateKey = wallet.loadKeystore().extendedPrivateKey(password)
    const masterKeychain = new Keychain(
      Buffer.from(masterPrivateKey.privateKey, 'hex'),
      Buffer.from(masterPrivateKey.chainCode, 'hex')
    )

    const uniquePaths = paths.filter((value, idx, a) => a.indexOf(value) === idx)
    return uniquePaths.map(path => ({
      path,
      privateKey: `0x${masterKeychain.derivePath(path).privateKey.toString('hex')}`,
    }))
  }
}
