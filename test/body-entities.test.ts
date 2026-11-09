import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import type { BodyInfo, RequestEnvelope, WorldEntitiesResult } from '../src/contracts/index.ts'
import type { BodyApi, EntityInfo, SelfInfo } from '../src/body/api.ts'

/**
 * Category: cross-module contract (M3-01 entity observation).
 * Protects: entity-only queries need no movement or block budget, resolve
 * dropped-item stacks, sort by distance, and never invent entities.
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

const entities: EntityInfo[] = [
  { id: '1', name: 'sheep', type: 'animal', kind: 'Passive mobs', position: { x: 1, y: 64, z: 0 } },
  {
    id: '2',
    name: 'item',
    type: 'other',
    position: { x: 0, y: 64, z: 4 },
    item: { name: 'egg', count: 3 },
  },
  { id: '3', name: 'Human', type: 'player', username: 'Human', position: { x: 20, y: 64, z: 0 } },
  { id: '4', name: 'zombie', type: 'hostile', position: { x: 10, y: 64, z: 0 } },
  { id: '5', name: 'cow', type: 'animal', position: { x: 200, y: 64, z: 0 } },
]

function fakePort(): { port: BodyApi; writes: number } {
  let writes = 0
  const port = {
    self: () => self,
    time: () => ({ timeOfDay: 1000, worldAge: 1 }),
    biomeAt: () => ({ id: 39, name: 'plains' }),
    entities: (box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) =>
      entities.filter(entity => entity.position.x >= box.min.x && entity.position.x <= box.max.x
        && entity.position.y >= box.min.y && entity.position.y <= box.max.y
        && entity.position.z >= box.min.z && entity.position.z <= box.max.z),
    beginWrite: () => { writes += 1 },
    endWrite: () => {},
  } as unknown as BodyApi
  return { port, get writes() { return writes } }
}

function runtimeWith(port: BodyApi | undefined): BodyRuntime {
  return new BodyRuntime({
    body,
    owner: { sessionId: 's1', agentId: 'a1', cwd: 'C:/p2' },
    now: () => 1234,
    ...(port === undefined ? {} : { game: port }),
  })
}

function request(params: Record<string, unknown>): RequestEnvelope {
  return { protocol: 1, requestId: 'r1', method: 'world.entities', params: params as never }
}

describe('world.entities', () => {
  it('returns nearby entities sorted by distance, with dropped-item stacks', async () => {
    const fake = fakePort()
    const response = await runtimeWith(fake.port).handleRequestAsync(request({}))
    const result = response.result as unknown as WorldEntitiesResult
    expect(result.total).toBe(4)
    expect(result.entities.map(entity => entity.name)).toEqual(['sheep', 'item', 'zombie', 'Human'])
    expect(result.entities[1]).toMatchObject({
      name: 'item',
      item: { name: 'egg', count: 3 },
      distance: 4,
    })
    expect(result.entities[3]).toMatchObject({ username: 'Human', type: 'player', distance: 20 })
    expect(fake.writes).toBe(0)
  })

  it('filters by name/type and applies the limit after total', async () => {
    const fake = fakePort()
    const items = await runtimeWith(fake.port).handleRequestAsync(request({ names: ['item'] }))
    const itemResult = items.result as unknown as WorldEntitiesResult
    expect(itemResult.total).toBe(1)
    expect(itemResult.entities[0]?.item).toEqual({ name: 'egg', count: 3 })

    const hostile = await runtimeWith(fake.port).handleRequestAsync(request({ types: ['hostile'] }))
    const hostileResult = hostile.result as unknown as WorldEntitiesResult
    expect(hostileResult.entities.map(entity => entity.name)).toEqual(['zombie'])

    const limited = await runtimeWith(fake.port).handleRequestAsync(request({ limit: 2 }))
    const limitedResult = limited.result as unknown as WorldEntitiesResult
    expect(limitedResult.total).toBe(4)
    expect(limitedResult.entities).toHaveLength(2)
  })

  it('rejects an oversized radius/limit and reports a missing provider', async () => {
    const fake = fakePort()
    const tooWide = await runtimeWith(fake.port).handleRequestAsync(request({ radius: 200 }))
    expect(tooWide.error?.code).toBe('INVALID_MESSAGE')

    const noPort = await runtimeWith(undefined).handleRequestAsync(request({}))
    expect(noPort.error?.code).toBe('NOT_INITIALIZED')
  })
})
