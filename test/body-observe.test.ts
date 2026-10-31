import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import type { BodyInfo, RequestEnvelope, WorldObserveResult } from '../src/contracts/index.ts'
import type { BlockInfo, ClientPort, SelfInfo } from '../src/port/index.ts'

/**
 * Category: cross-module contract (M3-01 observation).
 * Protects: box/points queries, compact summaries, filters, caps, and the
 * rule that an unloaded cell is never folded into air.
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

type RawBlock = { name: string; loaded: boolean; pos: { x: number; y: number; z: number } }

const defaultBlocks: RawBlock[] = [
  { name: 'stone', loaded: true, pos: { x: 0, y: 64, z: 0 } },
  { name: '', loaded: false, pos: { x: 1, y: 64, z: 0 } },
]

function fakePort(blocks: RawBlock[] = defaultBlocks): { port: ClientPort; writes: number } {
  let writes = 0
  const port = {
    self: () => self,
    time: () => ({ timeOfDay: 1000, worldAge: 100 }),
    blocksIn: () => blocks,
    blockAt: (p: { x: number; y: number; z: number }): BlockInfo | null => {
      const found = blocks.find(block => block.pos.x === p.x && block.pos.y === p.y && block.pos.z === p.z)
      return found === undefined ? null : { name: found.name, loaded: found.loaded, pos: found.pos }
    },
    entities: () => [{ id: 'e1', name: 'zombie', position: { x: 0, y: 64, z: 0 } }],
    inventory: () => [{ slot: 0, name: 'dirt', count: 2 }],
    beginWrite: () => { writes += 1 },
    endWrite: () => {},
  } as unknown as ClientPort
  return { port, get writes() { return writes } }
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

describe('world.observe', () => {
  it('returns blocks, self, inventory, time and entities without writing', async () => {
    const fake = fakePort()
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      min: { x: 0, y: 64, z: 0 },
      max: { x: 1, y: 64, z: 0 },
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(response.error).toBeUndefined()
    expect(result.at).toBe(1234)
    expect(result.self.pos).toEqual(self.pos)
    expect(result.inventory).toEqual([{ slot: 0, name: 'dirt', count: 2 }])
    expect(result.blocks).toEqual([
      { x: 0, y: 64, z: 0, name: 'stone', loaded: true },
      { x: 1, y: 64, z: 0, name: '', loaded: false },
    ])
    expect(result.entities).toEqual([{ id: 'e1', name: 'zombie', position: { x: 0, y: 64, z: 0 } }])
    expect(fake.writes).toBe(0)
  })

  it('omits entities when asked', async () => {
    const fake = fakePort()
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      min: { x: 0, y: 64, z: 0 },
      max: { x: 0, y: 64, z: 0 },
      includeEntities: false,
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(result.entities).toBeUndefined()
  })

  it('answers a targeted points query without entities', async () => {
    const fake = fakePort([
      { name: 'stone', loaded: true, pos: { x: 0, y: 64, z: 0 } },
      { name: 'air', loaded: true, pos: { x: 1, y: 64, z: 0 } },
    ])
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      points: [
        { x: 0, y: 64, z: 0 },
        { x: 0, y: 64, z: 0 },
        { x: 1, y: 64, z: 0 },
        { x: 2, y: 64, z: 0 },
      ],
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(result.mode).toBe('points')
    expect(result.detail).toBe('points')
    expect(result.blocks).toEqual([
      { x: 0, y: 64, z: 0, name: 'stone', loaded: true },
      { x: 1, y: 64, z: 0, name: 'air', loaded: true },
      { x: 2, y: 64, z: 0, name: '', loaded: false },
    ])
    expect(result.entities).toBeUndefined()
  })

  it('summarizes counts without listing every block', async () => {
    const fake = fakePort([
      { name: 'stone', loaded: true, pos: { x: 0, y: 64, z: 0 } },
      { name: 'air', loaded: true, pos: { x: 1, y: 64, z: 0 } },
      { name: '', loaded: false, pos: { x: 2, y: 64, z: 0 } },
    ])
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      min: { x: 0, y: 64, z: 0 },
      max: { x: 2, y: 64, z: 0 },
      detail: 'counts',
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(result.blocks).toBeUndefined()
    expect(result.counts).toEqual({
      total: 3,
      loaded: 2,
      unloaded: 1,
      byName: { stone: 1, air: 1 },
    })
  })

  it('summarizes one surface per column and marks an unknown column', async () => {
    const blocks: RawBlock[] = [
      { name: 'air', loaded: true, pos: { x: 0, y: 64, z: 0 } },
      { name: 'dirt', loaded: true, pos: { x: 0, y: 65, z: 0 } },
      { name: 'stone', loaded: true, pos: { x: 1, y: 64, z: 0 } },
      { name: 'air', loaded: true, pos: { x: 1, y: 65, z: 0 } },
      { name: '', loaded: false, pos: { x: 0, y: 64, z: 1 } },
      { name: 'air', loaded: true, pos: { x: 0, y: 65, z: 1 } },
      { name: 'air', loaded: true, pos: { x: 1, y: 64, z: 1 } },
      { name: 'air', loaded: true, pos: { x: 1, y: 65, z: 1 } },
    ]
    const fake = fakePort(blocks)
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      min: { x: 0, y: 64, z: 0 },
      max: { x: 1, y: 65, z: 1 },
      detail: 'surface',
    }))
    const result = response.result as unknown as WorldObserveResult
    const surface = result.surface ?? []
    expect(surface).toHaveLength(4)
    expect(surface.find(entry => entry.x === 0 && entry.z === 0)).toMatchObject({ y: 65, name: 'dirt', loaded: true })
    expect(surface.find(entry => entry.x === 1 && entry.z === 0)).toMatchObject({ y: 64, name: 'stone', loaded: true })
    expect(surface.find(entry => entry.x === 0 && entry.z === 1)).toMatchObject({ y: null, name: null, loaded: false })
    expect(surface.find(entry => entry.x === 1 && entry.z === 1)).toMatchObject({ y: null, name: null, loaded: true })
  })

  it('filters the blocks view by name and air', async () => {
    const fake = fakePort([
      { name: 'stone', loaded: true, pos: { x: 0, y: 64, z: 0 } },
      { name: 'air', loaded: true, pos: { x: 1, y: 64, z: 0 } },
      { name: '', loaded: false, pos: { x: 2, y: 64, z: 0 } },
    ])
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      min: { x: 0, y: 64, z: 0 },
      max: { x: 2, y: 64, z: 0 },
      only: ['stone'],
      excludeAir: true,
    }))
    const result = response.result as unknown as WorldObserveResult
    expect(result.blocks?.map(block => block.name)).toEqual(['stone', ''])
  })

  it('rejects a points query mixed with a box or a summary detail', async () => {
    const fake = fakePort()
    const mixed = await runtimeWith(fake.port).handleRequestAsync(request({
      points: [{ x: 0, y: 64, z: 0 }],
      min: { x: 0, y: 64, z: 0 },
      max: { x: 0, y: 64, z: 0 },
    }))
    expect(mixed.error?.code).toBe('INVALID_MESSAGE')

    const summary = await runtimeWith(fake.port).handleRequestAsync(request({
      points: [{ x: 0, y: 64, z: 0 }],
      detail: 'counts',
    }))
    expect(summary.error?.code).toBe('INVALID_MESSAGE')
  })

  it('rejects a box over the volume cap', async () => {
    const fake = fakePort()
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 63, y: 63, z: 1 },
    }))
    expect(response.error?.code).toBe('INVALID_MESSAGE')
    expect(response.error?.details).toMatchObject({ maxBlocks: 4096 })
  })

  it('rejects an axis over the cap and an inverted box', async () => {
    const fake = fakePort()
    const tooLong = await runtimeWith(fake.port).handleRequestAsync(request({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 65, y: 0, z: 0 },
    }))
    expect(tooLong.error?.code).toBe('INVALID_MESSAGE')

    const inverted = await runtimeWith(fake.port).handleRequestAsync(request({
      min: { x: 2, y: 0, z: 0 },
      max: { x: 1, y: 0, z: 0 },
    }))
    expect(inverted.error?.code).toBe('INVALID_MESSAGE')
  })

  it('reports no provider instead of pretending the world is empty', async () => {
    const response = await runtimeWith(undefined).handleRequestAsync(request({
      min: { x: 0, y: 64, z: 0 },
      max: { x: 0, y: 64, z: 0 },
    }))
    expect(response.error?.code).toBe('NOT_INITIALIZED')
  })
})
