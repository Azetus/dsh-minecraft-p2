import type { Vec3 } from '../model/types.ts'
import { attackCooldownMs } from './cooldown.ts'
import { CombatEvidence } from './evidence.ts'

export type CombatActionState = 'ok' | 'failed' | 'unknown'

export type CombatAction = {
  state: CombatActionState
  code?: string
}

export type CombatEntity = {
  id: string
  name: string
  position: Vec3
  type?: string
  kind?: string
}

/**
 * The controller's dependency boundary. It is deliberately narrower than
 * ClientPort so the melee loop is pure and testable; the driver wires it to the
 * real port.
 */
export type CombatPort = {
  now(): number
  self(): { pos: Vec3; health: number }
  entity(id: string): CombatEntity | undefined
  canSee(id: string): boolean
  attackSpeed(): number
  attack(id: string): Promise<CombatAction>
  moveTo(pos: Vec3, range: number, timeoutMs: number): Promise<CombatAction>
  onEntityHurt(cb: (entityId: string) => void): () => void
  onEntityDead(cb: (entityId: string) => void): () => void
}

export type MeleeOptions = {
  targetName?: string
  allowPassive?: boolean
  reach?: number
  maxChases?: number
  maxAttacks?: number
  totalMs?: number
  chaseTimeoutMs?: number
  maxMisses?: number
}

export type MeleeResult = {
  state: 'succeeded' | 'failed'
  code?: string
  observed: {
    kind: 'attack'
    entityId: string
    targetName?: string
    attacks: number
    attacksIssued: number
    damageObserved: number
    deathConfirmed: boolean
    targetLost: boolean
    killed: boolean
    chases: number
    cooldownMs: number
    lostReason?: string
  }
}

const DEFAULT_REACH = 3
const DEFAULT_MAX_CHASES = 8
const DEFAULT_MAX_ATTACKS = 24
const DEFAULT_TOTAL_MS = 40_000
const DEFAULT_CHASE_MS = 5_000
const DEFAULT_MAX_MISSES = 6

/**
 * One locked melee engagement. It never acquires a new target, never reports
 * `killed` without an observed death, and releases its listeners on every exit.
 */
