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
  decideCombatMove,
  engageBand,
  entityBox,
  eyeHeight,
  eyeReach,
  runMeleeCombat,
  tooCloseFor,
  type CombatAction,
  type CombatEntity,
  type CombatMoveInput,
  type CombatPort,
  type CombatStandCell,
  type CombatStandQuery,
  type CombatStepOptions,
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

describe('combat spacing decision', () => {
  const band = engageBand(3)
  const input = (overrides: Partial<CombatMoveInput> = {}): CombatMoveInput => ({
    distance: 2.5,
    band,
    tooClose: tooCloseFor(3),
    visible: true,
    recentlyHurt: false,
    stalled: false,
    strafeEnabled: true,
    side: 'left',
    ...overrides,
  })

  it('derives the band and too-close threshold from the current reach', () => {
    const atThree = engageBand(3)
    expect(atThree.min).toBeCloseTo(2.2)
    expect(atThree.desired).toBeCloseTo(2.5)
    expect(atThree.max).toBeCloseTo(2.8)
    const atFour = engageBand(4)
    expect(atFour.min).toBeCloseTo(3.2)
    expect(atFour.desired).toBeCloseTo(3.5)
    expect(atFour.max).toBeCloseTo(3.8)
    expect(tooCloseFor(3)).toBeCloseTo(1.6)
    expect(tooCloseFor(4)).toBeCloseTo(2.6)
    const clampedLow = engageBand(0.5)
    expect(clampedLow.min).toBeCloseTo(0.7)
    expect(clampedLow.max).toBeCloseTo(1.3)
    const clampedHigh = engageBand(10)
    expect(clampedHigh.min).toBeCloseTo(5.2)
    expect(clampedHigh.max).toBeCloseTo(5.8)
  })

  it('holds when the target is not visible, even when too close or hurt', () => {
    expect(decideCombatMove(input({ distance: 1, recentlyHurt: true, visible: false }))).toBe('hold')
  })

  it('backs off below tooClose', () => {
    expect(decideCombatMove(input({ distance: 1.5 }))).toBe('backoff')
  })

  it('holds in the dead zone instead of oscillating', () => {
    expect(decideCombatMove(input({ distance: 2.0 }))).toBe('hold')
  })

  it('backs off to the band edge when hurt inside the band', () => {
    expect(decideCombatMove(input({ distance: 2.4, recentlyHurt: true }))).toBe('backoff')
  })

  it('does not back off when hurt at the band edge', () => {
    expect(decideCombatMove(input({ distance: 2.8, recentlyHurt: true }))).toBe('strafe-left')
    expect(decideCombatMove(input({ distance: 2.8, recentlyHurt: true, strafeEnabled: false }))).toBe('hold')
  })

  it('approaches when outside the band but still inside reach', () => {
    expect(decideCombatMove(input({ distance: 2.9 }))).toBe('approach')
  })

  it('strafes inside the band and follows the supplied side', () => {
    expect(decideCombatMove(input())).toBe('strafe-left')
    expect(decideCombatMove(input({ side: 'right' }))).toBe('strafe-right')
    expect(decideCombatMove(input({ strafeEnabled: false }))).toBe('hold')
  })

  it('stops strafing when movement is stalled but still allows safety backoff', () => {
    expect(decideCombatMove(input({ stalled: true }))).toBe('hold')
    expect(decideCombatMove(input({ stalled: true, distance: 1.4 }))).toBe('backoff')
  })

  it('treats the band edges as inside the band', () => {
    expect(decideCombatMove(input({ distance: 2.2 }))).toBe('strafe-left')
    expect(decideCombatMove(input({ distance: 2.8 }))).toBe('strafe-left')
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
  moveTo?: (pos: Vec3, range: number, timeoutMs: number) => Promise<CombatAction>
  combatStep?: (opts: CombatStepOptions) => Promise<CombatAction>
  standCells?: (query: CombatStandQuery) => CombatStandCell[]
  reach?: () => number
  lookAt?: (pos: Vec3) => Promise<CombatAction>
  hasShield?: () => boolean
  shield?: (durationMs: number) => Promise<CombatAction>
}): {
  port: CombatPort
  attacks: () => number
  moves: () => number
  moveTargets: () => Array<{ pos: Vec3; range: number; timeoutMs: number }>
  stepCalls: () => CombatStepOptions[]
  lookAtPoints: () => Vec3[]
  shieldDurations: () => number[]
} {
  let attacks = 0
  let moves = 0
  let canSeeCalls = 0
  const moveTargets: Array<{ pos: Vec3; range: number; timeoutMs: number }> = []
  const stepCalls: CombatStepOptions[] = []
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
    moveTo: async (target, range, timeoutMs) => {
      moves += 1
      moveTargets.push({ pos: target, range, timeoutMs })
      return options.moveTo?.(target, range, timeoutMs) ?? { state: 'ok' }
    },
    ...(options.reach === undefined ? {} : { reach: options.reach }),
    ...(options.combatStep === undefined
      ? {}
      : {
          combatStep: async (step: CombatStepOptions) => {
            stepCalls.push(step)
            return options.combatStep!(step)
          },
        }),
    ...(options.standCells === undefined ? {} : { standCells: options.standCells }),
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
    moveTargets: () => moveTargets,
    stepCalls: () => stepCalls,
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

describe('melee controller spacing movement (A-step)', () => {
  const zombie = (x: number, yaw?: number): CombatEntity => ({
    id: 'z1',
    name: 'zombie',
    position: pos(x, 64, 0.5),
    width: 0.6,
    height: 1.95,
    ...(yaw === undefined ? {} : { yaw }),
  })
  const cell = (x: number, z: number, y = 64): CombatStandCell => ({
    cell: pos(x, y, z),
    feetY: y,
    distance: 1,
    reachable: 'yes',
  })
  const stepOk = async (opts: CombatStepOptions): Promise<CombatAction> => ({
    state: 'ok',
    ...(opts.shield === true ? { shieldUsed: true } : {}),
  })

  it('takes one adjacent step with fixed facing and then attacks', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target: () => zombie(3.3),
      attackSpeed: () => 1.6,
      attack: async emit => {
        hits += 1
        if (hits >= 2) emit.dead('z1')
        return { state: 'ok' }
      },
      standCells: () => [cell(0, 1)],
      combatStep: stepOk,
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
    expect(result.state).toBe('succeeded')
    expect(fake.stepCalls()).toHaveLength(1)
    expect(fake.stepCalls()[0]).toMatchObject({
      cell: { x: 0, y: 64, z: 1 },
      shield: false,
      timeoutMs: 600,
    })
    expect(fake.stepCalls()[0]!.face).toMatchObject({ x: 3.3, z: 0.5 })
    expect(fake.moveTargets()).toHaveLength(0)
    expect(result.observed).toMatchObject({
      combatMoves: 1,
      strafeMoves: 1,
      backoffMoves: 0,
      shieldedSteps: 0,
      moveFailures: 0,
      noSafeCell: 0,
      reach: 3,
      reachSource: 'default',
    })
  })

  it('keeps attacking from where it stands when no safe cell exists', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target: () => zombie(3.3),
      attackSpeed: () => 1.6,
      attack: async emit => {
        hits += 1
        if (hits >= 2) emit.dead('z1')
        return { state: 'ok' }
      },
      standCells: () => [],
      combatStep: stepOk,
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
    expect(result.state).toBe('succeeded')
    expect(fake.stepCalls()).toHaveLength(0)
    expect(result.observed).toMatchObject({ combatMoves: 0, noSafeCell: 1, moveFailures: 0 })
  })

  it('keeps attacking when the step fails and never turns it into a job failure', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target: () => zombie(3.3),
      attackSpeed: () => 1.6,
      attack: async emit => {
        hits += 1
        if (hits >= 2) emit.dead('z1')
        return { state: 'ok' }
      },
      standCells: () => [cell(0, 1)],
      combatStep: async () => ({ state: 'failed', code: 'COMBAT_STEP_NO_PROGRESS' }),
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
    expect(result.state).toBe('succeeded')
    expect(result.observed).toMatchObject({
      combatMoves: 1,
      moveFailures: 1,
      stepBlocked: 1,
    })
  })

  it('does not step when the target is not visible', async () => {
    const fake = fakeCombatPort({
      target: () => zombie(3.3),
      canSee: () => false,
      attackSpeed: () => 1.6,
      standCells: () => [cell(0, 1)],
      combatStep: stepOk,
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxMisses: 1 })
    expect(result).toMatchObject({ state: 'failed', code: 'ATTACK_NO_LINE_OF_SIGHT' })
    expect(fake.stepCalls()).toHaveLength(0)
  })

  it('does not start a step that would run past the next swing', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target: () => zombie(3.3),
      attackSpeed: () => 4, // 250ms cooldown; estimate+margin is 350ms
      attack: async emit => {
        hits += 1
        if (hits >= 2) emit.dead('z1')
        return { state: 'ok' }
      },
      standCells: () => [cell(0, 1)],
      combatStep: stepOk,
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
    expect(result.state).toBe('succeeded')
    expect(fake.stepCalls()).toHaveLength(0)
    expect(result.observed).toMatchObject({ combatMoves: 0 })
  })

  it('reports target loss that happens during a step', async () => {
    let alive = true
    const fake = fakeCombatPort({
      target: () => (alive ? zombie(3.3) : undefined),
      attackSpeed: () => 1.6,
      standCells: () => [cell(0, 1)],
      combatStep: async () => {
        alive = false
        return { state: 'ok' }
      },
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
    expect(result).toMatchObject({ state: 'failed', code: 'ATTACK_TARGET_LOST' })
    expect(fake.stepCalls()).toHaveLength(1)
  })

  it('backs off to the band edge when the target is too close', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target: () => zombie(1.0),
      attackSpeed: () => 1.6,
      attack: async emit => {
        hits += 1
        if (hits >= 2) emit.dead('z1')
        return { state: 'ok' }
      },
      standCells: () => [cell(0, 1)],
      combatStep: stepOk,
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
    expect(result.state).toBe('succeeded')
    expect(result.observed).toMatchObject({ combatMoves: 1, backoffMoves: 1, strafeMoves: 0 })
  })

  it('raises the step shield only when the target faces us and is close', async () => {
    const runCase = async (x: number, yaw: number | undefined, expected: boolean): Promise<void> => {
      let hits = 0
      const fake = fakeCombatPort({
        target: () => zombie(x, yaw),
        attackSpeed: () => 1.6,
        hasShield: () => true,
        attack: async emit => {
          hits += 1
          if (hits >= 2) emit.dead('z1')
          return { state: 'ok' }
        },
        standCells: () => [cell(0, 1)],
        combatStep: stepOk,
      })
      const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
      expect(result.state).toBe('succeeded')
      expect(fake.stepCalls()[0]?.shield).toBe(expected)
      expect(result.observed.shieldedSteps).toBe(expected ? 1 : 0)
    }

    // Target at 3.3 faces west (towards the body) within the 60-degree cone.
    await runCase(3.3, Math.PI / 2, true)
    // Facing east: away from the body.
    await runCase(3.3, -Math.PI / 2, false)
    // No yaw: no shield, full speed.
    await runCase(3.3, undefined, false)
    // Facing us but outside band.desired (eye -> AABB 2.7).
    await runCase(3.5, Math.PI / 2, false)
  })

  it('falls back to C for an up-1 cell', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target: () => zombie(3.3),
      attackSpeed: () => 1.6,
      attack: async emit => {
        hits += 1
        if (hits >= 2) emit.dead('z1')
        return { state: 'ok' }
      },
      standCells: () => [cell(0, 1, 65)],
      combatStep: stepOk,
      moveTo: async () => ({ state: 'ok' }),
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
    expect(result.state).toBe('succeeded')
    expect(fake.stepCalls()).toHaveLength(0)
    expect(fake.moveTargets()).toHaveLength(1)
    expect(result.observed).toMatchObject({
      combatMoves: 1,
      stepFallbacks: 1,
      strafeMoves: 1,
    })
  })

  it('holds when the adapter has no combatStep', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target: () => zombie(3.3),
      attackSpeed: () => 1.6,
      attack: async emit => {
        hits += 1
        if (hits >= 2) emit.dead('z1')
        return { state: 'ok' }
      },
      standCells: () => [cell(0, 1)],
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
    expect(result.state).toBe('succeeded')
    expect(result.observed).toMatchObject({ combatMoves: 0 })
    expect(fake.moveTargets()).toHaveLength(0)
  })

  it('derives the band from the adapter reach attribute', async () => {
    let hits = 0
    const fake = fakeCombatPort({
      target: () => zombie(4.0),
      attackSpeed: () => 1.6,
      reach: () => 4,
      attack: async emit => {
        hits += 1
        if (hits >= 2) emit.dead('z1')
        return { state: 'ok' }
      },
      standCells: () => [cell(0, 1)],
      combatStep: stepOk,
    })
    const result = await runMeleeCombat(fake.port, 'z1', { maxAttacks: 2 })
    expect(result.state).toBe('succeeded')
    expect(result.observed).toMatchObject({ reach: 4, reachSource: 'attribute', combatMoves: 1 })
  })
})
