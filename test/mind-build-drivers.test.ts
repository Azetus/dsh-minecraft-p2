import { describe, expect, it } from 'vitest'

import { createClearDriver } from '../src/mind/drivers/clear.ts'
import { createPlaceDriver } from '../src/mind/drivers/place.ts'
import { createStepDriver } from '../src/mind/drivers/step.ts'
import type { Job, WorldView } from '../src/mind/types.ts'
import type { ActResult, BlockInfo, ClientPort, Face, Vec3 } from '../src/port/index.ts'

/**
 * Category: cross-module contract (todo M2-03).
 * Protects: one cell per job, two stability reads, face retry, and stop.
 */

type FakeWorld = Map<string, BlockInfo>

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`

function block(name: string, p: Vec3): BlockInfo {
  return { name, loaded: true, pos: p }
}

type PortOptions = {
  failPlaceFaces?: Face[]
  placeWithoutEffect?: boolean
  deferred?: boolean
}

function fakePort(options: PortOptions = {}): {
  port: ClientPort
  world: FakeWorld
  places: Face[]
  digs: Vec3[]
  moves: Vec3[]
  reads: number
  resolveMove(): void
} {
  const world: FakeWorld = new Map()
  const places: Face[] = []
  const digs: Vec3[] = []
  const moves: Vec3[] = []
  let reads = 0
  let pendingMove: (() => void) | undefined
  const port = {
    self: () => ({
      pos: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, pitch: 0, health: 20, food: 20,
      onGround: true, inWater: false, inLava: false,
    }),
    blockAt: (p: Vec3) => {
      reads += 1
      return world.get(key(p)) ?? null
    },
    dig: async (p: Vec3): Promise<ActResult> => {
      digs.push(p)
      world.set(key(p), block('air', p))
      return { state: 'ok', elapsedMs: 1 }
    },
    place: async (p: Vec3, face: Face, item: string): Promise<ActResult> => {
      places.push(face)
      if (options.failPlaceFaces?.includes(face) === true) {
        return { state: 'failed', code: 'PLACE_UNSUPPORTED', elapsedMs: 1 }
      }
      if (options.placeWithoutEffect !== true) world.set(key(p), block(item, p))
      return { state: 'ok', elapsedMs: 1 }
    },
    moveTo: (target: Vec3): Promise<ActResult> => {
      moves.push(target)
      if (options.deferred === true) {
        return new Promise(resolve => { pendingMove = () => resolve({ state: 'ok', elapsedMs: 1 }) })
      }
      return Promise.resolve({ state: 'ok', elapsedMs: 1 })
    },
    beginWrite: () => {},
    endWrite: () => {},
  } as unknown as ClientPort
  return {
    port,
    world,
    places,
    digs,
    moves,
    get reads() { return reads },
    resolveMove: () => pendingMove?.(),
  }
}

function job(params: Record<string, unknown>): Job {
  return {
    driverId: 'test',
    target: { kind: 'point', pos: { x: 1, y: 64, z: 0 } },
    params: params as Job['params'],
    runId: 'run-1',
    issuedAt: 0,
    budget: { maxTicks: 200, maxWallMs: 15_000 },
  }
}

const world = {} as WorldView
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('place driver', () => {
  it('places one block and confirms the accepted block', async () => {
    const fake = fakePort()
    const target = { x: 1, y: 64, z: 0 }
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('air', target))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), { port: fake.port, now: () => 0 })
    await wait(30)
    expect(handle.result()).toEqual({ state: 'succeeded' })
    expect(fake.world.get('1,64,0')?.name).toBe('dirt')
    expect(fake.places.length).toBeGreaterThanOrEqual(1)
  })

  it('retries another support face after a refused placement', async () => {
    const fake = fakePort({ failPlaceFaces: ['up'] })
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('2,64,0', block('stone', { x: 2, y: 64, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), { port: fake.port, now: () => 0 })
    await wait(300)
    expect(handle.result()).toEqual({ state: 'succeeded' })
    expect(fake.places).toContain('up')
    expect(fake.places.some(face => face !== 'up')).toBe(true)
  })

  it('attempts a non-air target instead of pre-rejecting it', async () => {
    const fake = fakePort()
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('water', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), { port: fake.port, now: () => 0 })
    await wait(30)
    expect(handle.result()).toEqual({ state: 'succeeded' })
    expect(fake.places).toHaveLength(1)
    expect(fake.world.get('1,64,0')?.name).toBe('dirt')
  })

  it('fails when the accepted placement does not read back', async () => {
    const fake = fakePort({ placeWithoutEffect: true })
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), { port: fake.port, now: () => 0 })
    await wait(30)
    expect(handle.result()).toEqual({ state: 'failed', code: 'PLACE_READBACK_MISMATCH' })
  })
})

describe('clear driver', () => {
  it('digs one block and confirms air twice', async () => {
    const fake = fakePort()
    fake.world.set('1,64,0', block('stone', { x: 1, y: 64, z: 0 }))
    const handle = createClearDriver().start(job({ x: 1, y: 64, z: 0 }), { port: fake.port, now: () => 0 })
    await wait(260)
    expect(handle.result()).toEqual({ state: 'succeeded' })
    expect(fake.digs).toHaveLength(1)
    expect(fake.world.get('1,64,0')?.name).toBe('air')
  })

  it('is already satisfied for an air cell', async () => {
    const fake = fakePort()
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    const handle = createClearDriver().start(job({ x: 1, y: 64, z: 0 }), { port: fake.port, now: () => 0 })
    await wait(10)
    expect(handle.result()).toEqual({ state: 'succeeded' })
    expect(fake.digs).toHaveLength(0)
  })
})

describe('step drivers', () => {
  it('moves to the selected enter cell with its own id', async () => {
    const fake = fakePort()
    const driver = createStepDriver('enter')
    const handle = driver.start(job({ x: 1, y: 64, z: 0, range: 1 }), { port: fake.port, now: () => 0 })
    await wait(10)
    expect(driver.id).toBe('enter')
    expect(fake.moves).toEqual([{ x: 1, y: 64, z: 0 }])
    expect(handle.result()).toEqual({ state: 'succeeded' })
  })

  it('reports interrupted when stopped before the move settles', async () => {
    const fake = fakePort({ deferred: true })
    const handle = createStepDriver('prepare').start(job({ x: 1, y: 64, z: 0, range: 1 }), { port: fake.port, now: () => 0 })
    handle.requestStop()
    expect(handle.stopStatus()).toBe('stopping')
    fake.resolveMove()
    await wait(10)
    expect(handle.result()).toEqual({ state: 'interrupted' })
    expect(handle.stopStatus()).toBe('stopped')
  })
})
