import { describe, expect, it } from 'vitest'

import { createThreatFightGiver } from '../src/mind/givers/threat.ts'
import { createSelfEatGiver, createSelfUnstuckGiver } from '../src/mind/givers/self-care.ts'
import {
  DEFAULT_SELF_CARE,
  ReactionPolicyState,
  isAutoFightTarget,
  parseReactionPolicy,
} from '../src/mind/reaction-policy.ts'
import type { ReactionPolicy } from '../src/mind/reaction-policy.ts'
import type { Candidate } from '../src/mind/types.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { EntityInfo, Item, SelfInfo } from '../src/port/index.ts'

/**
 * Category: state safety / contract (M4 reaction policy).
 * Protects: default flee, full replacement, protected target classes,
 * explicit-order suppression, and bounded self-care.
 */

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
  inventory?: Item[]
  blocks?: boolean
} = {}): SnapshotWorld {
  const blocks = []
  if (options.blocks !== false) {
    for (let x = -8; x <= 8; x += 1) {
      for (let z = -8; z <= 8; z += 1) {
        blocks.push({ name: 'stone', loaded: true, pos: { x, y: 63, z } })
        blocks.push({ name: 'air', loaded: true, pos: { x, y: 64, z } })
        blocks.push({ name: 'air', loaded: true, pos: { x, y: 65, z } })
      }
    }
  }
  return new SnapshotWorld({
    self: self(options.self),
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: options.entities ?? [],
    blocks,
    inventory: options.inventory ?? [],
  })
}

function entity(name: string, overrides: Partial<EntityInfo> = {}): EntityInfo {
  return {
    id: `id-${name}`,
    name,
    type: 'hostile',
    kind: 'Hostile mobs',
    position: { x: 3.5, y: 64, z: 0.5 },
    ...overrides,
  }
}

function fightPolicy(overrides: Partial<NonNullable<ReactionPolicy['fight']>> = {}): ReactionPolicy {
  return {
    fight: {
      allowedTargets: [],
      retreatHealth: 8,
      radius: 8,
      leash: 12,
      ...overrides,
    },
    selfCare: {
      eat: { ...DEFAULT_SELF_CARE.eat },
      retreat: { ...DEFAULT_SELF_CARE.retreat },
      unstuck: { ...DEFAULT_SELF_CARE.unstuck },
    },
  }
}

function asCandidate(result: unknown): Candidate {
  if (result === null || typeof result !== 'object' || !('keys' in result)) {
    throw new Error(`expected a candidate, got ${JSON.stringify(result)}`)
  }
  return result as Candidate
}

describe('reaction policy parsing', () => {
  it('defaults to flee with self-care enabled', () => {
    const policy = parseReactionPolicy({})
    expect(policy.fight).toBeNull()
    expect(policy.selfCare).toMatchObject({
      eat: { enabled: true, foodBelow: 14 },
      retreat: { enabled: true, healthBelow: 8 },
      unstuck: { enabled: true },
    })
  })

  it('treats an explicit empty allowlist as all hostiles', () => {
    const policy = parseReactionPolicy({ fight: { allowedTargets: [] } })
    expect(policy.fight).toMatchObject({ allowedTargets: [], retreatHealth: 8, radius: 8, leash: 12 })
    const state = new ReactionPolicyState()
    expect(state.set({ fight: { allowedTargets: [] } }, 10)).toMatchObject({
      source: 'agent',
      mode: 'all-hostiles',
      updatedAt: 10,
    })
    expect(state.view().selfCare.eat.enabled).toBe(true)
  })

  it('rejects incomplete or protected fight policies', () => {
    expect(() => parseReactionPolicy({ fight: {} })).toThrow(/allowedTargets is required/)
    expect(() => parseReactionPolicy({ fight: { allowedTargets: ['player'] } })).toThrow(/players/)
    expect(() => parseReactionPolicy({ fight: { allowedTargets: ['enderman'] } })).toThrow(/neutral/)
    expect(() => parseReactionPolicy({ fight: { allowedTargets: ['creeper'] } })).toThrow(/auto-avoid/)
    expect(() => parseReactionPolicy({ fight: { allowedTargets: [], radius: 8, leash: 4 } })).toThrow(/leash/)
    expect(() => parseReactionPolicy({ fight: { allowedTargets: [], unknown: true } })).toThrow(/unknown/)
  })

  it('resets to default flee', () => {
    const state = new ReactionPolicyState()
    state.set({ fight: { allowedTargets: ['zombie'] } }, 10)
    expect(state.reset(20)).toMatchObject({ source: 'default', mode: 'flee', updatedAt: 20 })
    expect(state.view().fight).toBeNull()
  })
})

