import type { Vec3 } from '../model/types.ts'
import { attackCooldownMs } from './cooldown.ts'
import {
  clampReach,
  decideCombatMove,
  engageBand,
  tooCloseFor,
  type CombatBand,
  type CombatMove,
} from './decide.ts'
import { CombatEvidence } from './evidence.ts'
import { eyeReach } from './geometry.ts'

export type CombatActionState = 'ok' | 'failed' | 'unknown'

export type CombatAction = {
  state: CombatActionState
  code?: string
  /** Set by `combatStep` when the shield was actually activated. */
  shieldUsed?: boolean
}

export type CombatEntity = {
  id: string
  name: string
  position: Vec3
  /** Entity yaw in radians; absent means the adapter cannot tell. */
  yaw?: number
  type?: string
  kind?: string
  health?: number
  width?: number
  height?: number
}

/** One adjacent-cell step with a fixed facing. */
export type CombatStepOptions = {
  cell: Vec3
  face: Vec3
  shield?: boolean
  timeoutMs?: number
}

/** One standable cell the driver found around the desired point. */
export type CombatStandCell = {
  /** Integer cell; the controller converts it to an exact move target. */
  cell: Vec3
  feetY: number
  /** Distance to the query's desired point, in cell units. */
  distance: number
  reachable: 'yes' | 'no' | 'unknown'
  steps?: number
}

export type CombatStandQuery = {
  /** Desired standing point, world coordinates (feet height). */
  near: Vec3
  /** Business filter; receives the candidate's feet point and feet height. */
  accept: (feet: Vec3, feetY: number) => boolean
}

/**
 * The controller's dependency boundary. It is deliberately narrower than
 * BodyApi so the melee loop is pure and testable; the driver wires it to the
 * real port.
 */
