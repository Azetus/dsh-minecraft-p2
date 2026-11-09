import { describe, expect, it } from 'vitest'

import { createAttackDriver } from '../src/mind/drivers/attack.ts'
import { createAttackOrderGiver } from '../src/mind/givers/combat.ts'
import type { Job, WorldView } from '../src/mind/types.ts'
import type { BlockInfo, Box, BodyApi, EntityInfo } from '../src/body/api.ts'

/**
 * Category: data (combat ROE + evidence).
 * Protects: explicit target, protected targets, no acquisition, and the rule
 * that disappearance without entityDead is targetLost, never killed.
 */

const entity = (overrides: Partial<EntityInfo> & Pick<EntityInfo, 'id' | 'name'>): EntityInfo => ({
  position: { x: 1, y: 64, z: 1 },
  type: 'hostile',
  kind: 'Hostile mobs',
  ...overrides,
})

function world(entities: EntityInfo[]): WorldView {
  return {
    self: {
      pos: { x: 0.5, y: 64, z: 0.5 },
      health: 20,
      food: 20,
      yaw: 0,
      pitch: 0,
      onGround: true,
      inWater: false,
      inLava: false,
    },
    time: { timeOfDay: 1000, worldAge: 1 },
    inventory: [],
    blockAt: () => null,
    blocksIn: () => [],
    entitiesIn: (box: Box) => entities.filter(entity => entity.position.x >= box.min.x
      && entity.position.x <= box.max.x
      && entity.position.y >= box.min.y
      && entity.position.y <= box.max.y
      && entity.position.z >= box.min.z
      && entity.position.z <= box.max.z),
  } as unknown as WorldView
}

type Listener = { event: string; cb: (payload: unknown) => void }

function combatPort(options: {
  target: () => EntityInfo | undefined
  entityById?: () => EntityInfo | undefined
  attack: (listeners: Listener[]) => Promise<{ state: 'ok' | 'failed'; elapsedMs: number }>
  canSee?: () => boolean
  attackSpeed?: () => number
  attackReach?: () => number
  blockAt?: (p: { x: number; y: number; z: number }) => BlockInfo | null
  moveTo?: () => Promise<{ state: 'ok' | 'failed'; elapsedMs: number }>
  combatStep?: (opts: {
    cell: { x: number; y: number; z: number }
    face: { x: number; y: number; z: number }
    shield?: boolean
    timeoutMs?: number
  }) => Promise<{ state: 'ok' | 'failed'; code?: string; observed?: unknown; elapsedMs: number }>
  self?: () => { x: number; y: number; z: number }
  inventory?: Array<{ slot: number; name: string; count: number }>
  offhand?: () => { slot: number; name: string; count: number } | undefined
  equip?: (
    item: string,
    destination?: 'hand' | 'offhand',
  ) => Promise<{ state: 'ok' | 'failed'; code?: string; elapsedMs: number }>
}): {
  port: BodyApi
  listeners: Listener[]
  times: number[]
  equips: string[]
  equipCalls: Array<{ item: string; destination: 'hand' | 'offhand' }>
  steps: Array<{
    cell: { x: number; y: number; z: number }
    face: { x: number; y: number; z: number }
    shield?: boolean
    timeoutMs?: number
  }>
} {
  const listeners: Listener[] = []
  const times: number[] = []
  const equips: string[] = []
  const equipCalls: Array<{ item: string; destination: 'hand' | 'offhand' }> = []
  const steps: Array<{
    cell: { x: number; y: number; z: number }
    face: { x: number; y: number; z: number }
    shield?: boolean
    timeoutMs?: number
  }> = []
  const port = {
    self: () => ({ ...world([]).self, pos: options.self?.() ?? { x: 0.5, y: 64, z: 0.5 } }),
    entities: () => (options.target() === undefined ? [] : [options.target()!]),
    ...(options.entityById === undefined ? {} : { entityById: () => options.entityById!() }),
    inventory: () => options.inventory ?? [],
    ...(options.offhand === undefined ? {} : { offhand: options.offhand }),
    equip: async (item: string, destination: 'hand' | 'offhand' = 'hand') => {
      equips.push(item)
      equipCalls.push({ item, destination })
      return options.equip?.(item, destination) ?? { state: 'ok' as const, elapsedMs: 1 }
    },
    attack: async () => {
      times.push(Date.now())
      return options.attack(listeners)
    },
    blockAt: options.blockAt ?? (() => null),
    moveTo: options.moveTo ?? (async () => ({ state: 'ok' as const, elapsedMs: 1 })),
    combatStep: async (opts: {
      cell: { x: number; y: number; z: number }
      face: { x: number; y: number; z: number }
      shield?: boolean
      timeoutMs?: number
    }) => {
      steps.push(opts)
      return options.combatStep?.(opts) ?? {
        state: 'ok' as const,
        elapsedMs: 1,
        observed: { shieldUsed: opts.shield === true },
      }
    },
    canSee: options.canSee ?? (() => true),
    attackSpeed: options.attackSpeed ?? (() => 4),
    ...(options.attackReach === undefined ? {} : { attackReach: options.attackReach }),
    on: (event: string, cb: (payload: unknown) => void) => {
      listeners.push({ event, cb })
    },
  } as unknown as BodyApi
  return { port, listeners, times, equips, equipCalls, steps }
}

