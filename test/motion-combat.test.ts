/**
 * Category: data (pure geometry/cooldown/evidence) + state safety (pre-swing
 * recheck). Protects: docs/CONTRACTS.md attack 段 (reach/recheck/rejectedSwings)
 * and docs/runtime/MOTION.md §7.1. Failure modes: reach measured from the feet
 * instead of the eye to the target AABB; a stale target is attacked after the
 * cooldown wait. Live combat evidence is collected on the real server; these
 * tests only protect the pure mapping and the bounded controller decisions.
 */
import { describe, expect, it } from 'vitest'

import {
  attackCooldownMs,
  CombatEvidence,
  entityBox,
  eyeHeight,
  eyeReach,
  runMeleeCombat,
  type CombatAction,
  type CombatEntity,
  type CombatPort,
} from '../src/motion/combat/index.ts'
import type { Vec3 } from '../src/motion/model/types.ts'

const pos = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

describe('combat geometry', () => {
  it('derives the player eye height from the AABB height', () => {
    expect(eyeHeight({ height: 1.8 })).toBeCloseTo(1.62)
    expect(eyeHeight({})).toBeCloseTo(1.62)
    expect(eyeHeight({ height: 2.9 })).toBeCloseTo(2.72)
  })

  it('builds the entity AABB at feet position', () => {
    expect(entityBox({ position: pos(3.5, 65, 10.5), width: 0.6, height: 1.95 })).toEqual({
      min: pos(3.2, 65, 10.2),
      max: pos(3.8, 66.95, 10.8),
    })
    expect(entityBox({ position: pos(0, 64, 0) })).toEqual({
      min: pos(-0.3, 64, -0.3),
      max: pos(0.3, 65.8, 0.3),
    })
    expect(entityBox({ position: pos(0, 64, 0), width: 1, height: 3 })).toEqual({
      min: pos(-0.5, 64, -0.5),
      max: pos(0.5, 67, 0.5),
    })
  })

  it('measures eye to target AABB (the 2026-11-08 probe: feet 3.0 -> 2.7)', () => {
    const self = { pos: pos(0.5, 65, 10.5), height: 1.8 }
    const zombie = { position: pos(3.5, 65, 10.5), width: 0.6, height: 1.95 }
    expect(eyeReach(self, zombie)).toBeCloseTo(2.7)
    expect(eyeReach(self, { ...zombie, position: pos(3.6, 65, 10.5) })).toBeCloseTo(2.8)
    expect(eyeReach(self, { ...zombie, position: pos(-2.5, 65, 10.5) })).toBeCloseTo(2.7)
  })

  it('returns 0 when the eye point is inside the AABB and falls back to the player box', () => {
    const self = { pos: pos(0.5, 64, 0.5), height: 1.8 }
    expect(eyeReach(self, { position: pos(0.5, 64, 0.5), width: 0.6, height: 1.8 })).toBe(0)
    expect(eyeReach({ pos: pos(0, 64, 0) }, { position: pos(3, 64, 0) })).toBeCloseTo(2.7)
  })
})

describe('attack cooldown', () => {
  it('derives milliseconds from attacks per second', () => {
    expect(attackCooldownMs(1.6)).toBe(625)
    expect(attackCooldownMs(0.8)).toBe(1_250)
    expect(attackCooldownMs(4)).toBe(250)
    expect(attackCooldownMs(undefined)).toBe(250)
    expect(attackCooldownMs(0)).toBe(250)
    expect(attackCooldownMs(0.1)).toBe(2_000)
  })
})

describe('CombatEvidence', () => {
  it('counts only the locked target and never equates loss with death', () => {
    const evidence = new CombatEvidence()
    evidence.hurt('other', 'z1', 1)
    expect(evidence.damageObserved).toBe(0)
    evidence.hurt('z1', 'z1', 2)
    expect(evidence.damageObserved).toBe(1)
    evidence.lost()
    expect(evidence.snapshot()).toMatchObject({ killed: false, targetLost: true, deathConfirmed: false })
    evidence.dead('z1', 'z1', 3)
    expect(evidence.snapshot()).toMatchObject({ killed: true, deathConfirmed: true })
  })
})

type CombatEmit = {
  hurt(entityId: string): void
  dead(entityId: string): void
}

