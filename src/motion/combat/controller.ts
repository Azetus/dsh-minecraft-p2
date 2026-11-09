import type { Vec3 } from '../model/types.ts'
import { attackCooldownMs } from './cooldown.ts'
import { CombatEvidence } from './evidence.ts'
import { eyeReach } from './geometry.ts'

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
  health?: number
  width?: number
  height?: number
}

/**
 * The controller's dependency boundary. It is deliberately narrower than
 * ClientPort so the melee loop is pure and testable; the driver wires it to the
 * real port.
 */
export type CombatPort = {
  now(): number
  self(): { pos: Vec3; health: number; height?: number }
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
  /** Explicit Agent order: no P2-side player/passive protection filter. */
  allowAny?: boolean
  /** Deprecated compatibility flag for passive/neutral targets. */
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
    rejectedSwings: number
    lostReason?: string
    targetHealth?: number
  }
}

const DEFAULT_REACH = 3
const DEFAULT_MAX_CHASES = 12
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
  let rejectedSwings = 0
  let lastAttackAt: number | undefined
  let cooldown = attackCooldownMs(port.attackSpeed())

  try {
    while (port.now() - startedAt < totalMs && evidence.attacksIssued < maxAttacks) {
      const check = await inspect(port, targetId, options, evidence)
      if (check.kind === 'dead') break
      if (check.kind === 'changed') {
        return fail('ATTACK_TARGET_CHANGED', evidence, targetId, options, chases, cooldown, rejectedSwings, 'target-name-changed')
      }
      if (check.kind === 'lost') {
        evidence.lost()
        return fail('ATTACK_TARGET_LOST', evidence, targetId, options, chases, cooldown, rejectedSwings, 'left-query-range')
      }
      if (check.kind === 'protected') {
        return fail(check.code, evidence, targetId, options, chases, cooldown, rejectedSwings, 'protected')
      }
      if (check.distance > reach) {
        if (chases >= maxChases) return fail('ATTACK_CHASE_LIMIT', evidence, targetId, options, chases, cooldown, rejectedSwings, 'chase-limit')
        const moved = await port.moveTo(check.entity.position, Math.max(1.5, reach - 1), chaseTimeoutMs)
        chases += 1
        if (moved.state !== 'ok') {
          misses += 1
          if (misses >= maxMisses) return fail('ATTACK_NO_APPROACH', evidence, targetId, options, chases, cooldown, rejectedSwings, 'approach-failed')
          await sleep(100)
        }
        continue
      }
      if (!check.visible) {
        misses += 1
        if (misses >= maxMisses) return fail('ATTACK_NO_LINE_OF_SIGHT', evidence, targetId, options, chases, cooldown, rejectedSwings, 'no-line-of-sight')
        await sleep(100)
        continue
      }

      cooldown = attackCooldownMs(port.attackSpeed())
      if (lastAttackAt !== undefined) {
        const wait = cooldown - (port.now() - lastAttackAt)
        if (wait > 0) await sleep(wait)
      }

      // Re-read after the wait: the target may have moved, died, or become
      // obscured. Never swing on the pre-wait snapshot.
      const fresh = await inspect(port, targetId, options, evidence)
      if (fresh.kind === 'dead') break
      if (fresh.kind === 'changed') {
        return fail('ATTACK_TARGET_CHANGED', evidence, targetId, options, chases, cooldown, rejectedSwings, 'target-name-changed')
      }
      if (fresh.kind === 'lost') {
        evidence.lost()
        return fail('ATTACK_TARGET_LOST', evidence, targetId, options, chases, cooldown, rejectedSwings, 'left-query-range')
      }
      if (fresh.kind === 'protected') {
        return fail(fresh.code, evidence, targetId, options, chases, cooldown, rejectedSwings, 'protected')
      }
      if (fresh.distance > reach) {
        rejectedSwings += 1
        continue
      }
      if (!fresh.visible) {
        rejectedSwings += 1
        misses += 1
        if (misses >= maxMisses) return fail('ATTACK_NO_LINE_OF_SIGHT', evidence, targetId, options, chases, cooldown, rejectedSwings, 'no-line-of-sight')
        continue
      }

      const hit = await port.attack(targetId)
      lastAttackAt = port.now()
      if (hit.state === 'ok') {
        evidence.attacksIssued += 1
        misses = 0
      } else {
        misses += 1
        if (misses >= maxMisses) return fail('ATTACK_NO_HIT', evidence, targetId, options, chases, cooldown, rejectedSwings, hit.code ?? 'attack-failed')
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
      observed: snapshot(evidence, targetId, options, chases, cooldown, rejectedSwings),
    }
  }
  if (port.entity(targetId) === undefined) {
    evidence.lost()
    return fail('ATTACK_TARGET_LOST', evidence, targetId, options, chases, cooldown, rejectedSwings, 'left-query-range')
  }
  return fail('ATTACK_NOT_KILLED', evidence, targetId, options, chases, cooldown, rejectedSwings, 'limit-reached')
}

type InspectResult =
  | { kind: 'ok'; entity: CombatEntity; distance: number; visible: boolean }
  | { kind: 'dead' }
  | { kind: 'lost' }
  | { kind: 'changed' }
  | { kind: 'protected'; code: string }

/**
 * One fresh read of the locked target. The death evidence is checked before
 * the entity query so a death event that lands one tick after the entity
 * leaves the query box keeps the existing 400ms grace instead of becoming a
 * false `lost`.
 */
async function inspect(
  port: CombatPort,
  targetId: string,
  options: MeleeOptions,
  evidence: CombatEvidence,
): Promise<InspectResult> {
  if (evidence.deathConfirmed) return { kind: 'dead' }
  const target = port.entity(targetId)
  if (target === undefined) {
    await sleep(400)
    if (evidence.deathConfirmed) return { kind: 'dead' }
    return { kind: 'lost' }
  }
  if (options.targetName !== undefined && target.name !== options.targetName) return { kind: 'changed' }
  if (typeof target.health === 'number') evidence.targetHealth = target.health
  const guard = guardTarget(target, options)
  if (guard !== undefined) return { kind: 'protected', code: guard }
  const self = port.self()
  return {
    kind: 'ok',
    entity: target,
    distance: eyeReach(self, target),
    visible: port.canSee(targetId),
  }
}

function guardTarget(target: CombatEntity, options: MeleeOptions): string | undefined {
  if (options.allowAny === true) return undefined
  if (target.type === 'player') return 'ATTACK_TARGET_PROTECTED'
  if (/passive|neutral|tameable/i.test(target.kind ?? '') && options.allowPassive !== true) {
    return 'ATTACK_TARGET_PROTECTED'
  }
  return undefined
}

function fail(
  code: string,
  evidence: CombatEvidence,
  targetId: string,
  options: MeleeOptions,
  chases: number,
  cooldown: number,
  rejectedSwings: number,
  lostReason: string,
): MeleeResult {
  return {
    state: 'failed',
    code,
    observed: {
      ...snapshot(evidence, targetId, options, chases, cooldown, rejectedSwings),
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
  rejectedSwings: number,
): MeleeResult['observed'] {
  return {
    kind: 'attack',
    entityId: targetId,
    ...(options.targetName === undefined ? {} : { targetName: options.targetName }),
    attacks: evidence.attacksIssued,
    ...evidence.snapshot(),
    ...(evidence.targetHealth === undefined ? {} : { targetHealth: evidence.targetHealth }),
    chases,
    cooldownMs: cooldown,
    rejectedSwings,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
