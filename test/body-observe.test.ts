import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import type { BodyInfo, RequestEnvelope, WorldObserveResult } from '../src/contracts/index.ts'
import type { ClientPort, SelfInfo } from '../src/port/index.ts'

/**
 * Category: cross-module contract (M3-01 observation).
 * Protects: observation is bounded, read-only, and keeps unloaded cells
 * visible instead of folding them into air.
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

function fakePort(): { port: ClientPort; writes: number } {
  let writes = 0
  const port = {
    self: () => self,
    time: () => ({ timeOfDay: 1000, worldAge: 100 }),
    blocksIn: () => [
      { name: 'stone', loaded: true, pos: { x: 0, y: 64, z: 0 } },
      { name: '', loaded: false, pos: { x: 1, y: 64, z: 0 } },
    ],
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
