/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

jest.mock('ws')
jest.mock('../network')

import { RangeHasher } from './anchorChain/merkleTree'
import {
  TestStrategy,
  makeCaptain,
  TestCaptain,
  makeFakeBlock,
  blockHash,
  TestBlockHeader,
  fakeMaxTarget,
} from './testUtilities'

import Target from './anchorChain/blockchain/Target'
import { Validity, VerificationResultReason } from './anchorChain/blockchain/VerificationResult'
import { BlockHeader } from './anchorChain/blockchain'

describe('Verifier', () => {
  describe('Transactions', () => {
    const strategy = new TestStrategy(new RangeHasher())
    let captain: TestCaptain

    beforeEach(async () => {
      captain = await makeCaptain(strategy)
    })

    it('constructs a verifier', () => {
      expect(captain.chain.verifier).toBeDefined()
    })

    it('extracts a valid transaction', async () => {
      const newTransactionPayload = {
        transaction: { elements: ['a'], spends: [], totalFees: 5, isValid: true },
      }

      const result = await captain.chain.verifier.verifyNewTransaction(newTransactionPayload)

      const { transaction, serializedTransaction } = result

      expect(transaction).toMatchObject({
        _spends: [],
        elements: ['a'],
        isValid: true,
        totalFees: BigInt(5),
      })

      expect(serializedTransaction).toMatchObject({
        spends: [],
        elements: ['a'],
        isValid: true,
        totalFees: 5,
      })
    })

    it('rejects if payload is not a serialized transaction', async () => {
      await expect(
        captain.chain.verifier.verifyNewTransaction({ notA: 'Transaction' }),
      ).rejects.toEqual('Payload is not a serialized transaction')
    })

    it('rejects if the transaction cannot be deserialized', async () => {
      await expect(
        captain.chain.verifier.verifyNewTransaction({ transaction: { not: 'valid' } }),
      ).rejects.toEqual('Could not deserialize transaction')
    })

    it('rejects if the transaction is not valid', async () => {
      const newTransactionPayload = {
        transaction: { elements: ['a'], spends: [], totalFees: 5, isValid: false },
      }
      await expect(
        captain.chain.verifier.verifyNewTransaction(newTransactionPayload),
      ).rejects.toEqual('Transaction is invalid')
    })
  })

  describe('Block', () => {
    const strategy = new TestStrategy(new RangeHasher())
    let captain: TestCaptain
    let targetSpy: jest.SpyInstance

    beforeEach(async () => {
      targetSpy = jest.spyOn(Target, 'minDifficulty').mockImplementation(() => BigInt(1))
      captain = await makeCaptain(strategy)
    })

    afterAll(() => {
      targetSpy.mockClear()
    })

    it('extracts a valid block', async () => {
      const block = makeFakeBlock(strategy, blockHash(1), blockHash(2), 2, 5, 6)
      const serializedBlock = captain.chain.verifier.blockSerde.serialize(block)

      const {
        block: newBlock,
        serializedBlock: newSerializedBlock,
      } = await captain.chain.verifier.verifyNewBlock({ block: serializedBlock })

      expect(newBlock.header.hash.equals(block.header.hash)).toBe(true)
      expect(newSerializedBlock.header.previousBlockHash).toEqual(
        serializedBlock.header.previousBlockHash,
      )
    })

    it('rejects if payload is not a serialized block', async () => {
      await expect(captain.chain.verifier.verifyNewBlock({ notA: 'Block' })).rejects.toEqual(
        'Payload is not a serialized block',
      )
    })

    it('rejects if the block cannot be deserialized', async () => {
      await expect(
        captain.chain.verifier.verifyNewBlock({ block: { not: 'valid' } }),
      ).rejects.toEqual('Could not deserialize block')
    })

    it('rejects if the block is not valid', async () => {
      const block = makeFakeBlock(strategy, blockHash(1), blockHash(2), 2, 5, 6)
      block.transactions[0].isValid = false
      const serializedBlock = captain.chain.verifier.blockSerde.serialize(block)
      const newBlockPayload = { block: serializedBlock }

      await expect(captain.chain.verifier.verifyNewBlock(newBlockPayload)).rejects.toEqual(
        'Block is invalid',
      )
    })

    it('validates a valid block', () => {
      const block = makeFakeBlock(strategy, blockHash(4), blockHash(5), 5, 5, 9)
      expect(captain.chain.verifier.verifyBlock(block).valid).toBe(Validity.Yes)
    })

    it("doesn't validate a block with an invalid header", () => {
      const block = makeFakeBlock(strategy, blockHash(4), blockHash(5), 5, 5, 9)
      block.header.target = new Target(0)

      expect(captain.chain.verifier.verifyBlock(block)).toMatchObject({
        reason: VerificationResultReason.HASH_NOT_MEET_TARGET,
        valid: 0,
      })
    })

    it("doesn't validate a block with an invalid transaction", () => {
      const block = makeFakeBlock(strategy, blockHash(4), blockHash(5), 5, 5, 9)
      block.transactions[1].isValid = false

      expect(captain.chain.verifier.verifyBlock(block)).toMatchObject({
        reason: VerificationResultReason.INVALID_TRANSACTION_PROOF,
        valid: 0,
      })
    })

    it("doesn't validate a block with incorrect transaction fee", () => {
      const block = makeFakeBlock(strategy, blockHash(4), blockHash(5), 5, 5, 9)
      block.header.minersFee = BigInt(-1)

      expect(captain.chain.verifier.verifyBlock(block)).toMatchObject({
        reason: VerificationResultReason.INVALID_MINERS_FEE,
        valid: 0,
      })
    })
  })

  describe('BlockHeader', () => {
    const strategy = new TestStrategy(new RangeHasher())
    let dateSpy: jest.SpyInstance<number, []>
    let captain: TestCaptain
    let header: TestBlockHeader

    beforeAll(() => {
      dateSpy = jest.spyOn(global.Date, 'now').mockImplementation(() => 1598467858637)
    })

    beforeEach(async () => {
      dateSpy.mockClear()
      captain = await makeCaptain(strategy)

      header = new BlockHeader(
        strategy,
        BigInt(5),
        Buffer.alloc(32),
        { commitment: 'header', size: 8 },
        { commitment: Buffer.alloc(32), size: 3 },
        fakeMaxTarget(),
        25,
        new Date(1598467858637),
        BigInt(0),
        Buffer.alloc(32),
      )
    })

    it('validates a valid transaction', () => {
      expect(captain.chain.verifier.verifyBlockHeader(header).valid).toBe(Validity.Yes)
    })

    it('fails validation when target is invalid', () => {
      header.target = new Target(BigInt(0))

      expect(captain.chain.verifier.verifyBlockHeader(header)).toMatchObject({
        reason: VerificationResultReason.HASH_NOT_MEET_TARGET,
        valid: 0,
      })
    })

    it('fails validation when timestamp is in future', () => {
      header.timestamp = new Date(1598467898637)

      expect(captain.chain.verifier.verifyBlockHeader(header)).toMatchObject({
        reason: VerificationResultReason.TOO_FAR_IN_FUTURE,
        valid: 0,
      })
    })

    it('fails validation if graffiti field is not equal to 32 bytes', () => {
      header.graffiti = Buffer.alloc(31)
      header.graffiti.write('test')

      expect(captain.chain.verifier.verifyBlockHeader(header)).toMatchObject({
        reason: VerificationResultReason.GRAFFITI,
        valid: 0,
      })

      header.graffiti = Buffer.alloc(33)
      header.graffiti.write('test2')

      expect(captain.chain.verifier.verifyBlockHeader(header)).toMatchObject({
        reason: VerificationResultReason.GRAFFITI,
        valid: 0,
      })
    })
  })
})
