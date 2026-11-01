import { describe, expect, it } from 'vitest'

import { createTraverseDriver } from '../src/mind/drivers/traverse.ts'
import type { Job } from '../src/mind/types.ts'
import type { BlockInfo, ClientPort, Item, Vec3 } from '../src/port/index.ts'

type Placed = { at: Vec3; face: string; item: string }

function fakePort(options: { items?: Item[]; blocks?: Record<string, string>; start?: Vec3 } = {}) {
  const blocks = new Map<string, string>(Object.entries(options.blocks ?? {}))
  const placed: Placed[] = []
  const moves: Array<Vec3 & { exact?: boolean }> = []
  const pillars: Array<{ item: string; levels: number }> = []
  const self = options.start ?? { x: 0.5, y: 64, z: 0.5 }
  const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`
  const port = {
    self: () => ({ pos: { ...self }, yaw: 0, pitch: 0, health: 20, food: 20, onGround: true, inWater: false, inLava: false }),
    inventory: () => options.items ?? [],
    blockAt: (p: Vec3): BlockInfo | null => ({
      name: blocks.get(key(p)) ?? 'air',
      loaded: true,
      collision: [],
    }),
    place: async (p: Vec3, face: string, item: string) => {
      placed.push({ at: { ...p }, face, item })
      blocks.set(key(p), item)
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    moveTo: async (p: Vec3, opts?: { exact?: boolean }) => {
      moves.push({ ...p, ...(opts?.exact === undefined ? {} : { exact: opts.exact }) })
      self.x = p.x + 0.5
      self.y = p.y
      self.z = p.z + 0.5
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    pillarUp: async (item: string, levels: number) => {
      pillars.push({ item, levels })
      self.y += levels
      return { state: 'ok' as const, elapsedMs: 1, observed: { placed: levels } }
    },
  }
  return { port: port as unknown as ClientPort, placed, moves, pillars, blocks, self }
}

function job(params: Record<string, unknown>): Job {
  return {
    driverId: 'traverse',
    params: params as Job['params'],
    runId: 'run-1',
    issuedAt: 1,
    budget: { maxTicks: 600, maxWallMs: 45_000 },
  }
}

async function run(port: ClientPort, params: Record<string, unknown>) {
  const handle = createTraverseDriver().start(job(params), { port, now: () => 1 })
  for (let index = 0; index < 20; index++) {
    if (handle.result().state !== 'running') break
    await Promise.resolve()
  }
  return handle.result()
}

describe('traverse driver', () => {
  it('builds a one-wide bridge and walks onto every block', async () => {
    const { port, placed, moves } = fakePort({ items: [{ slot: 0, name: 'dirt', count: 3 }] })
    const result = await run(port, { mode: 'bridge', x: 3, y: 64, z: 0, item: 'dirt' })
    expect(result).toMatchObject({ state: 'succeeded', observed: { kind: 'traverse', mode: 'bridge', blocks: 3 } })
    expect(placed.map(entry => entry.at)).toEqual([
      { x: 1, y: 63, z: 0 }, { x: 2, y: 63, z: 0 }, { x: 3, y: 63, z: 0 },
    ])
    expect(moves.map(entry => entry)).toEqual([
      { x: 1, y: 64, z: 0, exact: true }, { x: 2, y: 64, z: 0, exact: true }, { x: 3, y: 64, z: 0, exact: true },
    ])
  })

  it('refuses to start without enough material or on an occupied cell', async () => {
    const noMaterial = fakePort({ items: [] })
    expect(await run(noMaterial.port, { mode: 'bridge', x: 3, y: 64, z: 0, item: 'dirt' }))
      .toMatchObject({ state: 'failed', code: 'NO_MATERIAL' })
    expect(noMaterial.placed).toHaveLength(0)

    const occupied = fakePort({
      items: [{ slot: 0, name: 'dirt', count: 1 }],
      blocks: { '1,64,0': 'stone' },
    })
    expect(await run(occupied.port, { mode: 'bridge', x: 1, y: 64, z: 0, item: 'dirt' }))
      .toMatchObject({ state: 'failed', code: 'TRAVERSE_STAND_OCCUPIED' })
    expect(occupied.placed).toHaveLength(1)

    const terrainSupport = fakePort({
      items: [{ slot: 0, name: 'dirt', count: 1 }],
      blocks: { '1,63,0': 'stone' },
    })
    expect(await run(terrainSupport.port, { mode: 'bridge', x: 1, y: 64, z: 0, item: 'dirt' }))
      .toMatchObject({ state: 'succeeded' })
    expect(terrainSupport.placed).toHaveLength(0)
  })

  it('pillars straight up by jumping and placing under the feet', async () => {
    const { port, placed, moves, pillars } = fakePort({ items: [{ slot: 0, name: 'dirt', count: 2 }] })
    const result = await run(port, { mode: 'scaffold', x: 0, y: 66, z: 0, item: 'dirt' })
    expect(result).toMatchObject({ state: 'succeeded', observed: { mode: 'scaffold', blocks: 2, pillar: true } })
    expect(pillars).toEqual([{ item: 'dirt', levels: 2 }])
    expect(placed).toHaveLength(0)
    expect(moves).toHaveLength(0)
  })

  it('rejects diagonal bridges and horizontal or downward scaffolds', async () => {
    const { port } = fakePort({ items: [{ slot: 0, name: 'dirt', count: 8 }] })
    expect(await run(port, { mode: 'bridge', x: 2, y: 64, z: 2, item: 'dirt' }))
      .toMatchObject({ state: 'failed', code: 'TRAVERSE_CARDINAL_ONLY' })
    expect(await run(port, { mode: 'scaffold', x: 2, y: 66, z: 0, item: 'dirt' }))
      .toMatchObject({ state: 'failed', code: 'TRAVERSE_PILLAR_VERTICAL' })
    expect(await run(port, { mode: 'scaffold', x: 0, y: 62, z: 0, item: 'dirt' }))
      .toMatchObject({ state: 'failed', code: 'TRAVERSE_DOWN_UNSUPPORTED' })
  })
})