describe('automatic fight target filtering', () => {
  it('accepts allowed hostiles and rejects protected classes', () => {
    const policy = fightPolicy()
    expect(isAutoFightTarget(entity('zombie'), policy)).toBe(true)
    expect(isAutoFightTarget(entity('skeleton'), policy)).toBe(true)
    expect(isAutoFightTarget(entity('enderman'), policy)).toBe(false)
    expect(isAutoFightTarget(entity('creeper'), policy)).toBe(false)
    expect(isAutoFightTarget(entity('sheep', { type: 'animal', kind: 'Passive mobs' }), policy)).toBe(false)
    expect(isAutoFightTarget(entity('Human_Player', { type: 'player', kind: 'player' }), policy)).toBe(false)
  })

  it('honors a non-empty allowlist', () => {
    const policy = fightPolicy({ allowedTargets: ['zombie'] })
    expect(isAutoFightTarget(entity('zombie'), policy)).toBe(true)
    expect(isAutoFightTarget(entity('skeleton'), policy)).toBe(false)
  })
})

describe('threat.fight giver', () => {
  it('does nothing without a fight policy or during an explicit attack', () => {
    const defaultPolicy: ReactionPolicy = {
      fight: null,
      selfCare: { ...DEFAULT_SELF_CARE },
    }
    expect(createThreatFightGiver(() => defaultPolicy).find({ now: 0 }, flatWorld({ entities: [entity('zombie')] }))).toBeNull()

    const giver = createThreatFightGiver(() => fightPolicy())
    expect(giver.find({ now: 0, orderVerb: 'attack' }, flatWorld({ entities: [entity('zombie')] }))).toBeNull()
  })

  it('selects the nearest allowed hostile and locks the target', () => {
    const giver = createThreatFightGiver(() => fightPolicy())
    const candidate = asCandidate(giver.find({ now: 0 }, flatWorld({ entities: [entity('zombie')] })))
    expect(candidate).toMatchObject({
      driverId: 'attack',
      keys: 'threat.fight:id-zombie',
      params: { entityId: 'id-zombie', targetName: 'zombie', continuationKey: 'threat.fight:id-zombie' },
    })
  })

  it('skips neutral, auto-avoid and passive targets', () => {
    const giver = createThreatFightGiver(() => fightPolicy())
    const world = flatWorld({
      entities: [
        entity('enderman'),
        entity('creeper'),
        entity('sheep', { type: 'animal', kind: 'Passive mobs' }),
        entity('Human_Player', { type: 'player', kind: 'player' }),
      ],
    })
    expect(giver.find({ now: 0 }, world)).toBeNull()
  })

  it('does not fight below retreatHealth', () => {
    const giver = createThreatFightGiver(() => fightPolicy())
    expect(giver.find({ now: 0 }, flatWorld({
      self: { health: 8 },
      entities: [entity('zombie')],
    }))).toBeNull()
  })

  it('keeps the lock through a short observation gap instead of yielding to escape', () => {
    const giver = createThreatFightGiver(() => fightPolicy())
    const first = asCandidate(giver.find({ now: 0 }, flatWorld({ entities: [entity('zombie')] })))
    expect(first.keys).toBe('threat.fight:id-zombie')
    expect(giver.find({ now: 50 }, flatWorld())).toMatchObject({
      driverId: 'attack',
      keys: 'threat.fight:id-zombie',
      params: { entityId: 'id-zombie' },
    })
    expect(giver.find({ now: 100, canSee: () => false }, flatWorld())).toMatchObject({
      keys: 'threat.fight:id-zombie',
    })
  })

  it('cools down after a failed engagement', () => {
    const giver = createThreatFightGiver(() => fightPolicy())
    const world = flatWorld({ entities: [entity('zombie')] })
    expect(giver.find({ now: 0 }, world)).not.toBeNull()
    giver.noteTerminal({ keys: 'threat.fight:id-zombie', at: 100, state: 'failed', code: 'ATTACK_NO_APPROACH' })
    expect(giver.find({ now: 200 }, world)).toBeNull()
    expect(giver.find({ now: 3_200 }, world)).toBeNull() // target is still blacklisted
    expect(giver.find({ now: 10_200 }, world)).not.toBeNull()
  })

  it('does not re-acquire a dead entity still present in the snapshot', () => {
    const giver = createThreatFightGiver(() => fightPolicy())
    const world = flatWorld({ entities: [entity('zombie')] })
    expect(giver.find({ now: 0 }, world)).not.toBeNull()
    giver.noteTerminal({ keys: 'threat.fight:id-zombie', at: 100, state: 'succeeded' })
    expect(giver.find({ now: 1_000 }, world)).toBeNull()
  })
})