export type CombatPort = {
  now(): number
  self(): { pos: Vec3; health: number; height?: number }
  entity(id: string): CombatEntity | undefined
  canSee(id: string): boolean
  attackSpeed(): number
  /** Effective eye-to-AABB reach from the adapter; absent falls back to 3. */
  reach?(): number
  attack(id: string): Promise<CombatAction>
  moveTo(pos: Vec3, range: number, timeoutMs: number): Promise<CombatAction>
  /**
   * Adjacent-cell combat step with fixed facing. Absent means the adapter has
   * no A-step; callers hold rather than silently falling back to `moveTo`.
   */
  combatStep?(opts: CombatStepOptions): Promise<CombatAction>
  /**
   * Stand cells around a desired point. Absent means the adapter cannot query
   * and Step 2 movement is skipped entirely (old behaviour).
   */
  standCells?(query: CombatStandQuery): CombatStandCell[]
  /** Face the target for the shield/attack; absent means no shield window. */
  lookAt?(pos: Vec3): Promise<CombatAction>
  /** Whether the off hand currently holds a shield. */
  hasShield?(): boolean
  /** Hold the off-hand shield for durationMs before releasing. */
  shield?(durationMs: number): Promise<CombatAction>
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
  /** Test/A-B overrides only; the attack driver never sets these. */
  band?: CombatBand
  tooClose?: number
  strafe?: boolean
  /** false disables all Step 2 movement (A/B stand-still arm). */
  movement?: boolean
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
    shieldUses: number
    shieldFailures: number
    /** Step 2 evidence; movement never changes state/code. */
    combatMoves: number
    moveFailures: number
    noSafeCell: number
    strafeMoves: number
    backoffMoves: number
    /** A-steps where the shield was actually activated. */
    shieldedSteps: number
    /** In-band steps that fell back to the pathfinder (up-1). */
    stepFallbacks: number
    /** A-steps that failed or made no progress. */
    stepBlocked: number
    reach: number
    reachSource: 'attribute' | 'default' | 'override'
    /** Attached by the attack driver, not the controller. */
    shieldAutoEquip?: 'equipped' | 'present' | 'skipped' | 'failed' | 'no-shield'
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
const SHIELD_MIN_MS = 250
const SHIELD_MAX_MS = 600
const MOVE_TIMEOUT_MS = 1_000
/** 40 degrees around the target, so one step stays within a single cell. */
const STRAFE_ANGLE = Math.PI / 4.5
const MOVE_MIN_PROGRESS = 0.3
/** A-step cadence and attack-priority guard (see plan §10.6). */
const STEP_INTERVAL_UNSHIELDED = 250
const STEP_INTERVAL_SHIELDED = 400
const STEP_ESTIMATE_UNSHIELDED = 250
const STEP_ESTIMATE_SHIELDED = 400
const STEP_ATTACK_MARGIN_MS = 100
const STEP_TIMEOUT_UNSHIELDED = 600
const STEP_TIMEOUT_SHIELDED = 900
/** Target-facing cone for the step shield (60 degrees). */
const FACING_CONE = Math.PI / 3
const STALLED_MOVES = 2
const STALLED_ATTACK_WINDOWS = 4
const CELL_BLACKLIST_MS = 3_000
const HURT_WINDOW_MS = 1_500
const BAND_EPSILON = 0.001

/**
 * One locked melee engagement. It never acquires a new target, never reports
 * `killed` without an observed death, and releases its listeners on every exit.
 *
 * Movement is method-level spacing: it keeps the eye-to-AABB distance inside a
 * band derived from the current reach. `backoff` steps out to the band edge; it
 * never leaves the job, the target, or cover. When no safe cell exists the
 * controller keeps fighting from where it stands.
 */
export async function runMeleeCombat(
  port: CombatPort,
  targetId: string,
  options: MeleeOptions = {},
): Promise<MeleeResult> {
  const overrideReach = options.reach
  const rawReach = overrideReach ?? port.reach?.() ?? DEFAULT_REACH
  const reach = Number.isFinite(rawReach) ? clampReach(rawReach) : DEFAULT_REACH
  const reachSource: MeleeResult['observed']['reachSource'] = overrideReach !== undefined
    ? 'override'
    : port.reach !== undefined ? 'attribute' : 'default'
  const band = options.band ?? engageBand(reach)
  const tooClose = options.tooClose ?? tooCloseFor(reach)
  const strafeEnabled = options.strafe !== false
  const movementEnabled = options.movement !== false

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
  const stats: MeleeStats = {
    rejectedSwings: 0,
    shieldUses: 0,
    shieldFailures: 0,
    combatMoves: 0,
    moveFailures: 0,
    noSafeCell: 0,
    strafeMoves: 0,
    backoffMoves: 0,
    shieldedSteps: 0,
    stepFallbacks: 0,
    stepBlocked: 0,
  }
  let shieldDisabled = false
  let lastAttackAt: number | undefined
  let cooldown = attackCooldownMs(port.attackSpeed())

  let lastHealth = port.self().health
  let lastHurtAt: number | undefined
  let lastStepAt: number | undefined
  const cellBlacklist = new Map<string, number>()
  let stalledMoves = 0
  let idleAttackWindows = 0
  let damageAtLastAttack = 0
  let side: 'left' | 'right' = 'left'

  try {
    while (port.now() - startedAt < totalMs && evidence.attacksIssued < maxAttacks) {
      const selfNow = port.self()
      if (selfNow.health < lastHealth) lastHurtAt = port.now()
      lastHealth = selfNow.health
      const recentlyHurt = lastHurtAt !== undefined && port.now() - lastHurtAt <= HURT_WINDOW_MS
      const stalled = stalledMoves >= STALLED_MOVES
        || (idleAttackWindows >= STALLED_ATTACK_WINDOWS && stats.strafeMoves > 0)

      const check = await inspect(port, targetId, options, evidence)
      if (check.kind === 'dead') break
      if (check.kind === 'changed') {
        return fail('ATTACK_TARGET_CHANGED', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'target-name-changed')
      }
      if (check.kind === 'lost') {
        evidence.lost()
        return fail('ATTACK_TARGET_LOST', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'left-query-range')
      }
      if (check.kind === 'protected') {
        return fail(check.code, evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'protected')
      }
      if (check.distance > reach) {
        if (chases >= maxChases) return fail('ATTACK_CHASE_LIMIT', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'chase-limit')
        // Stop at the band mid point, not at a fixed one block inside reach:
        // closest-first pathing otherwise lands at the old ~1.7 spacing.
        const chaseRange = Math.min(8, Math.max(1.5, band.desired + (check.entity.width ?? 0.6) / 2))
        const moved = await port.moveTo(check.entity.position, chaseRange, chaseTimeoutMs)
        chases += 1
        if (moved.state !== 'ok') {
          misses += 1
          if (misses >= maxMisses) return fail('ATTACK_NO_APPROACH', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'approach-failed')
          await sleep(100)
        }
        continue
      }
      if (!check.visible) {
        misses += 1
        if (misses >= maxMisses) return fail('ATTACK_NO_LINE_OF_SIGHT', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'no-line-of-sight')
        await sleep(100)
        continue
      }

      cooldown = attackCooldownMs(port.attackSpeed())
      if (lastAttackAt !== undefined) {
        const wait = cooldown - (port.now() - lastAttackAt)
        if (wait > 0) {
          const decision = decideCombatMove({
            distance: check.distance,
            band,
            tooClose,
            visible: check.visible,
            recentlyHurt,
            stalled,
            strafeEnabled,
            side,
          })
          const now = port.now()
          const strafeDecision = decision === 'strafe-left' || decision === 'strafe-right'
          const targetFacing = targetFacingUs(selfNow.pos, check.entity)
          const stepShield = port.hasShield?.() === true
            && targetFacing
            && check.distance <= band.desired
          const stepInterval = stepShield ? STEP_INTERVAL_SHIELDED : STEP_INTERVAL_UNSHIELDED
          const stepDue = lastStepAt === undefined || now - lastStepAt >= stepInterval
          const estimate = stepShield ? STEP_ESTIMATE_SHIELDED : STEP_ESTIMATE_UNSHIELDED
          // Do not start a step that would run past the next swing.
          const attackSoon = wait < estimate + STEP_ATTACK_MARGIN_MS
          if (movementEnabled && port.standCells !== undefined
            && decision !== 'hold' && stepDue && !attackSoon) {
            const attempt = await tryCombatMove(
              port, check.entity, decision, band, selfNow, stats, cellBlacklist, now, stepShield,
            )
            lastStepAt = now
            if (attempt.outcome === 'moved') {
              if (attempt.progress < MOVE_MIN_PROGRESS) stalledMoves += 1
              else stalledMoves = 0
              if (strafeDecision) side = flipSide(side)
              continue
            }
            // No cell or a failed step: try the other tangent next window and
            // fall through to the shield/sleep path, never fail the job.
            if (strafeDecision) side = flipSide(side)
          }
          if (wait >= SHIELD_MIN_MS && shieldUsable(port, check, shieldDisabled, reach)) {
            const faced = await port.lookAt!(aimPoint(check.entity))
            if (faced.state === 'ok') {
              const shielded = await port.shield!(Math.min(wait, SHIELD_MAX_MS))
              if (shielded.state === 'ok') {
                stats.shieldUses += 1
                continue
              }
              stats.shieldFailures += 1
              shieldDisabled = true
              await sleep(wait)
            } else {
              // Facing failed: skip this shield window, retry next wait.
              await sleep(wait)
            }
          } else {
            await sleep(wait)
          }
        }
      }

      // Re-read after the wait: the target may have moved, died, or become
      // obscured. Never swing on the pre-wait snapshot.
      const fresh = await inspect(port, targetId, options, evidence)
      if (fresh.kind === 'dead') break
      if (fresh.kind === 'changed') {
        return fail('ATTACK_TARGET_CHANGED', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'target-name-changed')
      }
      if (fresh.kind === 'lost') {
        evidence.lost()
        return fail('ATTACK_TARGET_LOST', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'left-query-range')
      }
      if (fresh.kind === 'protected') {
        return fail(fresh.code, evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'protected')
      }
      if (fresh.distance > reach) {
        stats.rejectedSwings += 1
        continue
      }
      if (!fresh.visible) {
        stats.rejectedSwings += 1
        misses += 1
        if (misses >= maxMisses) return fail('ATTACK_NO_LINE_OF_SIGHT', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'no-line-of-sight')
        continue
      }
      if (shieldUsable(port, fresh, shieldDisabled, reach)) {
        // Face the target before the swing; a failure does not cancel the attack.
        await port.lookAt!(aimPoint(fresh.entity))
      }

      const hit = await port.attack(targetId)
      lastAttackAt = port.now()
      if (hit.state === 'ok') {
        evidence.attacksIssued += 1
        misses = 0
        if (evidence.damageObserved === damageAtLastAttack) idleAttackWindows += 1
        else {
          idleAttackWindows = 0
          damageAtLastAttack = evidence.damageObserved
        }
      } else {
        misses += 1
        if (misses >= maxMisses) return fail('ATTACK_NO_HIT', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, hit.code ?? 'attack-failed')
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
      observed: snapshot(evidence, targetId, options, chases, cooldown, stats, reach, reachSource),
    }
  }
  if (port.entity(targetId) === undefined) {
    evidence.lost()
    return fail('ATTACK_TARGET_LOST', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'left-query-range')
  }
  return fail('ATTACK_NOT_KILLED', evidence, targetId, options, chases, cooldown, stats, reach, reachSource, 'limit-reached')
}

type MoveOutcome = 'moved' | 'no-cell' | 'failed'

type MoveAttempt = { outcome: MoveOutcome; progress: number }

/**
 * Pick one cell inside the band and step to it. `backoff` may only land at or
 * below `band.max` (never out of reach); `approach` and `strafe` must land
 * inside the band. No candidate is a normal outcome, not a failure.
 */
async function tryCombatMove(
  port: CombatPort,
  target: CombatEntity,
  decision: CombatMove,
  band: CombatBand,
  self: { pos: Vec3; height?: number },
  stats: MeleeStats,
  blacklist: Map<string, number>,
  now: number,
  stepShield: boolean,
): Promise<MoveAttempt> {
  const point = expectedPoint(target.position, self.pos, decision, band)
  const cells = port.standCells!({
    near: point,
    accept: (feet, feetY) => {
      // Same level, one down, or one up (the up-1 fallback uses C).
      if (feetY < self.pos.y - 1.6 || feetY > self.pos.y + 1.6) return false
      const distance = eyeReach(
        self.height === undefined ? { pos: feet } : { pos: feet, height: self.height },
        target,
      )
      if (decision === 'backoff') return distance <= band.max + BAND_EPSILON
      return distance >= band.min - BAND_EPSILON && distance <= band.max + BAND_EPSILON
    },
  })
  const candidates = cells
    .filter(cell => cell.reachable === 'yes')
    .filter(cell => !isCurrentCell(cell, self.pos))
    .filter(cell => (blacklist.get(cellKey(cell)) ?? 0) <= now)
    .sort((left, right) => left.distance - right.distance
      || (left.steps ?? Number.MAX_SAFE_INTEGER) - (right.steps ?? Number.MAX_SAFE_INTEGER))
  // Prefer a cell the A-step can take; up-1 is only a C fallback.
  const stepCell = candidates.find(cell => cell.feetY <= self.pos.y + 0.6)
  if (stepCell !== undefined) {
    if (port.combatStep === undefined) return { outcome: 'no-cell', progress: 0 }
    const step = await port.combatStep({
      cell: stepCell.cell,
      face: aimPoint(target),
      shield: stepShield,
      timeoutMs: stepShield ? STEP_TIMEOUT_SHIELDED : STEP_TIMEOUT_UNSHIELDED,
    })
    stats.combatMoves += 1
    countMove(decision, stats)
    if (step.state !== 'ok') {
      stats.moveFailures += 1
      stats.stepBlocked += 1
      blacklist.set(cellKey(stepCell), now + CELL_BLACKLIST_MS)
      return { outcome: 'failed', progress: 0 }
    }
    if (step.shieldUsed === true) stats.shieldedSteps += 1
    const after = port.self().pos
    return {
      outcome: 'moved',
      progress: Math.hypot(after.x - self.pos.x, after.z - self.pos.z),
    }
  }
  const fallback = candidates.find(cell => cell.feetY > self.pos.y + 0.6)
  if (fallback !== undefined) {
    const moved = await port.moveTo(
      { x: fallback.cell.x + 0.5, y: fallback.feetY, z: fallback.cell.z + 0.5 },
      0,
      MOVE_TIMEOUT_MS,
    )
    stats.combatMoves += 1
    stats.stepFallbacks += 1
    countMove(decision, stats)
    if (moved.state !== 'ok') {
      stats.moveFailures += 1
      blacklist.set(cellKey(fallback), now + CELL_BLACKLIST_MS)
      return { outcome: 'failed', progress: 0 }
    }
    const after = port.self().pos
    return {
      outcome: 'moved',
      progress: Math.hypot(after.x - self.pos.x, after.z - self.pos.z),
    }
  }
  stats.noSafeCell += 1
  return { outcome: 'no-cell', progress: 0 }
}

function countMove(decision: CombatMove, stats: MeleeStats): void {
  if (decision === 'backoff') stats.backoffMoves += 1
  else if (decision !== 'approach') stats.strafeMoves += 1
}

/** True when the target's 60-degree front cone contains the body. */
function targetFacingUs(self: Vec3, target: CombatEntity): boolean {
  if (typeof target.yaw !== 'number' || !Number.isFinite(target.yaw)) return false
  const dx = self.x - target.position.x
  const dz = self.z - target.position.z
  const length = Math.hypot(dx, dz)
  if (length < 1e-6) return true
  const lookX = -Math.sin(target.yaw)
  const lookZ = -Math.cos(target.yaw)
  return (lookX * dx + lookZ * dz) / length >= Math.cos(FACING_CONE)
}

/** Point on the ring around the target for this decision. */
function expectedPoint(
  target: Vec3,
  self: Vec3,
  decision: CombatMove,
  band: CombatBand,
): Vec3 {
  let dx = self.x - target.x
  let dz = self.z - target.z
  const length = Math.hypot(dx, dz)
  if (length < 1e-6) {
    dx = 1
    dz = 0
  } else {
    dx /= length
    dz /= length
  }
  const angle = decision === 'strafe-left'
    ? STRAFE_ANGLE
    : decision === 'strafe-right' ? -STRAFE_ANGLE : 0
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rotatedX = dx * cos - dz * sin
  const rotatedZ = dx * sin + dz * cos
  const radius = decision === 'backoff' ? band.max : band.desired
  return {
    x: target.x + rotatedX * radius,
    y: self.y,
    z: target.z + rotatedZ * radius,
  }
}

function isCurrentCell(cell: CombatStandCell, self: Vec3): boolean {
  return cell.cell.x === Math.floor(self.x)
    && cell.cell.z === Math.floor(self.z)
    && Math.abs(cell.feetY - self.y) < 0.1
}

function cellKey(cell: CombatStandCell): string {
  return `${cell.cell.x},${cell.cell.y},${cell.cell.z}`
}

function flipSide(side: 'left' | 'right'): 'left' | 'right' {
  return side === 'left' ? 'right' : 'left'
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

function shieldUsable(
  port: CombatPort,
  check: { distance: number; visible: boolean },
  disabled: boolean,
  reach: number,
): boolean {
  if (disabled) return false
  if (check.distance > reach || !check.visible) return false
  return port.hasShield?.() === true && port.lookAt !== undefined && port.shield !== undefined
}

function aimPoint(entity: CombatEntity): Vec3 {
  return {
    x: entity.position.x,
    y: entity.position.y + Math.min(1.4, (entity.height ?? 1.8) * 0.8),
    z: entity.position.z,
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

type MeleeStats = {
  rejectedSwings: number
  shieldUses: number
  shieldFailures: number
  combatMoves: number
  moveFailures: number
  noSafeCell: number
  strafeMoves: number
  backoffMoves: number
  shieldedSteps: number
  stepFallbacks: number
  stepBlocked: number
}

function fail(
  code: string,
  evidence: CombatEvidence,
  targetId: string,
  options: MeleeOptions,
  chases: number,
  cooldown: number,
  stats: MeleeStats,
  reach: number,
  reachSource: MeleeResult['observed']['reachSource'],
  lostReason: string,
): MeleeResult {
  return {
    state: 'failed',
    code,
    observed: {
      ...snapshot(evidence, targetId, options, chases, cooldown, stats, reach, reachSource),
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
  stats: MeleeStats,
  reach: number,
  reachSource: MeleeResult['observed']['reachSource'],
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
    rejectedSwings: stats.rejectedSwings,
    shieldUses: stats.shieldUses,
    shieldFailures: stats.shieldFailures,
    combatMoves: stats.combatMoves,
    moveFailures: stats.moveFailures,
    noSafeCell: stats.noSafeCell,
    strafeMoves: stats.strafeMoves,
    backoffMoves: stats.backoffMoves,
    shieldedSteps: stats.shieldedSteps,
    stepFallbacks: stats.stepFallbacks,
    stepBlocked: stats.stepBlocked,
    reach,
    reachSource,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