function emit(listeners: Listener[], event: string, entityId: string): void {
  for (const listener of listeners) {
    if (listener.event === event) listener.cb({ entityId })
  }
}

async function waitFor(handle: ReturnType<ReturnType<typeof createAttackDriver>['start']>): Promise<void> {
  for (let index = 0; index < 400 && handle.result().state === 'running'; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function job(params: Record<string, unknown>): Job {
  return { driverId: 'attack', params } as unknown as Job
}

describe('combat ROE', () => {
  it('honors an explicit maxChases and reports target health', async () => {
    const { port } = combatPort({
      target: () => entity({ id: 'z1', name: 'zombie', position: { x: 6, y: 64, z: 0 }, health: 1 }),
      moveTo: async () => ({ state: 'ok', elapsedMs: 1 }),
      attack: async () => ({ state: 'ok', elapsedMs: 1 }),
    })
    const handle = createAttackDriver().start(
      job({ entityId: 'z1', targetName: 'zombie', maxChases: 2 }),
      { body: port, now: () => 1 },
    )
    await waitFor(handle)
    expect(handle.result()).toMatchObject({
      state: 'failed',
      code: 'ATTACK_CHASE_LIMIT',
      observed: { chases: 2, targetHealth: 1 },
    })
  })

  it('attacks only the explicit attack-order entity', () => {
    const giver = createAttackOrderGiver(() => ({
      order: { id: 'ord-a', verb: 'attack', params: { entityId: 'e1' } },
    }))
    expect(giver.find({ now: 0 }, world([entity({ id: 'e1', name: 'zombie' })]))).toMatchObject({
      driverId: 'attack',
      params: { entityId: 'e1', continuationKey: 'order.attack:ord-a:e1' },
    })
    expect(giver.find({ now: 0 }, world([]))).toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_LOST' })
  })

  it('targets an explicit entity up to 64 blocks through focus, with a snapshot fallback', () => {
    const giver = createAttackOrderGiver(() => ({
      order: { id: 'ord-far', verb: 'attack', params: { entityId: 'far' } },
    }))
    const empty = world([])
    expect(giver.find({ now: 0 }, empty)).toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_LOST' })

    const far = entity({ id: 'far', name: 'zombie', position: { x: 60, y: 64, z: 0.5 } })
    expect(giver.find({ now: 2_000, focus: far }, empty)).toMatchObject({
      driverId: 'attack',
      params: { entityId: 'far', locateRadius: 64 },
    })

    const near = entity({ id: 'far', name: 'zombie', position: { x: 10, y: 64, z: 0.5 } })
    expect(giver.find({ now: 3_000 }, world([near]))).toMatchObject({
      driverId: 'attack',
      params: { entityId: 'far' },
    })

    const other = entity({ id: 'other', name: 'zombie', position: { x: 10, y: 64, z: 0.5 } })
    expect(giver.find({ now: 4_000, focus: other }, empty)).toMatchObject({
      kind: 'hold',
      reason: 'ATTACK_TARGET_LOST',
    })

    const tooFar = entity({ id: 'far', name: 'zombie', position: { x: 70, y: 64, z: 0.5 } })
    expect(giver.find({ now: 5_000 }, world([tooFar]))).toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_LOST' })
  })

  it('lets an explicit attack order target any entity', () => {
    const sheep = entity({ id: 's1', name: 'sheep', type: 'animal', kind: 'Passive mobs' })
    const sheepGiver = createAttackOrderGiver(() => ({
      order: { id: 'ord-s', verb: 'attack', params: { entityId: 's1' } },
    }))
    expect(sheepGiver.find({ now: 0 }, world([sheep]))).toMatchObject({
      driverId: 'attack',
      params: { entityId: 's1', allowAny: true },
    })

    const player = entity({ id: 'p1', name: 'Human_Player', type: 'player', kind: 'player' })
    const playerGiver = createAttackOrderGiver(() => ({
      order: { id: 'ord-p', verb: 'attack', params: { entityId: 'p1' } },
    }))
    expect(playerGiver.find({ now: 0 }, world([player]))).toMatchObject({
      driverId: 'attack',
      params: { entityId: 'p1', allowAny: true },
    })
  })

  it('locates an attack target by id without a box scan', async () => {
    const target = entity({ id: 'z9', name: 'zombie', position: { x: 2, y: 64, z: 0.5 } })
    const { port, listeners } = combatPort({
      target: () => undefined,
      entityById: () => target,
      attack: async current => {
        emit(current, 'entityDead', 'z9')
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(
      job({ entityId: 'z9', targetName: 'zombie' }),
      { body: port, now: () => 1 },
    )
    await waitFor(handle)
    expect(handle.result().state).toBe('succeeded')
  })
})

describe('combat evidence', () => {
  it('auto-equips the strongest weapon once and respects an explicit-equip override', async () => {
    let alive = true
    const fake = combatPort({
      target: () => (alive ? entity({ id: 'z1', name: 'zombie' }) : undefined),
      inventory: [
        { slot: 36, name: 'iron_sword', count: 1 },
        { slot: 37, name: 'diamond_sword', count: 1 },
      ],
      attack: async listeners => {
        emit(listeners, 'entityHurt', 'z1')
        emit(listeners, 'entityDead', 'z1')
        alive = false
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const first = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), {
      body: fake.port,
      now: () => 1,
    })
    await waitFor(first)
    expect(first.result()).toMatchObject({ state: 'succeeded', observed: { killed: true } })
    expect(fake.equips).toEqual(['diamond_sword'])

    alive = true
    const second = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), {
      body: fake.port,
      now: () => 1,
      allowAutoEquip: () => false,
    })
    await waitFor(second)
    expect(second.result()).toMatchObject({ state: 'succeeded', observed: { killed: true } })
    expect(fake.equips).toEqual(['diamond_sword'])
  })

  it('allowAny lets an explicit order hit a player while the default guard protects', async () => {
    let alive = true
    const player = entity({ id: 'p1', name: 'Human_Player', type: 'player', kind: 'player' })
    const { port } = combatPort({
      target: () => (alive ? player : undefined),
      attack: async listeners => {
        emit(listeners, 'entityHurt', 'p1')
        emit(listeners, 'entityDead', 'p1')
        alive = false
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const explicit = createAttackDriver().start(job({ entityId: 'p1', targetName: 'Human_Player', allowAny: true }), { body: port, now: () => 1 })
    await waitFor(explicit)
    expect(explicit.result()).toMatchObject({ state: 'succeeded', observed: { killed: true } })

    alive = true
    const guarded = createAttackDriver().start(job({ entityId: 'p1', targetName: 'Human_Player' }), { body: port, now: () => 1 })
    await waitFor(guarded)
    expect(guarded.result()).toMatchObject({ state: 'failed', code: 'ATTACK_TARGET_PROTECTED' })
  })

  it('reports killed only after an entityDead event', async () => {
    let alive = true
    const { port } = combatPort({
      target: () => (alive ? entity({ id: 'z1', name: 'zombie' }) : undefined),
      attack: async listeners => {
        emit(listeners, 'entityHurt', 'z1')
        emit(listeners, 'entityDead', 'z1')
        alive = false
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: {
        kind: 'attack',
        entityId: 'z1',
        attacks: 1,
        attacksIssued: 1,
        damageObserved: 1,
        deathConfirmed: true,
        targetLost: false,
        killed: true,
      },
    })
  })

  it('never calls a disappearance a kill', async () => {
    let alive = true
    const { port } = combatPort({
      target: () => (alive ? entity({ id: 'z1', name: 'zombie' }) : undefined),
      attack: async () => {
        alive = false // the entity leaves the query range, no death event
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({
      state: 'failed',
      code: 'ATTACK_TARGET_LOST',
      observed: { killed: false, deathConfirmed: false, targetLost: true, attacksIssued: 1 },
    })
  })

  it('rechecks a moving target and attacks after one bounded chase', async () => {
    let self = { x: 0.5, y: 64, z: 0.5 }
    let alive = true
    const moves: unknown[] = []
    const { port } = combatPort({
      self: () => self,
      target: () => (alive ? entity({ id: 'z1', name: 'zombie', position: { x: 6, y: 64, z: 0 } }) : undefined),
      moveTo: async () => {
        moves.push({ range: 2, intent: 'attack', timeoutMs: 5_000 })
        self = { x: 4.5, y: 64, z: 0.5 }
        return { state: 'ok', elapsedMs: 1 }
      },
      attack: async listeners => {
        emit(listeners, 'entityDead', 'z1')
        alive = false
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: port, now: () => 1 })
    await waitFor(handle)
    expect(moves).toEqual([{ range: 2, intent: 'attack', timeoutMs: 5_000 }])
    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: { attacks: 1, killed: true, chases: 1 },
    })
  })

  it('spaces attacks by the attack-speed cooldown', async () => {
    let alive = true
    let hits = 0
    const { port, times } = combatPort({
      target: () => (alive ? entity({ id: 'z1', name: 'zombie' }) : undefined),
      attackSpeed: () => 2, // 500 ms
      attack: async listeners => {
        hits += 1
        if (hits >= 2) {
          emit(listeners, 'entityDead', 'z1')
          alive = false
        } else {
          emit(listeners, 'entityHurt', 'z1')
        }
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: port, now: () => 1 })
    await waitFor(handle)
    expect(times).toHaveLength(2)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(450)
    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { killed: true, cooldownMs: 500 } })
  })

  it('does not attack through a wall', async () => {
    const { port } = combatPort({
      target: () => entity({ id: 'z1', name: 'zombie' }),
      canSee: () => false,
      attack: async () => ({ state: 'ok', elapsedMs: 1 }),
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({
      state: 'failed',
      code: 'ATTACK_NO_LINE_OF_SIGHT',
      observed: { attacksIssued: 0, killed: false },
    })
  })

  it('stops after a bounded chase when the target cannot be reached', async () => {
    const { port } = combatPort({
      target: () => entity({ id: 'z1', name: 'zombie', position: { x: 6, y: 64, z: 0 } }),
      moveTo: async () => ({ state: 'ok', elapsedMs: 1 }),
      attack: async () => ({ state: 'ok', elapsedMs: 1 }),
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({
      state: 'failed',
      code: 'ATTACK_CHASE_LIMIT',
      observed: { chases: 12 },
    })
  })

  it('passes the entity width into the eye-to-AABB reach check', async () => {
    const moves: number[] = []
    const spider = entity({
      id: 'z1',
      name: 'spider',
      position: { x: 3.9, y: 64, z: 0.5 },
      width: 1.4,
      height: 0.9,
    })
    const mapped = combatPort({
      target: () => spider,
      moveTo: async () => {
        moves.push(1)
        return { state: 'ok', elapsedMs: 1 }
      },
      attack: async listeners => {
        emit(listeners, 'entityDead', 'z1')
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'spider' }), { body: mapped.port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { chases: 0 } })
    expect(moves).toHaveLength(0)

    // Same position without dimensions: the default player box is too narrow,
    // so the controller has to chase.
    let unmappedAttacks = 0
    const unmappedMoves: number[] = []
    const plain = entity({ id: 'z1', name: 'spider', position: { x: 3.9, y: 64, z: 0.5 } })
    const unmapped = combatPort({
      target: () => plain,
      moveTo: async () => {
        unmappedMoves.push(1)
        return { state: 'ok', elapsedMs: 1 }
      },
      attack: async () => {
        unmappedAttacks += 1
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const chasing = createAttackDriver().start(
      job({ entityId: 'z1', targetName: 'spider', maxChases: 1 }),
      { body: unmapped.port, now: () => 1 },
    )
    await waitFor(chasing)
    expect(chasing.result()).toMatchObject({ state: 'failed', code: 'ATTACK_CHASE_LIMIT', observed: { chases: 1 } })
    expect(unmappedMoves).toHaveLength(1)
    expect(unmappedAttacks).toBe(0)
  })

  it('passes the entity height into the eye-to-AABB reach check', async () => {
    const enderman = entity({
      id: 'z1',
      name: 'enderman',
      position: { x: 3.6, y: 62, z: 0.5 },
      width: 0.6,
      height: 2.9,
    })
    const mapped = combatPort({
      target: () => enderman,
      attack: async listeners => {
        emit(listeners, 'entityDead', 'z1')
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'enderman' }), { body: mapped.port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { chases: 0 } })

    // Without the reported height the default player box stops above the eye,
    // adding ~1.1 blocks of vertical distance and forcing a chase.
    const plain = entity({ id: 'z1', name: 'enderman', position: { x: 3.6, y: 62, z: 0.5 } })
    const unmapped = combatPort({
      target: () => plain,
      moveTo: async () => ({ state: 'ok', elapsedMs: 1 }),
      attack: async () => ({ state: 'ok', elapsedMs: 1 }),
    })
    const chasing = createAttackDriver().start(
      job({ entityId: 'z1', targetName: 'enderman', maxChases: 1 }),
      { body: unmapped.port, now: () => 1 },
    )
    await waitFor(chasing)
    expect(chasing.result()).toMatchObject({ state: 'failed', code: 'ATTACK_CHASE_LIMIT', observed: { chases: 1 } })
  })

  it('passes the adapter attack reach into the controller', async () => {
    const reach4 = combatPort({
      target: () => entity({ id: 'z1', name: 'zombie', position: { x: 1, y: 64, z: 0.5 } }),
      attackReach: () => 4,
      attack: async listeners => {
        emit(listeners, 'entityDead', 'z1')
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: reach4.port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: { reach: 4, reachSource: 'attribute' },
    })

    const fallback = combatPort({
      target: () => entity({ id: 'z1', name: 'zombie', position: { x: 1, y: 64, z: 0.5 } }),
      attack: async listeners => {
        emit(listeners, 'entityDead', 'z1')
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const plain = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: fallback.port, now: () => 1 })
    await waitFor(plain)
    expect(plain.result()).toMatchObject({
      state: 'succeeded',
      observed: { reach: 3, reachSource: 'default' },
    })
  })

  it('moves to a stand cell through the driver query on flat ground', async () => {
    let hits = 0
    let moves = 0
    const flat = combatPort({
      target: () => entity({
        id: 'z1',
        name: 'zombie',
        position: { x: 3.3, y: 64, z: 0.5 },
        width: 0.6,
        height: 1.95,
      }),
      blockAt: p => (p.y <= 63
        ? { name: 'stone', loaded: true }
        : { name: 'air', loaded: true }),
      attackSpeed: () => 2,
      moveTo: async () => {
        moves += 1
        return { state: 'ok', elapsedMs: 1 }
      },
      attack: async listeners => {
        hits += 1
        if (hits >= 2) emit(listeners, 'entityDead', 'z1')
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: flat.port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: { combatMoves: 1, strafeMoves: 1, noSafeCell: 0, moveFailures: 0 },
    })
    expect(flat.steps).toHaveLength(1)
    expect(moves).toBe(0)
  })

  it('auto-swaps a shield into an empty off hand before the attack', async () => {
    let offhand: { slot: number; name: string; count: number } | undefined
    const fake = combatPort({
      target: () => entity({ id: 'z1', name: 'zombie' }),
      inventory: [
        { slot: 36, name: 'shield', count: 1 },
        { slot: 37, name: 'iron_sword', count: 1 },
      ],
      offhand: () => offhand,
      equip: async (item, destination) => {
        if (item === 'shield' && destination === 'offhand') offhand = { slot: 45, name: 'shield', count: 1 }
        return { state: 'ok', elapsedMs: 1 }
      },
      attack: async listeners => {
        emit(listeners, 'entityDead', 'z1')
        return { state: 'ok', elapsedMs: 1 }
      },
    })
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: fake.port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({
      state: 'succeeded',
      observed: { shieldAutoEquip: 'equipped' },
    })
    expect(fake.equipCalls).toContainEqual({ item: 'shield', destination: 'offhand' })
  })

  it('leaves a non-empty off hand alone and reports the auto-swap state', async () => {
    const shieldOffhand = { slot: 45, name: 'shield', count: 1 }
    const torchOffhand = { slot: 45, name: 'torch', count: 1 }
    const cases: Array<{
      offhand: () => { slot: number; name: string; count: number } | undefined
      inventory: Array<{ slot: number; name: string; count: number }>
      expected: string
      equip?: (item: string, destination?: 'hand' | 'offhand') => Promise<{ state: 'ok' | 'failed'; elapsedMs: number }>
    }> = [
      { offhand: () => shieldOffhand, inventory: [], expected: 'present' },
      { offhand: () => torchOffhand, inventory: [{ slot: 36, name: 'shield', count: 1 }], expected: 'skipped' },
      { offhand: () => undefined, inventory: [], expected: 'no-shield' },
      {
        offhand: () => undefined,
        inventory: [{ slot: 36, name: 'shield', count: 1 }],
        expected: 'failed',
        equip: async () => ({ state: 'failed', code: 'USE_NO_ITEM', elapsedMs: 1 }),
      },
    ]
    for (const entry of cases) {
      const fake = combatPort({
        target: () => entity({ id: 'z1', name: 'zombie' }),
        inventory: entry.inventory,
        offhand: entry.offhand,
        ...(entry.equip === undefined ? {} : { equip: entry.equip }),
        attack: async listeners => {
          emit(listeners, 'entityDead', 'z1')
          return { state: 'ok', elapsedMs: 1 }
        },
      })
      const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { body: fake.port, now: () => 1 })
      await waitFor(handle)
      expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { shieldAutoEquip: entry.expected } })
    }
  })
})