describe('self-care givers', () => {
  it('eats when hungry, a food item exists and there is no danger', () => {
    const giver = createSelfEatGiver(() => fightPolicy())
    const result = asCandidate(giver.find({ now: 0 }, flatWorld({
      self: { food: 10 },
      inventory: [{ slot: 36, name: 'bread', count: 2 }],
    })))
    expect(result).toMatchObject({ driverId: 'use', params: { item: 'bread' }, keys: 'self:eat:bread' })
  })

  it('does not eat when full, disabled or in danger', () => {
    const giver = createSelfEatGiver(() => fightPolicy())
    expect(giver.find({ now: 0 }, flatWorld({
      self: { food: 20 },
      inventory: [{ slot: 36, name: 'bread', count: 2 }],
    }))).toBeNull()
    const disabled = fightPolicy()
    disabled.selfCare.eat.enabled = false
    expect(createSelfEatGiver(() => disabled).find({ now: 0 }, flatWorld({
      self: { food: 10 }, inventory: [{ slot: 36, name: 'bread', count: 2 }],
    }))).toBeNull()
    expect(giver.find({ now: 0 }, flatWorld({
      self: { food: 10 },
      inventory: [{ slot: 36, name: 'bread', count: 2 }],
      entities: [entity('zombie')],
    }))).toBeNull()
  })

  it('moves a bounded distance after a recent GOTO_STUCK, without unstickDig', () => {
    const giver = createSelfUnstuckGiver(() => fightPolicy())
    const candidate = asCandidate(giver.find({ now: 1_000, lastStuckAt: 900 }, flatWorld()))
    expect(candidate.driverId).toBe('move')
    expect(candidate.keys.startsWith('self:unstuck:')).toBe(true)
    expect(candidate.params.range).toBe(0)
    expect(candidate.params.unstickDig).toBeUndefined()
  })

  it('does not unstuck during an explicit attack or after the recent window', () => {
    const giver = createSelfUnstuckGiver(() => fightPolicy())
    expect(giver.find({ now: 1_000, lastStuckAt: 900, orderVerb: 'attack' }, flatWorld())).toBeNull()
    expect(giver.find({ now: 20_000, lastStuckAt: 900 }, flatWorld())).toBeNull()
  })

  it('reports SELF_STUCK when no nearby stand cell exists', () => {
    const giver = createSelfUnstuckGiver(() => fightPolicy())
    expect(giver.find({ now: 1_000, lastStuckAt: 900 }, flatWorld({ blocks: false })))
      .toMatchObject({ kind: 'hold', reason: 'SELF_STUCK', notify: true })
  })
})
