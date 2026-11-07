import { describe, expect, it } from 'vitest'

import { createClearDriver } from '../src/mind/drivers/clear.ts'
import { createPlaceDriver } from '../src/mind/drivers/place.ts'
import { createStepDriver } from '../src/mind/drivers/step.ts'
import type { JsonValue } from '../src/contracts/types.ts'
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
  failPlaceCode?: string
  placeFailureObserved?: JsonValue
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
        return {
          state: 'failed',
          code: options.failPlaceCode ?? 'PLACE_UNSUPPORTED',
          elapsedMs: 1,
          ...(options.placeFailureObserved === undefined ? {} : { observed: options.placeFailureObserved }),
        }
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
    inventory: () => [],
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
    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { placedAt: { x: 1, y: 64, z: 0 }, alreadyPlaced: false } })
    expect(fake.world.get('1,64,0')?.name).toBe('dirt')
    expect(fake.places.length).toBeGreaterThanOrEqual(1)
  })

  it('retries another support face only when the provider proves retrySafe', async () => {
    const fake = fakePort({
      failPlaceFaces: ['up'],
      placeFailureObserved: { retrySafe: true, itemConsumed: false },
    })
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('2,64,0', block('stone', { x: 2, y: 64, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), { port: fake.port, now: () => 0 })
    await wait(300)
    expect(handle.result()).toMatchObject({ state: 'succeeded' })
    expect(fake.places).toContain('up')
    expect(fake.places.some(face => face !== 'up')).toBe(true)
  })

  it('does not try another face after an item-consuming failure', async () => {
    const fake = fakePort({
      failPlaceFaces: ['up', 'down', 'north', 'south', 'east', 'west'],
      failPlaceCode: 'PLACE_ITEM_CONSUMED',
      placeFailureObserved: {
        face: 'up',
        placedAt: { x: 1, y: 63, z: 0 },
        itemConsumed: true,
        retrySafe: false,
      },
    })
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), { port: fake.port, now: () => 0 })
    await wait(30)

    expect(handle.result()).toMatchObject({
      state: 'failed',
      code: 'PLACE_ITEM_CONSUMED',
      observed: { placedAt: { x: 1, y: 63, z: 0 }, itemConsumed: true, retrySafe: false },
    })
    expect(fake.places).toEqual(['up'])
  })

  it('reports six-face supports and bounded candidate cells for PLACE_UNSUPPORTED', async () => {
    const fake = fakePort({ failPlaceFaces: ['up'] })
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    for (const candidate of [
      { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 },
      { x: 1, y: 64, z: 1 }, { x: 1, y: 64, z: -1 },
    ]) {
      fake.world.set(`${candidate.x},${candidate.y - 1},${candidate.z}`, block('stone', {
        x: candidate.x, y: candidate.y - 1, z: candidate.z,
      }))
      fake.world.set(`${candidate.x},${candidate.y},${candidate.z}`, block('air', candidate))
    }
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), {
      port: fake.port,
      now: () => 0,
    })
    await wait(30)

    const result = handle.result()
    expect(result).toMatchObject({ state: 'failed', code: 'PLACE_UNSUPPORTED' })
    const failure = (result.observed as { failure?: Record<string, unknown> }).failure
    const facts = failure?.facts as {
      supports?: Record<string, boolean>
      suggestedCells?: Array<{ cell: number[]; support: string }>
      snapshot?: { target?: { support?: { name?: string } } }
    }
    expect(facts.supports).toEqual({
      up: true, down: false, north: false, south: false, east: false, west: false,
    })
    expect(facts.suggestedCells).toHaveLength(3)
    expect(facts.suggestedCells?.every(candidate => candidate.support === 'up')).toBe(true)
    expect(facts.snapshot?.target?.support?.name).toBe('stone')
  })

  it('keeps face, provider and stand-cell evidence on PLACE_FAILED', async () => {
    const fake = fakePort({
      failPlaceFaces: ['up'],
      failPlaceCode: 'PLACE_FAILED',
      placeFailureObserved: {
        face: 'up',
        providerCode: 'PLACE_FAILED',
        providerMessage: 'server did not place dirt at 1,64,0',
        supports: { up: true, down: false, north: false, south: false, east: false, west: false },
        requestedFace: 'up',
      },
    })
    for (let x = -2; x <= 3; x += 1) {
      for (let z = -1; z <= 1; z += 1) {
        fake.world.set(`${x},63,${z}`, block('stone', { x, y: 63, z }))
        fake.world.set(`${x},64,${z}`, block('air', { x, y: 64, z }))
        fake.world.set(`${x},65,${z}`, block('air', { x, y: 65, z }))
      }
    }
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), {
      port: fake.port,
      now: () => 0,
    })
    await wait(30)

    const result = handle.result()
    expect(result).toMatchObject({ state: 'failed', code: 'PLACE_FAILED' })
    const failure = (result.observed as {
      failure?: {
        layer?: string
        code?: string
        diagnosis?: string
        cause?: { kind?: string }
        facts?: Record<string, unknown>
      }
    }).failure
    expect(failure).toMatchObject({
      layer: 'driver',
      code: 'PLACE_FAILED',
      diagnosis: 'UNKNOWN',
      cause: { kind: 'world' },
      facts: {
        target: { x: 1, y: 64, z: 0 },
        face: 'up',
        providerCode: 'PLACE_FAILED',
        providerMessage: 'server did not place dirt at 1,64,0',
        supports: { up: true, down: false, north: false, south: false, east: false, west: false },
      },
    })
    expect(failure?.facts?.attempts).toEqual([
      { stance: { x: 0, y: 64, z: 0 }, face: 'up', place: 'failed', code: 'PLACE_FAILED', ok: false },
    ])
    expect(failure?.facts?.adjacent).toEqual(expect.arrayContaining([{ x: 2, y: 64, z: 0 }]))
  })

  it('keeps authority cause when a placement is explicitly denied', async () => {
    const fake = fakePort({
      failPlaceFaces: ['up'],
      failPlaceCode: 'PLACE_FAILED',
      placeFailureObserved: {
        face: 'up',
        providerCode: 'ACTION_DENIED',
        providerMessage: 'you do not have permission to place here',
        supports: { up: true, down: false, north: false, south: false, east: false, west: false },
        requestedFace: 'up',
      },
    })
    for (let x = -1; x <= 2; x += 1) {
      for (let z = -1; z <= 1; z += 1) {
        fake.world.set(`${x},63,${z}`, block('stone', { x, y: 63, z }))
        fake.world.set(`${x},64,${z}`, block('air', { x, y: 64, z }))
        fake.world.set(`${x},65,${z}`, block('air', { x, y: 65, z }))
      }
    }
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), {
      port: fake.port,
      now: () => 0,
    })
    await wait(30)

    expect((handle.result().observed as { failure?: unknown }).failure).toMatchObject({
      layer: 'driver',
      code: 'PLACE_FAILED',
      diagnosis: 'DENIED',
      cause: { kind: 'authority' },
      recovery: 'replan',
      facts: { providerCode: 'ACTION_DENIED', target: { x: 1, y: 64, z: 0 } },
    })
  })

  it('skips a stance whose own body covers the target cell', async () => {
    const fake = fakePort()
    fake.world.set('0,63,0', block('stone', { x: 0, y: 63, z: 0 }))
    fake.world.set('0,64,0', block('air', { x: 0, y: 64, z: 0 }))
    fake.world.set('0,65,0', block('air', { x: 0, y: 65, z: 0 }))
    const handle = createPlaceDriver().start(job({
      x: 0, y: 64, z: 0, item: 'dirt',
      stands: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }],
    }), { port: fake.port, now: () => 0 })
    await wait(30)
    expect(handle.result()).toMatchObject({ state: 'succeeded' })
    expect(fake.moves).toEqual([{ x: 1, y: 64, z: 0 }])
  })

  it('reports blockedBy self with adjacent stances when every stance covers the target', async () => {
    const fake = fakePort()
    fake.world.set('0,63,0', block('stone', { x: 0, y: 63, z: 0 }))
    fake.world.set('0,64,0', block('air', { x: 0, y: 64, z: 0 }))
    fake.world.set('0,65,0', block('air', { x: 0, y: 65, z: 0 }))
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    fake.world.set('1,65,0', block('air', { x: 1, y: 65, z: 0 }))
    const handle = createPlaceDriver().start(job({
      x: 0, y: 64, z: 0, item: 'dirt',
      stands: [{ x: 0, y: 64, z: 0 }],
    }), { port: fake.port, now: () => 0 })
    await wait(30)
    const result = handle.result()
    expect(result).toMatchObject({ state: 'failed', code: 'PLACE_BLOCKED_BY_SELF' })
    const observed = result.observed as { blockedBy?: string; adjacent?: Vec3[] }
    expect(observed.blockedBy).toBe('self')
    expect(observed.adjacent).toEqual(expect.arrayContaining([{ x: 1, y: 64, z: 0 }]))
    expect((result.observed as { failure?: unknown }).failure).toMatchObject({
      layer: 'driver',
      code: 'PLACE_BLOCKED_BY_SELF',
      diagnosis: 'START_EMBEDDED',
      cause: { kind: 'world' },
      recovery: 'replan',
      facts: { blockedBy: 'self', target: { x: 0, y: 64, z: 0 } },
    })
  })

  it('attempts a non-air target instead of pre-rejecting it', async () => {
    const fake = fakePort()
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('water', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), { port: fake.port, now: () => 0 })
    await wait(30)
    expect(handle.result()).toMatchObject({ state: 'succeeded' })
    expect(fake.places).toHaveLength(1)
    expect(fake.world.get('1,64,0')?.name).toBe('dirt')
  })

  it('fails when the accepted placement does not read back', async () => {
    const fake = fakePort({ placeWithoutEffect: true })
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), { port: fake.port, now: () => 0 })
    await wait(300)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'PLACE_READBACK_MISMATCH' })
    expect((handle.result().observed as { failure?: unknown }).failure)
      .toMatchObject({ layer: 'driver', code: 'PLACE_READBACK_MISMATCH', facts: { target: { x: 1, y: 64, z: 0 } } })
  })

  it('approaches a distant work face before placing', async () => {
    const fake = fakePort()
    const target = { x: 10, y: 64, z: 0 }
    // A loaded corridor from the body to the work face: the stand query proves
    // reachability over the same edges as the executor, so the world it reads
    // must actually be loaded between the two ends.
    for (let x = 0; x <= 10; x += 1) {
      fake.world.set(`${x},63,0`, block('stone', { x, y: 63, z: 0 }))
      fake.world.set(`${x},64,0`, block('air', { x, y: 64, z: 0 }))
      fake.world.set(`${x},65,0`, block('air', { x, y: 65, z: 0 }))
    }
    fake.world.set('10,64,0', block('air', target))
    const handle = createPlaceDriver().start(job({ x: 10, y: 64, z: 0, item: 'dirt' }), { port: fake.port, now: () => 0 })
    await wait(30)
    expect(handle.result()).toMatchObject({ state: 'succeeded' })
    expect(fake.moves.length).toBeGreaterThanOrEqual(1)
    expect(fake.places.length).toBeGreaterThanOrEqual(1)
  })

  it('rejects an occupied target before equipping or placing', async () => {
    const fake = fakePort()
    fake.world.set('1,64,0', block('grass_block', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), {
      port: fake.port,
      now: () => 0,
    })
    await wait(30)

    const result = handle.result()
    expect(result).toMatchObject({
      state: 'failed',
      code: 'PLACE_TARGET_OCCUPIED',
      observed: { occupied: { cell: { x: 1, y: 64, z: 0 }, block: 'grass_block' } },
    })
    expect(fake.places).toHaveLength(0)
    expect((result.observed as { failure?: unknown }).failure)
      .toMatchObject({ diagnosis: 'TARGET_OCCUPIED', facts: { occupied: { block: 'grass_block' } } })
  })

  it('returns alreadyPlaced without a packet when the target already matches', async () => {
    const fake = fakePort()
    fake.world.set('1,64,0', block('dirt', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), {
      port: fake.port,
      now: () => 0,
    })
    await wait(30)

    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: { alreadyPlaced: true, placedAt: { x: 1, y: 64, z: 0 } },
    })
    expect(fake.places).toHaveLength(0)
  })

  it('honours an explicit face without falling back to another support', async () => {
    const fake = fakePort()
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({
      x: 1, y: 64, z: 0, item: 'dirt', face: 'down',
    }), { port: fake.port, now: () => 0 })
    await wait(30)

    expect(handle.result()).toMatchObject({ state: 'failed', code: 'PLACE_UNSUPPORTED' })
    expect(fake.places).toHaveLength(0)
  })

  it('reports an expected support block as a hint without blocking the placement', async () => {
    const fake = fakePort()
    fake.world.set('1,63,0', block('dirt', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), {
      port: fake.port,
      now: () => 0,
    })
    await wait(30)

    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: {
        supportMatchesExpected: true,
        suggestedTarget: { x: 1, y: 63, z: 0 },
      },
    })
  })

  it('keeps the actual placedAt on an off-target failure', async () => {
    const fake = fakePort({
      failPlaceFaces: ['up'],
      failPlaceCode: 'PLACE_OFF_TARGET',
      placeFailureObserved: {
        face: 'up',
        placedAt: { x: 1, y: 63, z: 0 },
        placedCells: [{ x: 1, y: 63, z: 0 }],
        itemConsumed: true,
        retrySafe: false,
      },
    })
    fake.world.set('1,63,0', block('stone', { x: 1, y: 63, z: 0 }))
    fake.world.set('1,64,0', block('air', { x: 1, y: 64, z: 0 }))
    const handle = createPlaceDriver().start(job({ x: 1, y: 64, z: 0, item: 'dirt' }), {
      port: fake.port,
      now: () => 0,
    })
    await wait(30)

    const result = handle.result()
    expect(result).toMatchObject({
      state: 'failed',
      code: 'PLACE_OFF_TARGET',
      observed: { placedAt: { x: 1, y: 63, z: 0 }, itemConsumed: true },
    })
    expect((result.observed as { failure?: { facts?: { placedAt?: unknown } } }).failure?.facts?.placedAt)
      .toEqual({ x: 1, y: 63, z: 0 })
  })
})

describe('clear driver', () => {
  it('digs one block and confirms air twice', async () => {
    const fake = fakePort()
    fake.world.set('1,64,0', block('stone', { x: 1, y: 64, z: 0 }))
    const handle = createClearDriver().start(job({ x: 1, y: 64, z: 0 }), { port: fake.port, now: () => 0 })
    await wait(260)
    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: { kind: 'clear', block: 'stone', tool: null },
    })
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
