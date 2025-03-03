import { t } from 'i18next'
import NetworksService from '../../src/services/networks'
import { MAINNET_GENESIS_HASH, Network, NetworkType, TESTNET_GENESIS_HASH } from '../../src/models/network'
import { BUNDLED_CKB_URL, BUNDLED_LIGHT_CKB_URL, LIGHT_CLIENT_TESTNET } from '../../src/utils/const'

const ERROR_MESSAGE = {
  MISSING_ARG: `Missing required argument`,
  NAME_USED: `Network name is used`,
  NETWORK_ID_NOT_FOUND: `messages.network-not-found`,
}

const uuidV4Mock = jest.fn()
uuidV4Mock.mockReturnValue('mock uuid')

jest.mock('uuid', () => {
  return {
    v4: () => uuidV4Mock(),
  }
})

describe(`Unit tests of networks service`, () => {
  const newNetwork: Network = {
    name: `new network`,
    remote: `http://127.0.0.1:8114`,
    type: 0,
    genesisHash: '0x',
    id: '',
    chain: 'ckb',
    readonly: true,
  }

  const newNetworkWithDefaultTypeOf1 = {
    name: `new network with the default type of 1`,
    remote: `http://127.0.0.1:8114`,
    id: '',
  }

  let service: NetworksService = new NetworksService()

  beforeEach(() => (service = new NetworksService()))
  afterEach(() => service.clear())

  describe(`success cases`, () => {
    it(`get all networks`, () => {
      const networks = service.getAll()
      expect(Array.isArray(networks)).toBe(true)
    })

    it(`has preset networks`, () => {
      const networks = service.getAll()
      expect(networks.length).toBe(2)
      expect(networks[0].id).toEqual('mainnet')
    })

    it(`get the default network`, () => {
      const network = service.defaultOne()
      expect(network && network.type).toBe(0)
    })

    it(`mainnet should be the current one by default`, () => {
      const currentNetworkID = service.getCurrentID()
      expect(currentNetworkID).toBe('mainnet')
    })

    it(`getting a non-existing network should return null`, () => {
      const id = `not-existing-id`
      const network = service.get(id)
      expect(network).toBeNull()
    })

    it(`create a new network with ${JSON.stringify(newNetwork)}`, async () => {
      const res = await service.create(newNetwork.name, newNetwork.remote, newNetwork.type)
      const { name, remote, type } = res
      expect(name).toEqual(newNetwork.name)
      expect(remote).toEqual(newNetwork.remote)
      expect(type).toEqual(newNetwork.type)
      const created = service.get(res.id)
      expect(created!.name).toEqual(res.name)
    })

    it(`create a new network with default type of 1`, async () => {
      const res = await service.create(newNetworkWithDefaultTypeOf1.name, newNetworkWithDefaultTypeOf1.remote)
      expect(res.type).toBe(1)
    })

    it(`update the networks's name`, async () => {
      const network = await service.create(newNetworkWithDefaultTypeOf1.name, newNetworkWithDefaultTypeOf1.remote)
      const name = `new network name`
      await service.update(network.id, { name })
      const updated = service.get(network.id)
      expect(updated && updated.name).toBe(name)
    })

    it(`update the network' address`, async () => {
      const network = await service.create(newNetworkWithDefaultTypeOf1.name, newNetworkWithDefaultTypeOf1.remote)
      const address = `http://127.0.0.1:8115`
      await service.update(network.id, { remote: address })
      const updated = service.get(network.id)
      expect(updated && updated.remote).toBe(address)
    })

    it(`use ipv4 to resolve the localhost in network' remote`, async () => {
      const network = await service.create(newNetworkWithDefaultTypeOf1.name, 'http://localhost:8114/')
      const created = service.get(network.id)
      expect(created && created.remote).toBe('http://127.0.0.1:8114/')
      await service.update(network.id, { remote: 'http://localhost:8114/' })
      const updated = service.get(network.id)
      expect(updated && updated.remote).toBe('http://127.0.0.1:8114/')
    })

    it(`set the network to be the current one`, async () => {
      const network = await service.create(newNetworkWithDefaultTypeOf1.name, newNetworkWithDefaultTypeOf1.remote)
      await service.activate(network.id)
      const currentNetworkID = service.getCurrentID()
      expect(currentNetworkID).toBe(network.id)
    })

    it(`delete an inactive network`, async () => {
      const inactiveNetwork = await service.create(
        newNetworkWithDefaultTypeOf1.name,
        newNetworkWithDefaultTypeOf1.remote
      )
      const prevCurrentID = service.getCurrentID() || ''
      const prevNetworks = service.getAll()
      await service.delete(inactiveNetwork.id)
      const currentID = service.getCurrentID()
      const currentNetworks = service.getAll()
      expect(currentNetworks.map(n => n.id)).toEqual(
        prevNetworks.filter(n => n.id !== inactiveNetwork.id).map(n => n.id)
      )
      expect(currentID).toBe(prevCurrentID)
    })

    it(`activate a network and delete it, the current networks should switch to the default network`, async () => {
      const network = await service.create(newNetworkWithDefaultTypeOf1.name, newNetworkWithDefaultTypeOf1.remote)
      await service.activate(network.id)
      const prevCurrentID = service.getCurrentID()
      const prevNetworks = service.getAll()
      expect(prevCurrentID).toBe(network.id)
      expect(prevNetworks.map(n => n.id)).toEqual(['mainnet', 'light_client_testnet', network.id])
      await service.delete(prevCurrentID || '')
      const currentNetworks = service.getAll()
      expect(currentNetworks.map(n => n.id)).toEqual(['mainnet', 'light_client_testnet'])
      const currentID = service.getCurrentID()
      expect(currentID).toBe('mainnet')
    })
  })

  describe(`validation on parameters`, () => {
    describe(`validation on parameters`, () => {
      it(`service.create requires name, and remote`, async () => {
        expect(service.create(undefined as any, undefined as any)).rejects.toThrowError(t(ERROR_MESSAGE.MISSING_ARG))
        expect(service.create('network name', undefined as any)).rejects.toThrowError(t(ERROR_MESSAGE.MISSING_ARG))
      })

      it(`service.update requires id, options`, () => {
        expect(service.update(undefined as any, undefined as any)).rejects.toThrowError(t(ERROR_MESSAGE.MISSING_ARG))
        expect(service.update('', undefined as any)).rejects.toThrowError(t(ERROR_MESSAGE.MISSING_ARG))
      })

      it(`service.delete requires id `, () => {
        expect(service.delete(undefined as any)).rejects.toThrowError(t(ERROR_MESSAGE.MISSING_ARG))
      })

      it(`service.activate requires id `, () => {
        expect(service.activate(undefined as any)).rejects.toThrowError(t(ERROR_MESSAGE.MISSING_ARG))
      })
    })
  })

  describe(`validation on network existence`, () => {
    beforeEach(async () => {
      await service.create('Default', 'http://127.0.0.1:8114')
    })

    it(`create network with existing name of Default`, () => {
      expect(service.create('Default', 'http://127.0.0.1:8114')).rejects.toThrowError(t(ERROR_MESSAGE.NAME_USED))
    })

    it(`update network which is not existing`, () => {
      const id = `not-existing-id`
      expect(service.update(id, {})).rejects.toThrowError(t(ERROR_MESSAGE.NETWORK_ID_NOT_FOUND, { id }))
    })

    it(`activate network which is not existing`, () => {
      const id = `not-existing-id`
      expect(service.activate(id)).rejects.toThrowError(t(ERROR_MESSAGE.NETWORK_ID_NOT_FOUND, { id }))
    })
  })

  describe('test migrate network', () => {
    const readSyncMock = jest.fn()
    const writeSyncMock = jest.fn()
    const updateAllMock = jest.fn()
    const defaultMainnetNetwork = {
      id: 'mainnet',
      name: 'Internal Node',
      remote: BUNDLED_CKB_URL,
      genesisHash: MAINNET_GENESIS_HASH,
      chain: 'ckb',
      type: NetworkType.Default,
      readonly: true,
    }
    const defaultLightClientNetwork = {
      id: 'light_client_testnet',
      name: 'Light Client Testnet',
      remote: BUNDLED_LIGHT_CKB_URL,
      genesisHash: TESTNET_GENESIS_HASH,
      type: NetworkType.Light,
      chain: LIGHT_CLIENT_TESTNET,
      readonly: true,
    }
    beforeEach(() => {
      service.readSync = readSyncMock
      service.writeSync = writeSyncMock
      service.updateAll = updateAllMock
    })
    afterEach(() => {
      readSyncMock.mockReset()
    })
    it('has migrate', () => {
      readSyncMock.mockReturnValue(true)
      //@ts-ignore private-method
      service.migrateNetwork()
      expect(writeSyncMock).toBeCalledTimes(0)
    })
    it('not find the default network', () => {
      readSyncMock.mockReturnValueOnce(false).mockReturnValueOnce([])
      //@ts-ignore private-method
      service.migrateNetwork()
      expect(writeSyncMock).toBeCalledWith('MigrateNetwork', true)
      expect(updateAllMock).toBeCalledTimes(0)
    })
    it('not change the default network', () => {
      readSyncMock.mockReturnValueOnce(false).mockReturnValueOnce([defaultMainnetNetwork, defaultLightClientNetwork])
      //@ts-ignore private-method
      service.migrateNetwork()
      expect(writeSyncMock).toBeCalledWith('MigrateNetwork', true)
      expect(updateAllMock).toBeCalledWith([defaultMainnetNetwork, defaultLightClientNetwork])
    })
    it('change the default network', () => {
      readSyncMock
        .mockReturnValueOnce(false)
        .mockReturnValueOnce([{ ...defaultMainnetNetwork, name: 'changed name' }, defaultLightClientNetwork])
      uuidV4Mock.mockReturnValueOnce('uuidv4')
      //@ts-ignore private-method
      service.migrateNetwork()
      expect(writeSyncMock).toBeCalledWith('MigrateNetwork', true)
      expect(updateAllMock).toBeCalledWith([
        defaultMainnetNetwork,
        defaultLightClientNetwork,
        {
          ...defaultMainnetNetwork,
          id: 'uuidv4',
          name: 'changed name',
          readonly: false,
          type: NetworkType.Normal,
        },
      ])
    })
  })
})