export async function runMeleeCombat(
  port: CombatPort,
  targetId: string,
  options: MeleeOptions = {},
): Promise<MeleeResult> {
  const reach = options.reach ?? DEFAULT_REACH
  const maxChases = options.maxChases ?? DEFAULT_MAX_CHASES
  const maxAttacks = options.maxAttacks ?? DEFAULT_MAX_ATTACKS
  const totalMs = options.totalMs ?? DEFAULT_TOTAL_MS
  const chaseTimeoutMs = options.chaseTimeoutMs ?? DEFAULT_CHASE_MS
  const maxMisses = options.maxMisses ?? DEFAULT_MAX_MISSES
  const startedAt = port.now()
  const evidence = new CombatEvidence()
  const offHurt = port.onEntityHurt(id => evidence.hurt(id, targetId, port.now()))
  const offDead = port.onEntityDead(id => evidence.dead(id, targetId, port.now()))
  let chases = 0
  let misses = 0
  let lastAttackAt: number | undefined
  let cooldown = attackCooldownMs(port.attackSpeed())

  try {
    while (port.now() - startedAt < totalMs && evidence.attacksIssued < maxAttacks) {
      if (evidence.deathConfirmed) break
      if (!targetSeen(port, targetId, options)) return fail('ATTACK_TARGET_CHANGED', evidence, targetId, options, chases, cooldown, 'target-name-changed')
      const target = port.entity(targetId)
      if (target === undefined) {
        // A death event can arrive one tick after the entity leaves the query
        // box. Wait for evidence before calling it lost.
        await sleep(400)
        if (evidence.deathConfirmed) break
        evidence.lost()
        return fail('ATTACK_TARGET_LOST', evidence, targetId, options, chases, cooldown, 'left-query-range')
      }
      const guard = guardTarget(target, options)
      if (guard !== undefined) return fail(guard, evidence, targetId, options, chases, cooldown, 'protected')
      const distance = distanceTo(port.self().pos, target.position)
      if (distance > reach) {
        if (chases >= maxChases) return fail('ATTACK_CHASE_LIMIT', evidence, targetId, options, chases, cooldown, 'chase-limit')
        const moved = await port.moveTo(target.position, Math.max(1.5, reach - 1), chaseTimeoutMs)
        chases += 1
        if (moved.state !== 'ok') {
          misses += 1
          if (misses >= maxMisses) return fail('ATTACK_NO_APPROACH', evidence, targetId, options, chases, cooldown, 'approach-failed')
          await sleep(100)
        }
        continue
      }
      if (!port.canSee(targetId)) {
        misses += 1
        if (misses >= maxMisses) return fail('ATTACK_NO_LINE_OF_SIGHT', evidence, targetId, options, chases, cooldown, 'no-line-of-sight')
        await sleep(100)
        continue
      }
      cooldown = attackCooldownMs(port.attackSpeed())
      if (lastAttackAt !== undefined) {
        const wait = cooldown - (port.now() - lastAttackAt)
        if (wait > 0) await sleep(wait)
      }
      const hit = await port.attack(targetId)
      lastAttackAt = port.now()
      if (hit.state === 'ok') {
        evidence.attacksIssued += 1
        misses = 0
      } else {
        misses += 1
        if (misses >= maxMisses) return fail('ATTACK_NO_HIT', evidence, targetId, options, chases, cooldown, hit.code ?? 'attack-failed')
      }
      // Give the server a moment to emit entityHurt/entityDead before the next
      // decision; this is evidence collection, not a fixed attack interval.
      await sleep(120)
    }
  } finally {
    offHurt()
    offDead()
  }

  if (evidence.deathConfirmed) {
    return {
      state: 'succeeded',
      observed: snapshot(evidence, targetId, options, chases, cooldown),
    }
  }
  if (port.entity(targetId) === undefined) {
    evidence.lost()
    return fail('ATTACK_TARGET_LOST', evidence, targetId, options, chases, cooldown, 'left-query-range')
  }
  return fail('ATTACK_NOT_KILLED', evidence, targetId, options, chases, cooldown, 'limit-reached')
}

function targetSeen(port: CombatPort, targetId: string, options: MeleeOptions): boolean {
  if (options.targetName === undefined) return true
  const target = port.entity(targetId)
  return target === undefined || target.name === options.targetName
}

function guardTarget(target: CombatEntity, options: MeleeOptions): string | undefined {
  if (target.type === 'player') return 'ATTACK_TARGET_PROTECTED'
  if (/passive|neutral|tameable/i.test(target.kind ?? '') && options.allowPassive !== true) {
    return 'ATTACK_TARGET_PROTECTED'
  }
  return undefined
}

function distanceTo(self: Vec3, target: Vec3): number {
  return Math.hypot(self.x - target.x, self.y - target.y, self.z - target.z)
}

function fail(
  code: string,
  evidence: CombatEvidence,
  targetId: string,
  options: MeleeOptions,
  chases: number,
  cooldown: number,
  lostReason: string,
): MeleeResult {
  return {
    state: 'failed',
    code,
    observed: {
      ...snapshot(evidence, targetId, options, chases, cooldown),
      lostReason,
    },
  }
}

function snapshot(
  evidence: CombatEvidence,
  targetId: string,
  options: MeleeOptions,
  chases: number,
  cooldown: number,
): MeleeResult['observed'] {
  return {
    kind: 'attack',
    entityId: targetId,
    ...(options.targetName === undefined ? {} : { targetName: options.targetName }),
    attacks: evidence.attacksIssued,
    ...evidence.snapshot(),
    chases,
    cooldownMs: cooldown,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
