import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { scriptToAddress } from '@nervosnetwork/ckb-sdk-utils'
import { getTransaction } from 'services/remote'
import { showPageNotice, transactionState, useDispatch, useState as useGlobalState } from 'states'
import PageContainer from 'components/PageContainer'
import LockInfoDialog from 'components/LockInfoDialog'
import ScriptTag from 'components/ScriptTag'
import AlertDialog from 'widgets/AlertDialog'
import Tabs from 'widgets/Tabs'
import Table from 'widgets/Table'
import CopyZone from 'widgets/CopyZone'
import { BalanceHide, BalanceShow, Copy, GoBack } from 'widgets/Icons/icon'
import Tooltip from 'widgets/Tooltip'

import {
  ErrorCode,
  CONSTANTS,
  localNumberFormatter,
  uniformTimeFormatter,
  shannonToCKBFormatter,
  isSuccessResponse,
} from 'utils'
import { HIDE_BALANCE } from 'utils/const'

import styles from './historyDetailPage.module.scss'

const { MAINNET_TAG } = CONSTANTS

type InputOrOutputType = (State.DetailedInput | State.DetailedOutput) & { idx: number }

const InfoItem = ({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) => (
  <div className={`${styles.basicInfoItemBox} ${className}`}>
    <div className={styles.infoItemLabel}>{label}</div>
    <div className={styles.infoItemValue}>{value}</div>
  </div>
)

const HistoryDetailPage = () => {
  const { hash } = useParams()
  const navigate = useNavigate()
  const {
    app: { pageNotice },
    chain: { networkID },
    settings: { networks },
    wallet: currentWallet,
  } = useGlobalState()
  const network = networks.find(n => n.id === networkID)
  const isMainnet = network != null && network.chain === MAINNET_TAG
  const [t] = useTranslation()
  const [transaction, setTransaction] = useState(transactionState)
  const [error, setError] = useState({ code: '', message: '' })
  const [failedMessage, setFailedMessage] = useState('')
  const [lockInfo, setLockInfo] = useState<CKBComponents.Script | null>(null)

  useEffect(() => {
    if (currentWallet) {
      if (!hash) {
        setFailedMessage(t(`messages.codes.${ErrorCode.FieldNotFound}`, { fieldName: 'transaction hash' }))
        return
      }
      getTransaction({ hash, walletID: currentWallet.id })
        .then(res => {
          if (isSuccessResponse(res)) {
            setTransaction(res.result)
          } else {
            setFailedMessage(t(`messages.codes.${ErrorCode.FieldNotFound}`, { fieldName: 'transaction' }))
          }
        })
        .catch((err: Error) => {
          setError({
            code: '-1',
            message: err.message,
          })
        })
    }
  }, [t, hash, currentWallet])

  const dispatch = useDispatch()
  const onCopy = useCallback(() => {
    window.navigator.clipboard.writeText(transaction.hash)
    showPageNotice('common.copied')(dispatch)
  }, [transaction.hash, dispatch])
  const [isIncomeShow, setIsIncomeShow] = useState(true)
  const onChangeIncomeShow = useCallback(() => {
    setIsIncomeShow(v => !v)
  }, [])

  const infos = [
    {
      label: t('transaction.transaction-hash'),
      value: (
        <div content={transaction.hash} className={styles.address}>
          {transaction.hash}
          <Copy onClick={onCopy} />
        </div>
      ),
    },
    {
      label: t('transaction.block-number'),
      value: transaction.blockNumber ? localNumberFormatter(transaction.blockNumber) : 'none',
    },
    {
      label: t('transaction.date'),
      value: +(transaction.timestamp || transaction.createdAt)
        ? uniformTimeFormatter(+(transaction.timestamp || transaction.createdAt))
        : 'none',
    },
    {
      label: t('transaction.income'),
      value: isIncomeShow ? (
        <div className={styles.income}>
          <CopyZone
            content={shannonToCKBFormatter(transaction.value, false, '')}
            className={styles.incomeCopy}
            maskRadius={8}
          >
            {`${shannonToCKBFormatter(transaction.value)} CKB`}
          </CopyZone>
          <BalanceShow onClick={onChangeIncomeShow} />
        </div>
      ) : (
        <div className={styles.income}>
          {`${HIDE_BALANCE} CKB`}
          <BalanceHide onClick={onChangeIncomeShow} />
        </div>
      ),
    },
  ]

  const inputsTitle = useMemo(
    () => `${t('transaction.inputs')} (${transaction.inputs.length}/${localNumberFormatter(transaction.inputsCount)})`,
    [transaction.inputs.length, transaction.inputsCount, t]
  )

  const outputsTitle = useMemo(() => {
    return `${t('transaction.outputs')} (${transaction.outputs.length}/${localNumberFormatter(
      transaction.outputsCount
    )})`
  }, [transaction.outputs.length, transaction.outputsCount, t])

  const inputsData: InputOrOutputType[] = useMemo(
    () => transaction?.inputs.map((item, idx) => ({ ...item, idx: idx + 1 })),
    [transaction.inputs.length, transaction.inputsCount]
  )
  const outputsData: InputOrOutputType[] = useMemo(
    () => transaction?.outputs.map((item, idx) => ({ ...item, idx: idx + 1 })),
    [transaction.outputs.length, transaction.outputsCount]
  )

  const tabs = [
    { id: 0, label: inputsTitle },
    { id: 1, label: outputsTitle },
  ]
  const [currentTab, setCurrentTab] = useState(tabs[0])

  const handleListData = (cell: Readonly<State.DetailedInput | State.DetailedOutput>) => {
    let address = ''
    if (!cell.lock) {
      address = t('transaction.cell-from-cellbase')
    } else {
      try {
        address = scriptToAddress(cell.lock, isMainnet)
      } catch (err) {
        console.error(err)
      }
    }
    const capacity = shannonToCKBFormatter(cell.capacity || '0')

    return {
      address,
      capacity,
    }
  }

  if (error.code) {
    return (
      <div className={styles.error}>
        {error.message || t(`messages.codes.${ErrorCode.FieldNotFound}`, { fieldName: 'transaction' })}
      </div>
    )
  }

  const columns: {
    title: string
    dataIndex: string
    isBalance?: boolean
    render?: (v: any, idx: number, item: InputOrOutputType, showBalance: boolean) => React.ReactNode
    width?: string
    align?: 'left' | 'right' | 'center'
    className?: string
  }[] = [
    {
      title: t('transaction.index'),
      dataIndex: 'idx',
      width: '90px',
      render(_, __, item) {
        return <>{item.idx}</>
      },
    },
    {
      title: t('transaction.address'),
      dataIndex: 'type',
      align: 'left',
      width: '580px',
      render: (_, __, item) => {
        const { address } = handleListData(item)
        return (
          <>
            <Tooltip
              tip={
                <CopyZone content={address} className={styles.copyTableAddress}>
                  {address}
                </CopyZone>
              }
              className={styles.addressTips}
              showTriangle
              isTriggerNextToChild
            >
              <div className={styles.address}>{`${address.slice(0, 20)}...${address.slice(-20)}`}</div>
            </Tooltip>
            <ScriptTag
              isMainnet={isMainnet}
              className={styles.scriptTag}
              script={item.lock}
              onClick={() => setLockInfo(item.lock)}
            />
          </>
        )
      },
    },
    {
      title: t('transaction.amount'),
      dataIndex: 'amount',
      align: 'left',
      isBalance: true,
      className: styles.amount,
      render(_, __, item, show: boolean) {
        const { capacity } = handleListData(item)
        return show ? (
          <CopyZone maskRadius={8} content={capacity.replaceAll(',', '')}>{`${capacity} CKB`}</CopyZone>
        ) : (
          `${HIDE_BALANCE} CKB`
        )
      },
    },
  ]

  return (
    <PageContainer
      onContextMenu={e => {
        e.stopPropagation()
        e.preventDefault()
      }}
      head={
        <div>
          <GoBack className={styles.goBack} onClick={() => navigate(-1)} />
          <span className={styles.breadcrumbNav}>{`${t('history.title-detail')}`}</span>
        </div>
      }
      notice={pageNotice}
    >
      <div className={styles.basicInfoWrap}>
        <div className={`${styles.basicInfoTitle} ${styles.borderBottom}`}>{t('history.basic-information')}</div>
        <div className={styles.basicInfoItemWrap}>
          <InfoItem {...infos[0]} className={styles.borderBottom} />
          <div className={styles.basicInfoMiddleWrap}>
            <InfoItem {...infos[1]} className={styles.borderBottom} />
            <InfoItem {...infos[2]} className={styles.borderBottom} />
          </div>
          <InfoItem {...infos[3]} />
        </div>
      </div>
      <div className={styles.listWrap}>
        <Table
          head={
            <Tabs
              tabs={tabs}
              onTabChange={setCurrentTab}
              tabsClassName={styles.tabsClassName}
              tabsWrapClassName={styles.tabsWrapClassName}
              tabsColumnClassName={styles.tabsColumnClassName}
              activeColumnClassName={styles.active}
            />
          }
          columns={columns}
          dataSource={currentTab.id === tabs[0].id ? inputsData : outputsData}
          noDataContent={t('overview.no-recent-activities')}
          hasHoverTrBg={false}
        />
      </div>

      {lockInfo && <LockInfoDialog lockInfo={lockInfo} isMainnet={isMainnet} onDismiss={() => setLockInfo(null)} />}

      <AlertDialog
        show={!!failedMessage}
        title={t(`messages.error`)}
        message={failedMessage}
        type="failed"
        onCancel={() => navigate(-1)}
      />
    </PageContainer>
  )
}

HistoryDetailPage.displayName = 'HistoryDetailPage'

export default HistoryDetailPage
