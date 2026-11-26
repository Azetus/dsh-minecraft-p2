/**
 * Category: contract / state safety.
 * Protects: hit=success, primary-arrow attribution, 3-shot bound, stop without
 * firing, and crossbow load-before-fire. Failure modes are false hits and
 * firing after stop.
 */

import { describe, expect, it } from 'vitest'

import { createShootDriver } from '../src/mind/drivers/shoot.ts'
import { createAttackDriver } from '../src/mind/drivers/attack.ts'
import type { BodyApi, EntityInfo, Item } from '../src/body/api.ts'
import type { DriverCtx, Job } from '../src/mind/types.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type FakeOptions = {
  weapon?: 'bow' | 'crossbow'
  ammo?: boolean
  charged?: string[] | undefined
  hit?: boolean
  canSee?: boolean
  target?: boolean
  multishot?: boolean
  sideHitOnly?: boolean
  hitOn?: number
  missingDirectId?: boolean
  missingCauseId?: boolean
  incompleteVolley?: boolean
  instantDespawn?: boolean
  pathBlocked?: boolean
  targetCloses?: 'during load' | 'on load release'
}

function fake(options: FakeOptions = {}): {
  body: BodyApi
  events: Array<{ event: string; cb: (payload: unknown) => void }>
  useStarts: () => number
  useReleases: () => number
  cancels: () => number
  arrows: () => string[]
  emit: (event: string, payload: unknown) => void
} {
  const weapon = options.weapon ?? 'bow'
  let held: Item | undefined = { slot: 0, name: weapon, count: 1 }
  let charged: string[] | undefined = weapon === 'crossbow'
    ? (Object.prototype.hasOwnProperty.call(options, 'charged') ? options.charged : [])
    : undefined
  let useActive = false
  let firing = false
  let starts = 0
  let releases = 0
  let cancelled = 0
  let nextArrow = 1
  const arrows: Array<EntityInfo & { id: string }> = []
  const listeners: Array<{ event: string; cb: (payload: unknown) => void }> = []
  const target: EntityInfo = {
    id: 'z1',
    name: 'zombie',
    position: { x: 12, y: 64, z: 0.5 },
    width: 0.6,
    height: 1.8,
    type: 'hostile',
    kind: 'Hostile mobs',
  }
  const emit = (event: string, payload: unknown): void => {
    for (const listener of listeners) if (listener.event === event) listener.cb(payload)
  }
  let firedShots = 0
  const spawnArrow = (hit: boolean): void => {
    firedShots += 1
    const shouldHit = hit && (options.hitOn === undefined || firedShots >= options.hitOn)
    const count = options.multishot && !options.incompleteVolley ? 3 : 1
    const ids: string[] = []
    for (let index = 0; index < count; index += 1) {
      const id = `arrow-${nextArrow++}`
      ids.push(id)
      arrows.push({
        id,
        name: 'arrow',
        position: { x: 12, y: 64, z: 0.5 },
        velocity: index === 0
          ? { x: 3, y: 0, z: 0 }
          : { x: 2.9, y: 0, z: index === 1 ? 0.3 : -0.3 },
        width: 0.5,
        height: 0.5,
      })
      const arrow = arrows.at(-1)!
      emit('ownArrowSpawn', { id, velocity: arrow.velocity })
    }
    if (options.instantDespawn) arrows.length = 0
    if (options.sideHitOnly === true) {
      const side = ids[1]
      if (side !== undefined) {
        setTimeout(() => emit('entityDamageSource', { entityId: 'z1', sourceId: 'p2', directId: side }), 80)
      }
    } else if (shouldHit) {
      const primary = ids[0]!
      setTimeout(() => emit('entityDamageSource', {
        entityId: 'z1',
        ...(options.missingCauseId ? {} : { sourceId: 'p2' }),
        ...(options.missingDirectId ? {} : { directId: primary }),
      }), 80)
      setTimeout(() => emit('entityDead', { entityId: 'z1' }), 120)
    } else {
      // The arrow stays landed; its stable position is before the floor.
    }
  }
  const body = {
    self: () => ({
      id: 'p2',
      pos: { x: 0.5, y: 64, z: 0.5 },
      health: 20,
      food: 20,
      yaw: 0,
      pitch: 0,
      onGround: true,
      inWater: false,
      inLava: false,
      height: 1.8,
    }),
    identity: () => ({ worldId: 'w', characterId: 'c' }),
    blockAt: (p: { x: number; y: number; z: number }) =>
      options.pathBlocked === true && p.x >= 4 && p.x <= 8 && p.y >= 64 && p.y <= 66
        ? { name: 'stone', loaded: true, solid: true }
        : p.y < 64 ? { name: 'stone', loaded: true, solid: true } : { name: 'air', loaded: true, solid: false },
    biomeAt: () => null,
    blocksIn: () => [],
    findBlocks: () => [],
    inventory: () => [
      { slot: 0, name: weapon, count: 1 },
      ...(options.ammo === false ? [] : [{ slot: 1, name: 'arrow', count: 8 }]),
    ],
    held: () => held === undefined ? undefined : { ...held, ...(charged === undefined ? {} : { chargedProjectiles: [...charged] }) },
    offhand: () => undefined,
    entities: (box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) =>
      [target, ...arrows].filter(entity =>
        entity.position.x >= box.min.x && entity.position.x <= box.max.x
        && entity.position.y >= box.min.y && entity.position.y <= box.max.y
        && entity.position.z >= box.min.z && entity.position.z <= box.max.z),
    entityById: (id: string) => id === 'z1' ? target : arrows.find(arrow => arrow.id === id),
    canSee: () => options.canSee !== false,
    equip: async (item: string) => {
      held = { slot: 0, name: item, count: 1 }
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    itemUseStart: async (aim?: { yaw: number; pitch: number }) => {
      starts += 1
      if (weapon === 'crossbow' && charged !== undefined && charged.length > 0) {
        charged = []
        firing = true
        spawnArrow(options.hit !== false)
      } else {
        useActive = true
        if (options.targetCloses === 'during load') target.position.x = 3
        // 26.1.2 can report a charged crossbow before the load stance is released.
        if (options.targetCloses === 'on load release') charged = ['arrow']
      }
      return { state: 'ok' as const, elapsedMs: 1, observed: { aim: aim ?? null } }
    },
    itemUseRelease: async () => {
      releases += 1
      if (weapon === 'crossbow') {
        if (firing) {
          firing = false
        } else {
          if (charged !== undefined && charged.length === 0) charged = ['arrow']
          if (options.targetCloses === 'on load release') target.position.x = 3
        }
        useActive = false
      } else {
        useActive = false
        spawnArrow(options.hit !== false)
      }
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    itemUseCancel: async () => {
      cancelled += 1
      useActive = false
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    moveTo: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    combatInput: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    pathTo: async () => ({ state: 'failed' as const }),
    lookAt: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    lookYaw: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    dig: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    place: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    useItem: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    offhandHold: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    unequip: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    craft: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    useOn: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    attack: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    sleep: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    containerAt: async () => ({ state: 'failed' as const, code: 'NO' }),
    containerTransfer: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    fatalStep: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    beginWrite: () => {},
    endWrite: () => {},
    say: () => {},
    on: (event: string, cb: (payload: unknown) => void) => { listeners.push({ event, cb }) },
    off: (event: string, cb: (payload: unknown) => void) => {
      const index = listeners.findIndex(listener => listener.event === event && listener.cb === cb)
      if (index >= 0) listeners.splice(index, 1)
    },
  } as unknown as BodyApi
  return {
    body,
    events: listeners,
    useStarts: () => starts,
    useReleases: () => releases,
    cancels: () => cancelled,
    arrows: () => arrows.map(arrow => arrow.id),
    emit,
  }
}

function job(weapon: 'bow' | 'crossbow', overrides: Record<string, unknown> = {}): Job {
  return {
    driverId: 'shoot',
    params: { entityId: 'z1', targetName: 'zombie', weapon, maxShots: 1, ...overrides },
  } as unknown as Job
}

function ctx(body: BodyApi): DriverCtx {
  return { body } as unknown as DriverCtx
}

async function run(handle: ReturnType<ReturnType<typeof createShootDriver>['start']>): Promise<void> {
  for (let index = 0; index < 800 && handle.result().state === 'running'; index += 1) {
    handle.tick()
    await sleep(10)
  }
}

describe('combat crossbow (CONTRACTS.md § attack.allowRanged)', () => {
  it.each(['during load', 'on load release'] as const)('switches to melee without firing when the target closes %s', async targetCloses => {
    const f = fake({ weapon: 'crossbow', targetCloses })
    const body: BodyApi = {
      ...f.body,
      inventory: () => [...f.body.inventory(), { slot: 2, name: 'iron_sword', count: 1 }],
      attack: async id => {
        expect(f.body.held?.()?.name).toBe('iron_sword')
        f.emit('entityDead', { entityId: id })
        return { state: 'ok', elapsedMs: 1 }
      },
    }
    const handle = createAttackDriver().start({
      ...job('crossbow'), driverId: 'attack', params: { entityId: 'z1', allowRanged: true },
    }, ctx(body))
    await run(handle)

    expect(f.arrows()).toHaveLength(0)
    expect(f.useStarts()).toBe(1)
    expect(f.useReleases()).toBe(targetCloses === 'during load' ? 0 : 1)
    expect(handle.result()).toMatchObject({
      state: 'succeeded', observed: { weaponMode: 'melee', attacksIssued: 1, killed: true },
    })
    await body.equip('crossbow')
    expect(body.held?.()?.chargedProjectiles).toEqual(targetCloses === 'on load release' ? ['arrow'] : [])
  })
})

describe('shoot driver', () => {
  it('fires a bow and succeeds on the primary arrow hit', async () => {
    const fakeBody = fake({ weapon: 'bow', hit: true })
    const handle = createShootDriver().start(job('bow'), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result().state).toBe('succeeded')
    expect(handle.result().observed).toMatchObject({
      kind: 'shoot',
      hit: true,
      hits: 1,
    })
    expect(fakeBody.useStarts()).toBe(1)
    expect(fakeBody.useReleases()).toBe(1)
  })

  it('continues after a miss and succeeds on the second shot', async () => {
    const fakeBody = fake({ weapon: 'bow', hit: true, hitOn: 2 })
    const handle = createShootDriver().start(job('bow', { maxShots: 3 }), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result().state).toBe('succeeded')
    const shots = (handle.result().observed as Record<string, unknown>).shots as Array<Record<string, unknown>>
    expect(shots).toHaveLength(2)
    expect(shots[0]?.missed).toBe(true)
    expect(shots[1]?.hit).toBe(true)
  })

  it.each([
    { missingDirectId: true },
    { missingDirectId: true, missingCauseId: true },
    { incompleteVolley: true },
  ])('keeps ambiguous attribution inconclusive (%j)', async options => {
    const volley = 'incompleteVolley' in options
    const charged = volley ? ['arrow', 'arrow', 'arrow'] : ['arrow']
    const fakeBody = fake({ weapon: 'crossbow', charged, multishot: volley, ...options })
    const handle = createShootDriver().start(job('crossbow'), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'SHOOT_INCONCLUSIVE' })
  })

  it('confirms the primary arrow of a volley even after it despawns', async () => {
    const fakeBody = fake({ weapon: 'crossbow', charged: ['arrow', 'arrow', 'arrow'], multishot: true, instantDespawn: true })
    const handle = createShootDriver().start(job('crossbow'), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { shots: [
      { hitEvidence: 'damage-source-arrow', hurt: { sourceId: 'p2', directId: 'arrow-1' } },
    ] } })
  })

  it('does not count a Multishot side arrow as the primary hit', async () => {
    const fakeBody = fake({ weapon: 'crossbow', charged: ['arrow', 'arrow', 'arrow'], multishot: true, sideHitOnly: true })
    const handle = createShootDriver().start(job('crossbow', { maxShots: 1 }), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'SHOOT_MISSED' })
    const observed = handle.result().observed as Record<string, unknown>
    expect((observed.shots as Array<Record<string, unknown>>)[0]).toMatchObject({
      hit: false,
      sideHit: true,
    })
  })

  it('loads an unloaded crossbow before firing', async () => {
    const fakeBody = fake({ weapon: 'crossbow', charged: [], hit: true })
    const handle = createShootDriver().start(job('crossbow'), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result().state).toBe('succeeded')
    expect(fakeBody.useStarts()).toBe(2)
    expect(fakeBody.useReleases()).toBe(2)
    const observed = handle.result().observed as Record<string, unknown>
    expect((observed.shots as Array<Record<string, unknown>>)[0]?.load).toMatchObject({
      kind: 'load-crossbow',
      alreadyLoaded: false,
    })
  })

  it('uses an already charged crossbow without loading again', async () => {
    const fakeBody = fake({ weapon: 'crossbow', charged: ['arrow'], hit: true })
    const handle = createShootDriver().start(job('crossbow'), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result().state).toBe('succeeded')
    expect(fakeBody.useStarts()).toBe(1)
    expect(fakeBody.useReleases()).toBe(1)
  })

  it('fails closed when the crossbow charged state is unknown', async () => {
    const fakeBody = fake({ weapon: 'crossbow', charged: undefined })
    const handle = createShootDriver().start(job('crossbow'), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'CROSSBOW_LOAD_STATE_UNKNOWN' })
    expect(fakeBody.useStarts()).toBe(0)
  })

  it('fails when the requested weapon is not in the inventory', async () => {
    const fakeBody = fake({ weapon: 'crossbow', charged: ['arrow'], hit: true })
    const handle = createShootDriver().start(job('bow'), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'SHOOT_NO_WEAPON' })
  })

  it('fails without ammunition', async () => {
    const fakeBody = fake({ weapon: 'bow', ammo: false })
    const handle = createShootDriver().start(job('bow'), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'SHOOT_NO_AMMO' })
  })

  it('fails on a blocked ballistic path before using the weapon', async () => {
    const fakeBody = fake({ weapon: 'bow', pathBlocked: true })
    const handle = createShootDriver().start(job('bow'), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'SHOOT_LINE_BLOCKED' })
    expect(fakeBody.useStarts()).toBe(0)
  })

  it('reports a landed arrow as missed without claiming a hit', async () => {
    const fakeBody = fake({ weapon: 'bow', hit: false })
    const handle = createShootDriver().start(job('bow', { maxShots: 1 }), ctx(fakeBody.body))
    await run(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'SHOOT_MISSED' })
    const observed = handle.result().observed as Record<string, unknown>
    expect((observed.shots as Array<Record<string, unknown>>)[0]).toMatchObject({
      hit: false,
      missed: true,
    })
  })

  it('cancels crossbow loading on stop without firing', async () => {
    const fakeBody = fake({ weapon: 'crossbow', charged: [], hit: true })
    const handle = createShootDriver().start(job('crossbow'), ctx(fakeBody.body))
    await sleep(120)
    handle.requestStop()
    await run(handle)
    expect(handle.result().state).toBe('interrupted')
    expect(fakeBody.cancels()).toBeGreaterThan(0)
    expect(fakeBody.useReleases()).toBe(0)
    expect(fakeBody.arrows()).toHaveLength(0)
  })

  it('cancels a drawn bow on stop without firing', async () => {
    const fakeBody = fake({ weapon: 'bow', hit: true })
    const handle = createShootDriver().start(job('bow'), ctx(fakeBody.body))
    await sleep(150)
    handle.requestStop()
    await run(handle)
    expect(handle.result().state).toBe('interrupted')
    expect(fakeBody.cancels()).toBeGreaterThan(0)
    expect(fakeBody.useReleases()).toBe(0)
    expect(fakeBody.arrows()).toHaveLength(0)
  })
})
