import { describe, expect, it } from 'vitest'

import { createTraverseDriver } from '../src/mind/drivers/traverse.ts'
import type { Job } from '../src/mind/types.ts'
import type { BodyApi, Item, Vec3 } from '../src/body/api.ts'

type Move = { target: Vec3; opts: Record<string, unknown> }

function fakePort(options: { items?: Item[]; start?: Vec3 } = {}) {
  const moves: Move[] = []
  const self = options.start ?? { x: 0.5, y: 64, z: 0.5 }
  const port = {
    self: () => ({ pos: { ...self }, yaw: 0, pitch: 0, health: 20, food: 20, onGround: true, inWater: false, inLava: false }),
    inventory: () => options.items ?? [],
    moveTo: async (target: Vec3, opts: Record<string, unknown> = {}) => {
      moves.push({ target: { ...target }, opts })
      return { state: 'ok' as const, elapsedMs: 1, observed: { plan: 'motion' } }
    },
  }
  return { port: port as unknown as BodyApi, moves }
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

async function run(port: BodyApi, params: Record<string, unknown>) {
  const handle = createTraverseDriver().start(job(params), { body: port, now: () => 1 })
  for (let index = 0; index < 20; index++) {
    if (handle.result().state !== 'running') break
    await Promise.resolve()
  }
  return handle.result()
}

describe('traverse driver', () => {
  it('delegates a one-wide bridge to motion with explicit placement authority', async () => {
    const { port, moves } = fakePort({ items: [{ slot: 0, name: 'dirt', count: 3 }] })
    const result = await run(port, { mode: 'bridge', x: 3, y: 64, z: 0, item: 'dirt' })
    expect(result).toMatchObject({ state: 'succeeded', observed: { kind: 'traverse', mode: 'bridge', blocks: 3 } })
    expect(moves).toEqual([{
      target: { x: 3, y: 64, z: 0 },
      opts: { range: 0, exact: true, timeoutMs: 60_000, allowPlace: true, material: 'dirt' },
    }])
  })

  it('requires material and keeps geometry validation', async () => {
    const noMaterial = fakePort({ items: [] })
    expect(await run(noMaterial.port, { mode: 'bridge', x: 3, y: 64, z: 0, item: 'dirt' }))
      .toMatchObject({ state: 'failed', code: 'NO_MATERIAL' })
    expect(noMaterial.moves).toHaveLength(0)

    const { port } = fakePort({ items: [{ slot: 0, name: 'dirt', count: 8 }] })
    expect(await run(port, { mode: 'bridge', x: 2, y: 64, z: 2, item: 'dirt' }))
      .toMatchObject({ state: 'failed', code: 'TRAVERSE_CARDINAL_ONLY' })
  })

  it('delegates a scaffold to motion pillar placement', async () => {
    const { port, moves } = fakePort({ items: [{ slot: 0, name: 'dirt', count: 2 }] })
    const result = await run(port, { mode: 'scaffold', x: 0, y: 66, z: 0, item: 'dirt' })
    expect(result).toMatchObject({ state: 'succeeded', observed: { mode: 'scaffold', blocks: 2, pillar: true } })
    expect(moves).toEqual([{
      target: { x: 0, y: 66, z: 0 },
      opts: {
        range: 0, exact: true, timeoutMs: 60_000, allowPlace: true, material: 'dirt',
        allowUnsupportedGoal: true,
      },
    }])
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
