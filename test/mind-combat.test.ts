import { describe, expect, it } from 'vitest'

import { createAttackDriver } from '../src/mind/drivers/attack.ts'
import { createAttackOrderGiver } from '../src/mind/givers/combat.ts'
import type { Job, WorldView } from '../src/mind/types.ts'
import type { ClientPort, EntityInfo } from '../src/port/index.ts'

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
    entitiesIn: () => entities,
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
}): { port: ClientPort; listeners: Listener[]; times: number[] } {
  const listeners: Listener[] = []
  const times: number[] = []
  const port = {
    self: () => ({ ...world([]).self, pos: options.self?.() ?? { x: 0.5, y: 64, z: 0.5 } }),
    entities: () => (options.target() === undefined ? [] : [options.target()!]),
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
  return { port, listeners, times }
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
      params: { entityId: 'e1' },
    })
    expect(giver.find({ now: 0 }, world([]))).toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_LOST' })
  })

  it('requires explicit allowPassive for a named passive target', () => {
    const sheep = entity({ id: 's1', name: 'sheep', type: 'animal', kind: 'Passive mobs' })
    const blocked = createAttackOrderGiver(() => ({
      order: { id: 'ord-s', verb: 'attack', params: { entityId: 's1' } },
    }))
    expect(blocked.find({ now: 0 }, world([sheep]))).toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_PROTECTED' })
    const allowed = createAttackOrderGiver(() => ({
      order: { id: 'ord-s', verb: 'attack', params: { entityId: 's1', allowPassive: true } },
    }))
    expect(allowed.find({ now: 0 }, world([sheep]))).toMatchObject({
      driverId: 'attack', params: { entityId: 's1', allowPassive: true },
    })
    const player = entity({ id: 'p1', name: 'Human_Player', type: 'player', kind: 'player' })
    const playerGiver = createAttackOrderGiver(() => ({
      order: { id: 'ord-p', verb: 'attack', params: { entityId: 'p1', allowPassive: true } },
    }))
    expect(playerGiver.find({ now: 0 }, world([player]))).toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_PROTECTED' })
  })
})

describe('combat evidence', () => {
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
