import { describe, expect, it } from 'vitest'

import { createEscapeGiver } from '../src/mind/givers/escape.ts'
import { createAttackOrderGiver } from '../src/mind/givers/combat.ts'
import { createDigOrderGiver } from '../src/mind/givers/dig.ts'
import { createGoOrderGiver, createHoldOrderGiver, createTraverseGiver } from '../src/mind/givers/orders.ts'
import { MAIN_TREE } from '../src/mind/trees.ts'
import type { Candidate, EvalCtx } from '../src/mind/types.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { EntityInfo, SelfInfo } from '../src/port/index.ts'

/**
 * Category: state safety / contract.
 * Protects: escape reacts only to immediate danger and targets are standable
 * cells from the same snapshot.
 */

function asCandidate(result: unknown): Candidate {
  if (result === null || result === undefined || typeof result !== 'object' || !('keys' in result)) {
    throw new Error(`expected a candidate, got ${JSON.stringify(result)}`)
  }
  return result as Candidate
}

function self(overrides: Partial<SelfInfo> = {}): SelfInfo {
  return {
    pos: { x: 0.5, y: 64, z: 0.5 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
    ...overrides,
  }
}

function flatWorld(options: {
  self?: Partial<SelfInfo>
  entities?: EntityInfo[]
  radius?: number
} = {}): SnapshotWorld {
  const radius = options.radius ?? 12
  const blocks = []
  for (let x = -radius; x <= radius; x += 1) {
    for (let z = -radius; z <= radius; z += 1) {
      blocks.push({ name: 'stone', loaded: true, pos: { x, y: 63, z } })
      blocks.push({ name: 'air', loaded: true, pos: { x, y: 64, z } })
      blocks.push({ name: 'air', loaded: true, pos: { x, y: 65, z } })
    }
  }
  return new SnapshotWorld({
    self: self(options.self),
    time: { timeOfDay: 1000, worldAge: 100 },
    entities: options.entities ?? [],
    blocks,
    inventory: [],
  })
}

const ctx: EvalCtx = { now: 0, home: { x: 0, y: 64, z: 0 } }

describe('escape giver', () => {
  it('does nothing without immediate danger', () => {
    expect(createEscapeGiver().find(ctx, flatWorld())).toBeNull()
  })

  it('escapes lava to a standable neighbour', () => {
    const result = asCandidate(createEscapeGiver().find(ctx, flatWorld({ self: { inLava: true } })))
    expect(result?.driverId).toBe('move')
    expect(result?.keys).toBe('escape:lava')
    expect(result?.params).toMatchObject({ range: 1 })
  })

  it('escapes deep water', () => {
    const result = asCandidate(createEscapeGiver().find(ctx, flatWorld({ self: { inWater: true, onGround: false } })))
    expect(result?.keys).toBe('escape:water')
  })

  it('does not flee while wading in one block of water', () => {
    const wading = new SnapshotWorld({
      self: self({ inWater: true, onGround: false }),
      time: { timeOfDay: 1000, worldAge: 100 },
      entities: [],
      blocks: [
        { name: 'stone', loaded: true, pos: { x: 0, y: 63, z: 0 } },
        { name: 'water', loaded: true, pos: { x: 0, y: 64, z: 0 } },
        { name: 'air', loaded: true, pos: { x: 0, y: 65, z: 0 } },
      ],
      inventory: [],
    })
    expect(createEscapeGiver().find(ctx, wading)).toBeNull()
  })

  it('still flees when the water column covers the head', () => {
    const deep = new SnapshotWorld({
      self: self({ inWater: true, onGround: false }),
      time: { timeOfDay: 1000, worldAge: 100 },
      entities: [],
      blocks: [
        { name: 'stone', loaded: true, pos: { x: 0, y: 62, z: 0 } },
        { name: 'water', loaded: true, pos: { x: 0, y: 63, z: 0 } },
        { name: 'water', loaded: true, pos: { x: 0, y: 64, z: 0 } },
        { name: 'water', loaded: true, pos: { x: 0, y: 65, z: 0 } },
        { name: 'stone', loaded: true, pos: { x: 1, y: 63, z: 0 } },
        { name: 'air', loaded: true, pos: { x: 1, y: 64, z: 0 } },
        { name: 'air', loaded: true, pos: { x: 1, y: 65, z: 0 } },
      ],
      inventory: [],
    })
    const result = asCandidate(createEscapeGiver().find(ctx, deep))
    expect(result.keys).toBe('escape:water')
  })

  it('retreats from a hostile within six blocks', () => {
    const threat: EntityInfo = { id: 'c1', name: 'creeper', position: { x: 2, y: 64, z: 0 } }
    const result = asCandidate(createEscapeGiver().find(ctx, flatWorld({ entities: [threat] })))
    expect(result?.keys).toBe('escape:hostile:c1')
    const target = result?.target
    if (target === undefined || target.kind !== 'point') throw new Error('expected a point')
    expect(Math.hypot(target.pos.x - threat.position.x, target.pos.z - threat.position.z)).toBeGreaterThan(3)
  })

  it('ignores a non-hostile entity', () => {
    const cow: EntityInfo = { id: 'cow', name: 'cow', position: { x: 2, y: 64, z: 0 } }
    expect(createEscapeGiver().find(ctx, flatWorld({ entities: [cow] }))).toBeNull()
  })

  it('holds and reports when there is no safe cell', () => {
    const empty = new SnapshotWorld({
      self: self({ inLava: true }),
      time: { timeOfDay: 1000, worldAge: 100 },
      entities: [],
      blocks: [],
      inventory: [],
    })
    expect(createEscapeGiver().find(ctx, empty)).toMatchObject({ kind: 'hold', reason: 'NO_SAFE_TARGET' })
  })

  it('does not flee from an explicitly authorized attack target', () => {
    const target: EntityInfo = { id: 'z1', name: 'zombie', position: { x: 2, y: 64, z: 0 } }
    const attackCtx: EvalCtx = {
      now: 0,
      home: { x: 0, y: 64, z: 0 },
      orderVerb: 'attack',
      orderParams: { entityId: 'z1' },
    }
    expect(createEscapeGiver().find(attackCtx, flatWorld({ entities: [target] }))).toBeNull()
  })

  it('still flees from an uncovered second hostile', () => {
    const target: EntityInfo = { id: 'z1', name: 'zombie', position: { x: 2, y: 64, z: 0 } }
    const other: EntityInfo = { id: 'z2', name: 'zombie', position: { x: 3, y: 64, z: 0 } }
    const attackCtx: EvalCtx = {
      now: 0,
      home: { x: 0, y: 64, z: 0 },
      orderVerb: 'attack',
      orderParams: { entityId: 'z1' },
    }
    const result = asCandidate(createEscapeGiver().find(attackCtx, flatWorld({ entities: [target, other] })))
    expect(result.keys).toBe('escape:hostile:z2')
  })

  it('does not override an explicit lava grant', () => {
    const granted: EvalCtx = {
      now: 0,
      home: { x: 0, y: 64, z: 0 },
      hazards: { allow: ['lava'] },
    }
    expect(createEscapeGiver().find(granted, flatWorld({ self: { inLava: true } }))).toBeNull()
  })
})

describe('main tree wiring', () => {
  it('references order.traverse so the giver can actually run', () => {
    const refs = MAIN_TREE.type === 'priority'
      ? MAIN_TREE.children.map(child => child.type === 'giver' ? child.ref : undefined)
      : []
    expect(refs).toContain('order.traverse')
  })
})

describe('order and traverse givers', () => {
  it('wires ordinary go approach and per-order exact/dig authorization into the move job', () => {
    const unstickDig = [{ x: 1, y: 65, z: 0, name: 'dirt' }]
    const giver = createGoOrderGiver(() => ({ order: { id: 'go-1', verb: 'go',
      params: { x: 6, y: 64, z: 0, exact: true, unstickDig } } }))
    expect(giver.find(ctx, flatWorld())).toMatchObject({ driverId: 'move', params: { approach: true, exact: true, unstickDig } })
  })
  it('routes an explicitly allowed lethal fall to the Agent fatal driver', () => {
    const go = createGoOrderGiver(() => ({ order: { id: 'go-lf', verb: 'go',
      params: { x: 6, y: 60, z: 0 },
      policy: { hazards: { allow: ['lethal_fall'], reason: 'fall' } } } }))
    expect(go.find(ctx, flatWorld())).toMatchObject({ driverId: 'fatal' })
  })

  it('does not pass fatal hazards into a normal move job', () => {
    const go = createGoOrderGiver(() => ({ order: { id: 'go-h', verb: 'go',
      params: { x: 6, y: 64, z: 0 },
      policy: { hazards: { allow: ['lethal_fall'], reason: 'fall' } } } }))
    const result = go.find(ctx, flatWorld())
    expect(result).toMatchObject({ driverId: 'move' })
    expect(result).not.toHaveProperty('params.hazards')
  })

  it('holds a hold order and a lost attack target without producing a job', () => {
    const hold = createHoldOrderGiver(() => ({ order: { id: 'h-1', verb: 'hold' } }))
    expect(hold.find(ctx, flatWorld())).toMatchObject({ kind: 'hold', reason: 'HOLD_ORDER', notify: false })

    const attack = createAttackOrderGiver(() => ({
      order: { id: 'a-1', verb: 'attack', params: { entityId: 'zombie-1' } },
    }))
    expect(attack.find(ctx, flatWorld())).toMatchObject({ kind: 'hold', reason: 'ATTACK_TARGET_LOST' })
  })

  it('passes the dig purpose through to the driver', () => {
    const dig = createDigOrderGiver(() => ({
      order: { id: 'd-1', verb: 'dig', params: { x: 2, y: 64, z: 0, purpose: 'clear' } },
    }))
    expect(dig.find(ctx, flatWorld())).toMatchObject({
      driverId: 'dig',
      params: { x: 2, y: 64, z: 0, purpose: 'clear' },
    })
  })

})