function fakeCombatPort(options: {
  target: () => CombatEntity | undefined
  self?: () => { pos: Vec3; health: number; height?: number }
  canSee?: (calls: number) => boolean
  attackSpeed?: () => number
  attack?: (emit: CombatEmit) => Promise<CombatAction>
  moveTo?: () => Promise<CombatAction>
  lookAt?: (pos: Vec3) => Promise<CombatAction>
  hasShield?: () => boolean
  shield?: (durationMs: number) => Promise<CombatAction>
}): {
  port: CombatPort
  attacks: () => number
  moves: () => number
  lookAtPoints: () => Vec3[]
  shieldDurations: () => number[]
} {
  let attacks = 0
  let moves = 0
  let canSeeCalls = 0
  const lookAtPoints: Vec3[] = []
  const shieldDurations: number[] = []
  const hurtListeners: Array<(entityId: string) => void> = []
  const deadListeners: Array<(entityId: string) => void> = []
  const emit: CombatEmit = {
    hurt: entityId => { for (const cb of hurtListeners) cb(entityId) },
    dead: entityId => { for (const cb of deadListeners) cb(entityId) },
  }
  const port: CombatPort = {
    now: () => Date.now(),
    self: options.self ?? (() => ({ pos: pos(0.5, 64, 0.5), health: 20 })),
    entity: () => options.target(),
    canSee: () => {
      canSeeCalls += 1
      return options.canSee?.(canSeeCalls) ?? true
    },
    attackSpeed: options.attackSpeed ?? (() => 4),
    attack: async () => {
      attacks += 1
      return options.attack?.(emit) ?? { state: 'ok' }
    },
    moveTo: async () => {
      moves += 1
      return options.moveTo?.() ?? { state: 'ok' }
    },
    ...(options.hasShield === undefined ? {} : { hasShield: options.hasShield }),
    ...(options.lookAt === undefined
      ? {}
      : {
          lookAt: async (point: Vec3) => {
            lookAtPoints.push(point)
            return options.lookAt!(point)
          },
        }),
    ...(options.shield === undefined
      ? {}
      : {
          shield: async (durationMs: number) => {
            shieldDurations.push(durationMs)
            return options.shield!(durationMs)
          },
        }),
    onEntityHurt: cb => {
      hurtListeners.push(cb)
      return () => {}
    },
    onEntityDead: cb => {
      deadListeners.push(cb)
      return () => {}
    },
  }
  return {
    port,
    attacks: () => attacks,
    moves: () => moves,
    lookAtPoints: () => lookAtPoints,
    shieldDurations: () => shieldDurations,
  }
}

describe('melee controller pre-swing recheck', () => {
  it('does not swing when the target moves out of reach during the cooldown wait', async () => {
    let moved = false
    const fake = fakeCombatPort({
      target: () => ({
        id: 'z1',
        name: 'zombie',
        position: moved ? pos(6, 64, 0.5) : pos(1, 64, 0.5),
        width: 0.6,
        height: 1.8,
      }),
      attackSpeed: () => 0.5, // 2000ms, enough room to move during the wait
      attack: async () => {
        setTimeout(() => { moved = true }, 1_000)
        return { state: 'ok' }
      },
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxChases: 1 })
    expect(fake.attacks()).toBe(1)
    expect(result).toMatchObject({
      state: 'failed',
      code: 'ATTACK_CHASE_LIMIT',
      observed: { attacksIssued: 1, rejectedSwings: 1, chases: 1 },
    })
  })

  it('does not swing when the target becomes invisible during the cooldown wait', async () => {
    const fake = fakeCombatPort({
      target: () => ({
        id: 'z1',
        name: 'zombie',
        position: pos(1, 64, 0.5),
        width: 0.6,
        height: 1.8,
      }),
      canSee: calls => calls === 1, // visible at the top, hidden before the swing
    })
    const result = await runMeleeCombat(fake.port, 'z1')
    expect(fake.attacks()).toBe(0)
    expect(result).toMatchObject({
      state: 'failed',
      code: 'ATTACK_NO_LINE_OF_SIGHT',
      observed: { attacksIssued: 0, rejectedSwings: 1 },
    })
  })

  it('does not swing again when the target dies during the cooldown wait', async () => {
    const fake = fakeCombatPort({
      target: () => ({
        id: 'z1',
        name: 'zombie',
        position: pos(1, 64, 0.5),
        width: 0.6,
        height: 1.8,
      }),
      attackSpeed: () => 0.5,
      attack: async emit => {
        setTimeout(() => emit.dead('z1'), 1_000)
        return { state: 'ok' }
      },
    })
    const result = await runMeleeCombat(fake.port, 'z1')
    expect(fake.attacks()).toBe(1)
    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { attacksIssued: 1, killed: true, deathConfirmed: true, rejectedSwings: 0 },
    })
  })
})

