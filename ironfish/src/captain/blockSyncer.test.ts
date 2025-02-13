/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BlockSerde } from './anchorChain/blockchain/Block'
import Target from './anchorChain/blockchain/Target'
import { BlockSyncer, Validity } from '.'
import { RangeHasher } from './anchorChain/merkleTree'
import { Assert } from '../assert'
import { Direction, IncomingPeerMessage } from '../network'
import { BufferSerde } from '../serde'
import {
  makeCaptainSyncable,
  makeCaptain,
  response,
  request,
  TestBlockSyncer,
  blockHash,
  makeFakeBlock,
  makeChain,
  SerializedTestTransaction,
  TestStrategy,
  TestCaptain,
  TestBlockchain,
} from './testUtilities'
import { StringUtils } from '../utils'

import { BlockRequest, BlocksResponse, MessageType } from './messages'
import { createRootLogger } from '../logger'
import { NetworkBlockType } from './blockSyncer'

const serializedBlockHash = (position: number): string => {
  const hash = blockHash(position)
  return new BufferSerde(32).serialize(hash)
}

describe('BlockSyncer', () => {
  describe('Handlers', () => {
    const strategy = new TestStrategy(new RangeHasher())
    let syncer: TestBlockSyncer
    let targetSpy: jest.SpyInstance

    beforeEach(async () => {
      targetSpy = jest.spyOn(Target, 'minDifficulty').mockImplementation(() => BigInt(1))
      const captain = await makeCaptain(strategy)
      syncer = new BlockSyncer(captain, createRootLogger())
    })

    afterAll(() => {
      targetSpy.mockClear()
    })

    it('constructs a block syncer', () => {
      expect(syncer).toBeDefined()
    })

    it('handler returns the heaviest block if forwards direction request cannot be fulfilled', async () => {
      const request: IncomingPeerMessage<BlockRequest> = {
        peerIdentity: 'somebody',
        message: {
          type: MessageType.Blocks,
          payload: {
            hash: Buffer.from(StringUtils.hash('blockyoudonthave')).toString('hex'),
            nextBlockDirection: true,
          },
        },
      }
      const { blocks } = await syncer.handleBlockRequest(request)
      // the test blockchain comes with 9 blocks
      expect(Number(blocks[0].header.sequence)).toBe(9)
    })

    it('handler returns the requested block with hash only', async () => {
      const request: IncomingPeerMessage<BlockRequest> = {
        peerIdentity: 'somebody',
        message: {
          type: MessageType.Blocks,
          payload: {
            hash: serializedBlockHash(6),
            nextBlockDirection: false,
          },
        },
      }
      const { blocks } = await syncer.handleBlockRequest(request)
      expect(blocks.length).toBe(1)
      const block = syncer.blockSerde.deserialize(blocks[0])
      expect(block).toBeTruthy()
    })
  })

  describe('RequestOneBlock', () => {
    const strategy = new TestStrategy(new RangeHasher())
    const blockSerde = new BlockSerde(strategy)
    let onRequestBlockSpy: jest.SpyInstance
    let syncer: TestBlockSyncer
    let targetSpy: jest.SpyInstance
    let spyQueue: jest.SpyInstance

    beforeEach(async () => {
      targetSpy = jest.spyOn(Target, 'minDifficulty').mockImplementation(() => BigInt(1))
      const captain = await makeCaptainSyncable(strategy)
      syncer = new BlockSyncer(captain, createRootLogger())
      spyQueue = jest.spyOn(syncer, 'addBlockToProcess')
      onRequestBlockSpy = jest.spyOn(syncer.captain.onRequestBlocks, 'emit')
      spyQueue.mockReset()
      onRequestBlockSpy.mockReset()
    })

    afterAll(() => {
      targetSpy.mockClear()
    })

    it('successfully requests next block from genesis', async () => {
      const block = makeFakeBlock(strategy, blockHash(5), blockHash(6), 6, 6, 9)
      block.header.graphId = -1
      const serializedBlock = blockSerde.serialize(block)

      const blocksResponse: IncomingPeerMessage<
        BlocksResponse<string, SerializedTestTransaction>
      > = {
        peerIdentity: 'somebody',
        message: {
          type: MessageType.Blocks,
          direction: Direction.response,
          rpcId: 1,
          payload: { blocks: [serializedBlock] },
        },
      }
      const heaviestHead = await syncer.chain.getHeaviestHead()
      Assert.isNotNull(heaviestHead)
      syncer.requestOneBlock({ hash: heaviestHead.hash, nextBlockDirection: true })
      expect(onRequestBlockSpy).toHaveBeenCalledWith(heaviestHead.hash, true)

      const request: BlockRequest = {
        type: MessageType.Blocks,
        payload: {
          hash: heaviestHead.hash.toString('hex'),
          nextBlockDirection: true,
        },
      }

      syncer.handleBlockResponse(blocksResponse, request)
      await syncer.blockRequestPromise

      expect(spyQueue).toHaveBeenCalledWith(block, NetworkBlockType.SYNCING)
      await syncer.shutdown()
    })

    it('fails if the block cannot be deserialized', async () => {
      const blocksResponse: IncomingPeerMessage<
        BlocksResponse<string, SerializedTestTransaction>
      > = {
        peerIdentity: 'somebody',
        message: {
          type: MessageType.Blocks,
          direction: Direction.response,
          rpcId: 1,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          payload: { blocks: undefined! },
        },
      }
      const hash = Buffer.from('')
      syncer.requestOneBlock({ hash, nextBlockDirection: false })
      expect(onRequestBlockSpy).toHaveBeenCalledWith(hash, false)

      const request: BlockRequest = {
        type: MessageType.Blocks,
        payload: {
          hash: hash.toString('hex'),
          nextBlockDirection: true,
        },
      }

      syncer.handleBlockResponse(blocksResponse, request)
      await syncer.blockRequestPromise

      expect(spyQueue).toHaveBeenCalledTimes(0)
      await syncer.shutdown()
    })
  })

  describe('Requesting blocks until synced', () => {
    const strategy = new TestStrategy(new RangeHasher())
    let syncer: TestBlockSyncer
    let syncedSyncer: TestBlockSyncer
    let dbnum = 0
    let databasePrefix: string
    let syncedSyncerDBPrefix: string
    let targetSpy: jest.SpyInstance
    let captain: TestCaptain
    let fullChain: TestBlockchain
    let requestBlockSpy: jest.SpyInstance

    const createCaptain = async (synced: 'SYNCED' | 'EMPTY' | 'OUT OF SYNC') => {
      databasePrefix = `optimistic_sync_test_db_${dbnum++}`
      fullChain = await makeChain(strategy, `${databasePrefix}-fullchain`)
      if (synced === 'SYNCED') {
        captain = await makeCaptain(strategy, databasePrefix)
      } else if (synced === 'EMPTY') {
        captain = await makeCaptainSyncable(strategy, databasePrefix, false)
      } else if (synced === 'OUT OF SYNC') {
        captain = await makeCaptainSyncable(strategy, databasePrefix, true)
      }

      captain.onRequestBlocks.on(async (hash, nextBlockDirection) => {
        const message: BlockRequest = {
          type: MessageType.Blocks,
          payload: {
            hash: hash?.toString('hex'),
            nextBlockDirection: nextBlockDirection,
          },
        }

        const formattedResponse = await syncedSyncer.handleBlockRequest(
          request(message.payload),
        )
        syncer.handleBlockResponse(response(formattedResponse), message)
      })

      syncer = new BlockSyncer(captain, createRootLogger())
      jest.spyOn(syncer.chain.verifier, 'isAddBlockValid').mockResolvedValue({
        valid: Validity.Yes,
      })
      requestBlockSpy = jest.spyOn(captain, 'requestBlocks')
    }

    const areChainHeadsEqual = async (
      chainOriginal: TestBlockchain,
      chainToSync: TestBlockchain,
    ): Promise<void> => {
      const chainedHeaviestHeadHeader = await chainOriginal.getHeaviestHead()
      const syncedHeaviestHeadHeader = await chainToSync.getHeaviestHead()
      Assert.isNotNull(chainedHeaviestHeadHeader)
      Assert.isNotNull(syncedHeaviestHeadHeader)
      expect(Number(syncedHeaviestHeadHeader?.sequence)).toEqual(
        Number(chainedHeaviestHeadHeader?.sequence),
      )
    }

    beforeEach(async () => {
      targetSpy = jest.spyOn(Target, 'minDifficulty').mockImplementation(() => BigInt(1))

      syncedSyncerDBPrefix = `synced_syncer_test_db_${dbnum++}`

      syncedSyncer = new BlockSyncer(
        await makeCaptain(strategy, syncedSyncerDBPrefix),
        createRootLogger(),
      )
    })

    afterEach(async () => {
      await syncer.shutdown()
      targetSpy.mockClear()
    })

    it('makes only latest call when run on a fully synced chain', async () => {
      await createCaptain('SYNCED')

      await syncer.start()
      await syncer.shutdown()

      expect(requestBlockSpy).toBeCalledTimes(1)
    })

    it('fully syncs a chain from scratch when chain is empty', async () => {
      await createCaptain('EMPTY')

      await syncer.start()

      // 8 blocks missing in the chain
      for (let i = 0; i <= 8; i++) {
        await syncer['blockSyncPromise']
        await syncer['blockRequestPromise']
      }

      expect(requestBlockSpy).toBeCalledTimes(9)

      await syncer['blockSyncPromise']
      await areChainHeadsEqual(fullChain, captain.chain)
    })

    it('syncs missing blocks when chain is out of sync', async () => {
      await createCaptain('OUT OF SYNC')

      await syncer.start()

      // 6 blocks missing in the chain
      for (let i = 0; i <= 6; i++) {
        await syncer['blockRequestPromise']
        await syncer['blockSyncPromise']
      }

      expect(requestBlockSpy).toBeCalledTimes(7)

      await areChainHeadsEqual(fullChain, captain.chain)
    })
  })
})
