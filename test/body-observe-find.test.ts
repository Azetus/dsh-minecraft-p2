import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import type { BodyInfo, RequestEnvelope, WorldObserveResult } from '../src/contracts/index.ts'
import type { BlockInfo, ClientPort, FindBlocksQuery, SelfInfo } from '../src/port/index.ts'

/**
 * Category: cross-module contract (Phase B nearest-block observation).
 * Protects: find filters unloaded cells and `only`, sorts by distance, keeps
 * total before the limit, caps radius/limit, and never writes.
 */

const body: BodyInfo = {
  manifest: {
    schemaVersion: 1,
    bodyVersion: '0.1.0',
    protocolVersion: 1,
    entry: 'body.mjs',
    files: { 'body.mjs': 'a'.repeat(64) },
  },
  manifestDigest: 'b'.repeat(64),
  bindingId: null,
  capabilities: [],
  provider: null,
}

const self: SelfInfo = {
  pos: { x: 0.5, y: 64, z: 0.5 },
  yaw: 0,
  pitch: 0,
  health: 20,
  food: 20,
  onGround: true,
  inWater: false,
  inLava: false,
}

type RawBlock = {
  name: string
  loaded: boolean
  light?: number
  skyLight?: number
  pos: { x: number; y: number; z: number }
}

type FakeFindPort = {
  port: ClientPort
  writes: number
  queries: FindBlocksQuery[]
}

function fakePort(blocks: RawBlock[] = []): FakeFindPort {
  let writes = 0
  const queries: FindBlocksQuery[] = []
  const port = {
    self: () => self,
    time: () => ({ timeOfDay: 1000, worldAge: 100 }),
    biomeAt: () => ({ id: 39, name: 'plains' }),
    findBlocks: (query: FindBlocksQuery): BlockInfo[] => {
      queries.push(query)
      // Deliberately ignore the name filter so the body-side filter is tested.
      return blocks.map(block => ({
        name: block.name,
        loaded: block.loaded,
        ...(block.light === undefined ? {} : { light: block.light }),
        ...(block.skyLight === undefined ? {} : { skyLight: block.skyLight }),
        pos: block.pos,
      }))
    },
    blockAt: (): BlockInfo | null => null,
    blocksIn: (): BlockInfo[] => [],
    entities: () => [],
    inventory: () => [{ slot: 0, name: 'dirt', count: 2 }],
    beginWrite: () => { writes += 1 },
    endWrite: () => {},
  } as unknown as ClientPort
  return { port, get writes() { return writes }, queries }
}

function runtimeWith(port: ClientPort | undefined): BodyRuntime {
  return new BodyRuntime({
    body,
    owner: { sessionId: 's1', agentId: 'a1', cwd: 'C:/p2' },
    now: () => 1234,
    ...(port === undefined ? {} : { port }),
  })
}

function request(params: Record<string, unknown>): RequestEnvelope {
  return { protocol: 1, requestId: 'r1', method: 'world.observe', params: params as never }
}

