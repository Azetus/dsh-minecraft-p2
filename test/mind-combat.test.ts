import { describe, expect, it } from 'vitest'

import { createAttackDriver } from '../src/mind/drivers/attack.ts'
import { createAttackOrderGiver } from '../src/mind/givers/combat.ts'
import type { Job, WorldView } from '../src/mind/types.ts'
import type { Box, ClientPort, EntityInfo } from '../src/port/index.ts'

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
  attack: (listeners: Listener[]) => Promise<{ state: 'ok' | 'failed'; elapsedMs: number }>
  canSee?: () => boolean
  attackSpeed?: () => number
  moveTo?: () => Promise<{ state: 'ok' | 'failed'; elapsedMs: number }>
  self?: () => { x: number; y: number; z: number }
  inventory?: Array<{ slot: number; name: string; count: number }>
  equip?: (item: string) => Promise<{ state: 'ok' | 'failed'; code?: string; elapsedMs: number }>
}): { port: ClientPort; listeners: Listener[]; times: number[]; equips: string[] } {
  const listeners: Listener[] = []
  const times: number[] = []
  const equips: string[] = []
  const port = {
    self: () => ({ ...world([]).self, pos: options.self?.() ?? { x: 0.5, y: 64, z: 0.5 } }),
    entities: () => (options.target() === undefined ? [] : [options.target()!]),
    inventory: () => options.inventory ?? [],
    equip: async (item: string) => {
      equips.push(item)
      return options.equip?.(item) ?? { state: 'ok' as const, elapsedMs: 1 }
    },
    attack: async () => {
      times.push(Date.now())
      return options.attack(listeners)
    },
    moveTo: options.moveTo ?? (async () => ({ state: 'ok' as const, elapsedMs: 1 })),
    canSee: options.canSee ?? (() => true),
    attackSpeed: options.attackSpeed ?? (() => 4),
    on: (event: string, cb: (payload: unknown) => void) => {
      listeners.push({ event, cb })
    },
  } as unknown as ClientPort
  return { port, listeners, times, equips }
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

  it('targets an explicit entity up to 64 blocks and observes at most once per second', () => {
    let observed = 0
    const giver = createAttackOrderGiver(() => ({
      order: { id: 'ord-far', verb: 'attack', params: { entityId: 'far' } },
    }))
    const empty = world([])
    expect(giver.find({ now: 0, observeEntities: () => { observed += 1 } }, empty))
      .toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_LOST' })
    expect(observed).toBe(1)
    expect(giver.find({ now: 500, observeEntities: () => { observed += 1 } }, empty))
      .toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_LOST' })
    expect(observed).toBe(1)
    expect(giver.find({ now: 1_000, observeEntities: () => { observed += 1 } }, empty))
      .toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_LOST' })
    expect(observed).toBe(2)

    const far = entity({ id: 'far', name: 'zombie', position: { x: 60, y: 64, z: 0.5 } })
    expect(giver.find({ now: 2_000 }, world([far]))).toMatchObject({
      driverId: 'attack',
      params: { entityId: 'far', locateRadius: 64 },
    })
    const tooFar = entity({ id: 'far', name: 'zombie', position: { x: 70, y: 64, z: 0.5 } })
    expect(giver.find({ now: 3_000 }, world([tooFar]))).toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_LOST' })
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
      port: fake.port,
      now: () => 1,
    })
    await waitFor(first)
    expect(first.result()).toMatchObject({ state: 'succeeded', observed: { killed: true } })
    expect(fake.equips).toEqual(['diamond_sword'])

    alive = true
    const second = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), {
      port: fake.port,
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
    const explicit = createAttackDriver().start(job({ entityId: 'p1', targetName: 'Human_Player', allowAny: true }), { port, now: () => 1 })
    await waitFor(explicit)
    expect(explicit.result()).toMatchObject({ state: 'succeeded', observed: { killed: true } })

    alive = true
    const guarded = createAttackDriver().start(job({ entityId: 'p1', targetName: 'Human_Player' }), { port, now: () => 1 })
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
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { port, now: () => 1 })
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
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { port, now: () => 1 })
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
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { port, now: () => 1 })
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
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { port, now: () => 1 })
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
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { port, now: () => 1 })
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
    const handle = createAttackDriver().start(job({ entityId: 'z1', targetName: 'zombie' }), { port, now: () => 1 })
    await waitFor(handle)
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'ATTACK_CHASE_LIMIT' })
  })
})