describe('melee controller shield window', () => {
  const target = (): CombatEntity => ({
    id: 'z1',
    name: 'zombie',
    position: pos(1, 64, 0.5),
    width: 0.6,
    height: 1.95,
  })

  it('holds the shield during the cooldown wait and faces before the swing', async () => {
    let hits = 0
    const calls: string[] = []
    const fake = fakeCombatPort({
      target,
      attackSpeed: () => 2, // 500ms
      hasShield: () => true,
      lookAt: async () => {
        calls.push('lookAt')
        return { state: 'ok' }
      },
      shield: async durationMs => {
        calls.push(`shield:${durationMs}`)
        await new Promise(resolve => setTimeout(resolve, durationMs))
        return { state: 'ok' }
      },
      attack: async emit => {
        hits += 1
        calls.push('attack')
        if (hits === 2) emit.dead('z1')
        return { state: 'ok' }
      },
    })
    const result = await runMeleeCombat(fake.port, 'z1')
    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { attacksIssued: 2, shieldUses: 1, shieldFailures: 0 },
    })
    expect(calls[0]).toBe('lookAt')
    expect(fake.shieldDurations()).toHaveLength(1)
    expect(fake.shieldDurations()[0]).toBeGreaterThanOrEqual(250)
    expect(fake.shieldDurations()[0]).toBeLessThanOrEqual(600)
    expect(fake.lookAtPoints()[0]).toMatchObject({ x: 1, y: 65.4, z: 0.5 })
  })

  it('does not raise a shield when no shield is present', async () => {
    const fake = fakeCombatPort({
      target,
      attackSpeed: () => 2,
      hasShield: () => false,
      lookAt: async () => {
        throw new Error('lookAt must not be called')
      },
      shield: async () => {
        throw new Error('shield must not be called')
      },
      attack: async emit => {
        emit.dead('z1')
        return { state: 'ok' }
      },
    })
    const result = await runMeleeCombat(fake.port, 'z1')
    expect(result).toMatchObject({ state: 'succeeded', observed: { shieldUses: 0, shieldFailures: 0 } })
    expect(fake.shieldDurations()).toHaveLength(0)
  })

  it('does not raise a shield when the wait is shorter than 250ms', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target,
      attackSpeed: () => 4, // 250ms cooldown -> ~130ms wait after the 120ms evidence sleep
      hasShield: () => true,
      lookAt: async () => ({ state: 'ok' }),
      shield: async () => ({ state: 'ok' }),
      attack: async emit => {
        hits += 1
        if (hits === 2) emit.dead('z1')
        return { state: 'ok' }
      },
    })
    const result = await runMeleeCombat(fake.port, 'z1')
    expect(result).toMatchObject({ state: 'succeeded', observed: { shieldUses: 0, shieldFailures: 0 } })
    expect(fake.shieldDurations()).toHaveLength(0)
  })

  it('disables the shield for the engagement after a useItem failure', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target,
      attackSpeed: () => 2,
      hasShield: () => true,
      lookAt: async () => ({ state: 'ok' }),
      shield: async () => ({ state: 'failed', code: 'USE_NO_ITEM' }),
      attack: async emit => {
        hits += 1
        if (hits === 2) emit.dead('z1')
        return { state: 'ok' }
      },
    })
    const result = await runMeleeCombat(fake.port, 'z1')
    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { attacksIssued: 2, shieldUses: 0, shieldFailures: 1 },
    })
    expect(fake.shieldDurations()).toHaveLength(1)
  })

  it('skips the shield (without evidence) when lookAt fails', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target,
      attackSpeed: () => 2,
      hasShield: () => true,
      lookAt: async () => ({ state: 'failed', code: 'LOOKAT_FAILED' }),
      shield: async () => ({ state: 'ok' }),
      attack: async emit => {
        hits += 1
        if (hits === 2) emit.dead('z1')
        return { state: 'ok' }
      },
    })
    const result = await runMeleeCombat(fake.port, 'z1')
    expect(result).toMatchObject({
      state: 'succeeded',
      observed: { attacksIssued: 2, shieldUses: 0, shieldFailures: 0 },
    })
    expect(fake.shieldDurations()).toHaveLength(0)
  })
})