describe('world.observe find', () => {
  it('returns the nearest loaded matches and filters unloaded/unrequested cells', async () => {
    const fake = fakePort([
      { name: 'crafting_table', loaded: true, pos: { x: 5, y: 64, z: 0 } },
      { name: 'crafting_table', loaded: false, pos: { x: 1, y: 64, z: 0 } },
      { name: 'stone', loaded: true, pos: { x: 0, y: 64, z: 0 } },
      { name: 'crafting_table', loaded: true, pos: { x: 2, y: 64, z: 0 } },
    ])
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      mode: 'find',
      near: { x: 0, y: 64, z: 0 },
      radius: 8,
      only: ['crafting_table'],
      limit: 5,
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(response.error).toBeUndefined()
    expect(result.mode).toBe('find')
    expect(result.detail).toBe('find')
    expect(result.near).toEqual({ x: 0, y: 64, z: 0 })
    expect(result.radius).toBe(8)
    expect(result.only).toEqual(['crafting_table'])
    expect(result.total).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.blocks).toEqual([
      { cell: { x: 2, y: 64, z: 0 }, name: 'crafting_table', distance: 2 },
      { cell: { x: 5, y: 64, z: 0 }, name: 'crafting_table', distance: 5 },
    ])
    expect(fake.queries).toEqual([{
      near: { x: 0, y: 64, z: 0 },
      radius: 8,
      names: ['crafting_table'],
      count: 257,
    }])
    expect(fake.writes).toBe(0)
  })

  it('returns raw light for find matches when the adapter provides it', async () => {
    const fake = fakePort([
      { name: 'torch', loaded: true, pos: { x: 1, y: 64, z: 0 }, light: 14, skyLight: 0 },
    ])
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      mode: 'find',
      near: { x: 0, y: 64, z: 0 },
      radius: 8,
      only: ['torch'],
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(result.blocks).toMatchObject([
      { cell: { x: 1, y: 64, z: 0 }, name: 'torch', light: 14, skyLight: 0 },
    ])
  })

  it('sorts by distance and applies limit after total', async () => {
    const blocks: RawBlock[] = []
    for (let x = 1; x <= 12; x += 1) {
      blocks.push({ name: 'crafting_table', loaded: true, pos: { x, y: 64, z: 0 } })
    }
    const fake = fakePort(blocks)
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      mode: 'find',
      near: { x: 0, y: 64, z: 0 },
      radius: 16,
      only: ['crafting_table'],
      limit: 3,
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(result.total).toBe(12)
    expect(result.blocks).toEqual([
      { cell: { x: 1, y: 64, z: 0 }, name: 'crafting_table', distance: 1 },
      { cell: { x: 2, y: 64, z: 0 }, name: 'crafting_table', distance: 2 },
      { cell: { x: 3, y: 64, z: 0 }, name: 'crafting_table', distance: 3 },
    ])
  })

  it('caps total and marks a truncated result', async () => {
    const blocks: RawBlock[] = []
    for (let x = 0; x < 32; x += 1) {
      for (let z = 0; z < 8; z += 1) {
        blocks.push({ name: 'crafting_table', loaded: true, pos: { x, y: 64, z } })
      }
    }
    blocks.push({ name: 'crafting_table', loaded: true, pos: { x: 0, y: 64, z: 0 } })
    const fake = fakePort(blocks)
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      mode: 'find',
      near: { x: 0, y: 64, z: 0 },
      radius: 32,
      only: ['crafting_table'],
      limit: 5,
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(result.total).toBe(256)
    expect(result.truncated).toBe(true)
    expect(result.blocks).toHaveLength(5)
  })

  it('returns an empty result without inventing matches', async () => {
    const fake = fakePort([])
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      mode: 'find',
      near: { x: 0, y: 64, z: 0 },
      only: ['crafting_table'],
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(result.total).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.blocks).toEqual([])
  })

  it('defaults near to the body cell, radius to 16 and limit to 5', async () => {
    const fake = fakePort([])
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      mode: 'find',
      only: ['crafting_table'],
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(result.near).toEqual({ x: 0, y: 64, z: 0 })
    expect(result.radius).toBe(16)
    expect(fake.queries[0]).toMatchObject({ radius: 16, count: 257 })
  })

  it('rejects radius and limit outside their caps', async () => {
    const fake = fakePort()
    const radius = await runtimeWith(fake.port).handleRequestAsync(request({
      mode: 'find',
      only: ['stone'],
      radius: 33,
    }))
    expect(radius.error?.code).toBe('INVALID_MESSAGE')
    expect(radius.error?.details).toMatchObject({ maxRadius: 32 })

    const limit = await runtimeWith(fake.port).handleRequestAsync(request({
      mode: 'find',
      only: ['stone'],
      limit: 11,
    }))
    expect(limit.error?.code).toBe('INVALID_MESSAGE')
    expect(limit.error?.details).toMatchObject({ maxLimit: 10 })

    for (const bad of [0, 1.5, '16']) {
      const response = await runtimeWith(fake.port).handleRequestAsync(request({
        mode: 'find',
        only: ['stone'],
        radius: bad,
      }))
      expect(response.error?.code).toBe('INVALID_MESSAGE')
    }
    for (const bad of [0, 1.5, '5']) {
      const response = await runtimeWith(fake.port).handleRequestAsync(request({
        mode: 'find',
        only: ['stone'],
        limit: bad,
      }))
      expect(response.error?.code).toBe('INVALID_MESSAGE')
    }
  })

  it('rejects a missing/empty/invalid only list', async () => {
    const fake = fakePort()
    for (const only of [undefined, [], ['ok', 3], ['']]) {
      const response = await runtimeWith(fake.port).handleRequestAsync(request({
        mode: 'find',
        ...(only === undefined ? {} : { only }),
      }))
      expect(response.error?.code).toBe('INVALID_MESSAGE')
    }
    const tooMany = Array.from({ length: 33 }, (_, index) => `block_${index}`)
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      mode: 'find',
      only: tooMany,
    }))
    expect(response.error?.details).toMatchObject({ maxNames: 32 })
  })

  it('rejects find mixed with box/points fields and mismatched modes', async () => {
    const fake = fakePort()
    const cases: Array<Record<string, unknown>> = [
      { mode: 'find', only: ['stone'], min: { x: 0, y: 0, z: 0 } },
      { mode: 'find', only: ['stone'], points: [{ x: 0, y: 64, z: 0 }] },
      { mode: 'find', only: ['stone'], detail: 'blocks' },
      { mode: 'box', points: [{ x: 0, y: 64, z: 0 }] },
      { mode: 'box', near: { x: 0, y: 64, z: 0 } },
      { mode: 'points', near: { x: 0, y: 64, z: 0 } },
      { mode: 'points' },
      { mode: 'nope', only: ['stone'] },
      { mode: 'find', only: ['stone'], near: 'origin' },
    ]
    for (const params of cases) {
      const response = await runtimeWith(fake.port).handleRequestAsync(request(params))
      expect(response.error?.code).toBe('INVALID_MESSAGE')
    }
  })

  it('reports no provider for find', async () => {
    const response = await runtimeWith(undefined).handleRequestAsync(request({
      mode: 'find',
      only: ['stone'],
    }))
    expect(response.error?.code).toBe('NOT_INITIALIZED')
  })
})
