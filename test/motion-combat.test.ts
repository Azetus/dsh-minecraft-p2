/**
 * Non-acceptance / 非验收: cooldown and evidence helpers. Live combat evidence
 * is collected on the real server; these tests only protect the pure mapping.
 */
import { describe, expect, it } from 'vitest'

import { attackCooldownMs, CombatEvidence } from '../src/motion/combat/index.ts'

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
