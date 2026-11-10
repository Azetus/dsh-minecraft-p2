import type { Vec3 } from '../model/types.ts'
import { attackCooldownMs } from './cooldown.ts'
import {
  clampReach,
  decideCombatMove,
  engageBand,
  nextStrafeSide,
  tooCloseFor,
  type CombatBand,
  type CombatMove,
} from './decide.ts'
import { DEFAULT_ENTITY_HEIGHT, eyeReach } from './geometry.ts'
import type {
  CombatEntity,
  CombatInput,
  CombatPort,
  MeleeOptions,
  MeleeResult,
} from './types.ts'

const DEFAULT_REACH = 3
const DEFAULT_TOTAL_MS = 40_000
const DEFAULT_MAX_ATTACKS = 24
const DEFAULT_MAX_MISSES = 6
const DEFAULT_GUARD_MS = 1000
const DEFAULT_PRE_SHIELD_RANGE = 12
const STALLED_TICKS = 3
const NO_DAMAGE_WINDOWS = 4
const FACING_CONE = Math.PI / 3
const BLAST_RANGE = 4.5

export type CombatSessionState = 'running' | 'succeeded' | 'failed' | 'interrupted'

/**
 * The one combat implementation: a 50ms tick state machine.
 *
 * Movement and the shield are persistent control states. The session updates
 * them every tick and may attack in the same tick; an attack never stops the
 * movement or drops the shield.
 */
export class CombatSession {
  state: CombatSessionState = 'running'
  private stopRequested = false
  private inFlight = false
  private readonly startedAt: number
  private readonly reach: number
  private readonly band: CombatBand
  private readonly tooClose: number
  private readonly guardMs: number
  private readonly preShieldRange: number
  private readonly shieldSupported: boolean
  private readonly targetIds: string[]
  private currentTargetId: string
  private readonly startOrigin: Vec3
  private readonly chaseLeash: number | undefined
  private readonly deadTargets = new Set<string>()
  private readonly neutralizedTargets = new Set<string>()
  private readonly escapedTargets = new Set<string>()
  private readonly lostTargets = new Set<string>()
  private readonly protectedTargets = new Set<string>()
  private targetSwitches = 0
  private readonly lastSeen = new Map<string, Vec3>()
  private readonly losTicks = new Map<string, number>()
  private readonly lastNavigateAt = new Map<string, number>()
  private threatCount = 0
  private rangedThreat = false
  private explosionThreat = false
  private creeperThreatId: string | undefined
  private lastHealth: number
  private lastHurtAt: number | undefined
  private guarding = false
  private guardWindows = 0
  private guardExits = 0
  private lastAttackAt: number | undefined
  private attacks = 0
  private attacksIssued = 0
  private attacksSinceDamage = 0
  private damageObserved = 0
  private misses = 0
  private side: 'left' | 'right' = 'left'
  private strafeSteps = 0
  private inputTicks = 0
  private inputBlocked = 0
  private inputFailures = 0
  private approachMoves = 0
  private strafeMoves = 0
  private backoffMoves = 0
  private stalledTicks = 0
  private lastPos: Vec3
  private lastMoveWasInput = false
  private detourTicks = 0
  private detourDecision: CombatMove = 'strafe-left'
  private jumpNext = false
  private jumpTried = false
  private waypoints: Vec3[] = []
  private shieldHeld = false
  private shieldFailed = false
  private shieldHeldSince: number | undefined
  private preShieldRaised = false
  private stanceRaises = 0
  private stanceDrops = 0
  private stanceReleaseFailures = 0
  private resultValue: MeleeResult | undefined
  private disposeDead: (() => void) | undefined
  private disposeHurt: (() => void) | undefined
  private disposeExplosion: (() => void) | undefined

  constructor(
    private readonly port: CombatPort,
    targetIdOrIds: string | string[],
    private readonly options: MeleeOptions = {},
  ) {
    this.startedAt = port.now()
    this.lastHealth = port.self().health
    this.lastPos = { ...port.self().pos }
    this.startOrigin = { ...port.self().pos }
    this.chaseLeash = options.chaseLeash
    this.reach = clampReach(options.reach ?? port.reach?.() ?? DEFAULT_REACH)
    this.band = engageBand(this.reach)
    this.tooClose = tooCloseFor(this.reach)
    this.guardMs = Math.max(0, options.guardMs ?? DEFAULT_GUARD_MS)
    this.preShieldRange = Math.max(0, options.preShieldRange ?? DEFAULT_PRE_SHIELD_RANGE)
    this.shieldSupported = options.shield !== false
      && port.offhandHold !== undefined
      && port.hasShield?.() === true
    const requested = Array.isArray(targetIdOrIds) ? targetIdOrIds : [targetIdOrIds]
    this.targetIds = [...new Set([...requested, ...(options.targetIds ?? [])])].filter(id => id.length > 0)
    if (this.targetIds.length === 0) throw new Error('CombatSession requires at least one target')
    this.currentTargetId = this.targetIds[0]!
    this.disposeDead = port.onEntityDead(id => {
      if (!this.targetIds.includes(id)) return
      this.deadTargets.add(id)
      if (this.allTargetsDead()) {
        this.finish('succeeded')
        return
      }
      if (this.finishIfResolved()) return
      if (id === this.currentTargetId) this.advanceTarget()
    })
    this.disposeHurt = port.onEntityHurt(id => {
      if (id !== this.currentTargetId) return
      this.damageObserved += 1
      this.attacksSinceDamage = 0
    })
    this.disposeExplosion = port.onExplosion?.((pos, radius) => {
      const blast = radius === undefined ? 6 : radius + 2
      for (const id of this.targetIds) {
        if (this.deadTargets.has(id) || this.neutralizedTargets.has(id) || this.lostTargets.has(id) || this.protectedTargets.has(id)) continue
        const entity = this.port.entity(id)
        if (entity === undefined || !/creeper/iu.test(entity.name)) continue
        if (Math.hypot(entity.position.x - pos.x, entity.position.y - pos.y, entity.position.z - pos.z) > blast) continue
        this.neutralizedTargets.add(id)
      }
      if (this.currentTargetId !== undefined && this.neutralizedTargets.has(this.currentTargetId)) {
        if (this.options.engagement === true && this.allTargetsResolved()) {
          this.finish('succeeded', 'ATTACK_TARGETS_RESOLVED', 'engagement resolved')
        } else if (this.options.engagement !== true) {
          this.finish('failed', 'ATTACK_TARGET_NEUTRALIZED', 'target exploded')
        } else {
          this.advanceTarget()
        }
      }
    })
  }

  tick(): void {
    if (this.state !== 'running' || this.inFlight) return
    this.inFlight = true
    void this.step()
      .catch((error: unknown) => {
        this.finish('failed', 'DRIVER_FAULT', error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        this.inFlight = false
      })
  }

  requestStop(): void {
    this.stopRequested = true
    this.finish('interrupted', 'ATTACK_INTERRUPTED')
  }

  result(): MeleeResult | undefined {
    return this.resultValue
  }

  private finish(state: CombatSessionState, code?: string, reason?: string): void {
    if (this.state !== 'running') return
    this.state = state
    this.disposeDead?.()
    this.disposeHurt?.()
    this.disposeExplosion?.()
    this.disposeDead = undefined
    this.disposeHurt = undefined
    this.disposeExplosion = undefined
    this.stopInput()
    const observed = this.observed(code, reason)
    this.releaseShield()
    this.resultValue = {
      state: state === 'succeeded' ? 'succeeded' : 'failed',
      ...(code === undefined ? {} : { code }),
      observed,
    }
  }

  private observed(code?: string, reason?: string): MeleeResult['observed'] {
    const reachSource: MeleeResult['observed']['reachSource'] = this.options.reach !== undefined
      ? 'override'
      : this.port.reach === undefined
        ? 'default'
        : 'attribute'
    return {
      kind: 'attack',
      entityId: this.currentTargetId,
      targets: [...this.targetIds],
      kills: this.deadTargets.size,
      neutralized: this.neutralizedTargets.size,
      escaped: this.escapedTargets.size,
      ...this.resolution(code),
      targetSwitches: this.targetSwitches,
      lostTargets: this.lostTargets.size,
      threatCount: this.threatCount,
      rangedThreat: this.rangedThreat,
      explosionThreat: this.explosionThreat,
      ...(this.options.targetName === undefined ? {} : { targetName: this.options.targetName }),
      attacks: this.attacks,
      attacksIssued: this.attacksIssued,
      damageObserved: this.damageObserved,
      deathConfirmed: this.allTargetsDead(),
      targetLost: this.state === 'failed' && (code === 'ATTACK_TARGET_LOST' || code === 'ATTACK_TARGETS_LOST'),
      killed: this.state === 'succeeded' && this.allTargetsDead(),
      guardWindows: this.guardWindows,
      guardExits: this.guardExits,
      stanceRaises: this.stanceRaises,
      stanceDrops: this.stanceDrops,
      stanceReleaseFailures: this.stanceReleaseFailures,
      shieldHeldMs: this.shieldHeldMs(),
      preShieldRaises: this.preShieldRaised ? 1 : 0,
      approachMoves: this.approachMoves,
      strafeMoves: this.strafeMoves,
      backoffMoves: this.backoffMoves,
      inputTicks: this.inputTicks,
      inputBlocked: this.inputBlocked,
      inputFailures: this.inputFailures,
      reach: this.reach,
      reachSource,
      ...(reason === undefined ? {} : { lostReason: reason }),
    }
  }

  private shieldHeldMs(): number {
    return this.shieldHeldSince === undefined
      ? 0
      : Math.max(0, this.port.now() - this.shieldHeldSince)
  }

  private aim(entity: CombatEntity): Vec3 {
    return {
      x: entity.position.x,
      y: entity.position.y + Math.min(1.4, (entity.height ?? DEFAULT_ENTITY_HEIGHT) * 0.8),
      z: entity.position.z,
    }
  }

  private stopInput(): void {
    if (this.port.combatInput === undefined) return
    const entity = this.port.entity(this.currentTargetId)
    const face = entity === undefined
      ? { x: this.port.self().pos.x, y: this.port.self().pos.y, z: this.port.self().pos.z - 1 }
      : this.aim(entity)
    void this.port.combatInput({ face })
  }

  private releaseShield(): void {
    if (!this.shieldHeld) return
    if (this.shieldHeldSince !== undefined) {
      this.shieldHeldSince = undefined
    }
    try {
      const released = this.port.offhandHold?.(false)
      void released?.then(
        result => {
          if (result.state === 'ok') {
            this.shieldHeld = false
            this.stanceDrops += 1
          } else {
            this.stanceReleaseFailures += 1
          }
        },
        () => {
          this.stanceReleaseFailures += 1
        },
      )
    } catch {
      this.stanceReleaseFailures += 1
    }
  }

  private async ensureShield(): Promise<void> {
    if (!this.shieldSupported || this.shieldFailed || this.shieldHeld) return
    try {
      const held = await this.port.offhandHold!(true)
      if (held.state !== 'ok') {
        this.shieldFailed = true
        return
      }
    } catch {
      this.shieldFailed = true
      return
    }
    this.shieldHeld = true
    this.shieldHeldSince = this.port.now()
    this.stanceRaises += 1
  }

  private targetFacing(entity: CombatEntity, self: Vec3): boolean | undefined {
    if (typeof entity.yaw !== 'number' || !Number.isFinite(entity.yaw)) return undefined
    const dx = self.x - entity.position.x
    const dz = self.z - entity.position.z
    const length = Math.hypot(dx, dz)
    if (length < 1e-6) return true
    const lookX = -Math.sin(entity.yaw)
    const lookZ = -Math.cos(entity.yaw)
    return (lookX * dx + lookZ * dz) / length >= Math.cos(FACING_CONE)
  }

  private inputFor(decision: CombatMove): CombatInput {
    const entity = this.port.entity(this.currentTargetId)
    const face = entity === undefined
      ? { x: this.port.self().pos.x, y: this.port.self().pos.y, z: this.port.self().pos.z - 1 }
      : this.aim(entity)
    if (decision === 'approach') {
      return {
        face,
        forward: true,
        ...(this.jumpNext ? { jump: true } : {}),
      }
    }
    if (decision === 'backoff') return { face, back: true }
    if (decision === 'strafe-left') return { face, left: true }
    if (decision === 'strafe-right') return { face, right: true }
    return { face }
  }

  private countMove(decision: CombatMove): void {
    if (decision === 'approach') this.approachMoves += 1
    else if (decision === 'backoff') this.backoffMoves += 1
    else if (decision === 'strafe-left' || decision === 'strafe-right') this.strafeMoves += 1
  }

  private async applyInput(decision: CombatMove): Promise<boolean> {
    if (this.port.combatInput === undefined) {
      this.finish('failed', 'ATTACK_NO_APPROACH', 'adapter has no combatInput')
      return false
    }
    this.inputTicks += 1
    this.countMove(decision)
    const attemptedJump = this.jumpNext
    if (attemptedJump) this.jumpTried = true
    const result = await this.port.combatInput(this.inputFor(decision))
    if (result.state === 'ok') {
      this.lastMoveWasInput = decision !== 'hold'
      if (this.jumpNext) {
        this.jumpNext = false
      } else if (decision === 'approach') {
        this.jumpTried = false
      }
      return true
    }
    if (result.code === 'COMBAT_INPUT_BLOCKED') {
      this.inputBlocked += 1
      this.stalledTicks = 0
      if (decision === 'approach' && !this.jumpTried) {
        // Try a one-block jump before committing to a lateral detour.
        this.jumpNext = true
        this.detourTicks = 1
        this.detourDecision = 'approach'
      } else {
        this.detourTicks = 6
        this.detourDecision = this.side === 'left' ? 'strafe-left' : 'strafe-right'
        this.side = this.side === 'left' ? 'right' : 'left'
        this.strafeSteps = 0
        this.jumpNext = false
        this.jumpTried = false
      }
      // Keep the prior movement controls from being assumed safe.
      await this.port.combatInput(this.inputFor('hold'))
      return false
    }
    this.inputFailures += 1
    this.misses += 1
    if (this.misses >= (this.options.maxMisses ?? DEFAULT_MAX_MISSES)) {
      this.finish('failed', 'ATTACK_NO_APPROACH', 'combat input failed')
    }
    return false
  }

  private allTargetsDead(): boolean {
    return this.targetIds.every(id => this.deadTargets.has(id))
  }

  private allTargetsResolved(): boolean {
    return this.targetIds.every(id =>
      this.deadTargets.has(id)
      || this.neutralizedTargets.has(id)
      || this.escapedTargets.has(id)
      || this.lostTargets.has(id)
      || this.protectedTargets.has(id))
  }

  private resolution(code?: string): Pick<MeleeResult['observed'], 'resolution' | 'resolved' | 'retryable'> {
    if (this.state === 'succeeded') {
      if (this.allTargetsDead()) return { resolution: 'killed', resolved: true, retryable: false }
      if (this.neutralizedTargets.size > 0) return { resolution: 'neutralized', resolved: true, retryable: false }
      if (this.escapedTargets.size > 0) return { resolution: 'escaped', resolved: true, retryable: false }
      if (this.lostTargets.size > 0) return { resolution: 'lost', resolved: true, retryable: false }
      return { resolution: 'killed', resolved: true, retryable: false }
    }
    if (code === 'ATTACK_TARGET_NEUTRALIZED') return { resolution: 'neutralized', resolved: true, retryable: false }
    if (code === 'ATTACK_TARGET_PROTECTED') return { resolution: 'protected', resolved: true, retryable: false }
    if (code === 'ATTACK_TARGET_LOST') {
      return { resolution: 'lost', resolved: true, retryable: this.options.engagement !== true }
    }
    return { resolution: 'unresolved', resolved: false, retryable: true }
  }

  /** Engagement semantics: no live target left, even if not every one was killed. */
  private finishIfResolved(): boolean {
    if (this.options.engagement !== true || !this.allTargetsResolved()) return false
    this.finish('succeeded', 'ATTACK_TARGETS_RESOLVED', 'engagement resolved')
    return true
  }

  /** Pick the nearest remaining allowed target after the current one is gone. */
  private advanceTarget(): boolean {
    this.waypoints = []
    if (this.allTargetsDead()) {
      this.finish('succeeded')
      return false
    }
    if (this.finishIfResolved()) return false
    const self = this.port.self()
    let best: { id: string; distance: number; visible: boolean } | undefined
    for (const id of this.targetIds) {
      if (this.deadTargets.has(id)
        || this.neutralizedTargets.has(id)
        || this.escapedTargets.has(id)
        || this.lostTargets.has(id)
        || this.protectedTargets.has(id)) continue
      const entity = this.port.entity(id)
      if (entity === undefined) {
        this.lostTargets.add(id)
        continue
      }
      const distance = eyeReach(self, entity)
      const visible = this.port.canSee(id)
      if (best === undefined
        || (visible && !best.visible)
        || (visible === best.visible && distance < best.distance)) {
        best = { id, distance, visible }
      }
    }
    if (best === undefined) {
      if (this.finishIfResolved()) return false
      if (this.neutralizedTargets.size > 0) this.finish('failed', 'ATTACK_TARGET_NEUTRALIZED', 'targets exhausted')
      else if (this.lostTargets.size > 0) this.finish('failed', 'ATTACK_TARGET_LOST', 'targets exhausted')
      else if (this.protectedTargets.size > 0) this.finish('failed', 'ATTACK_TARGET_PROTECTED', 'targets exhausted')
      else this.finish('failed', 'ATTACK_TARGET_LOST', 'no remaining target')
      return false
    }
    if (best.id !== this.currentTargetId) {
      this.currentTargetId = best.id
      this.targetSwitches += 1
    }
    return true
  }

  private updateThreats(): void {
    const self = this.port.self()
    let count = 0
    let ranged = false
    let explosion = false
    let creeperThreat: string | undefined
    let creeperDistance = Number.POSITIVE_INFINITY
    for (const id of this.targetIds) {
      if (this.deadTargets.has(id)
        || this.neutralizedTargets.has(id)
        || this.escapedTargets.has(id)
        || this.lostTargets.has(id)
        || this.protectedTargets.has(id)) continue
      const entity = this.port.entity(id)
      if (entity === undefined) continue
      count += 1
      if (/(?:skeleton|stray|pillager|witch)/iu.test(entity.name)) ranged = true
      if (/creeper/iu.test(entity.name) && eyeReach(self, entity) <= 8) {
        explosion = true
        const range = eyeReach(self, entity)
        if (range <= BLAST_RANGE && range < creeperDistance) {
          creeperDistance = range
          creeperThreat = id
        }
      }
    }
    this.threatCount = count
    this.rangedThreat = ranged
    this.explosionThreat = explosion
    this.creeperThreatId = creeperThreat
  }

  private async step(): Promise<void> {
    if (this.stopRequested) {
      this.finish('interrupted', 'ATTACK_INTERRUPTED')
      return
    }
    const now = this.port.now()
    if (now - this.startedAt > (this.options.totalMs ?? DEFAULT_TOTAL_MS)) {
      this.finish('failed', 'ATTACK_NOT_KILLED', 'time budget')
      return
    }
    const self = this.port.self()
    if (self.health <= 0) {
      this.finish('failed', 'BOT_DIED', 'self died')
      return
    }
    if (self.health < this.lastHealth) this.lastHurtAt = now
    this.lastHealth = self.health
    if (this.chaseLeash !== undefined
      && Math.hypot(self.pos.x - this.startOrigin.x, self.pos.z - this.startOrigin.z) > this.chaseLeash) {
      this.finish('failed', 'ATTACK_CHASE_LIMIT', 'chase leash exceeded')
      return
    }

    const entity = this.port.entity(this.currentTargetId)
    if (entity === undefined) {
      this.lostTargets.add(this.currentTargetId)
      if (this.finishIfResolved()) return
      if (!this.advanceTarget()) return
      return
    }
    if (this.chaseLeash !== undefined
      && Math.hypot(entity.position.x - this.startOrigin.x, entity.position.z - this.startOrigin.z) > this.chaseLeash) {
      if (this.options.engagement === true) {
        this.escapedTargets.add(this.currentTargetId)
        if (this.finishIfResolved()) return
        if (!this.advanceTarget()) return
        return
      }
      this.finish('failed', 'ATTACK_CHASE_LIMIT', 'target left chase leash')
      return
    }
    if (this.options.targetName !== undefined && entity.name !== this.options.targetName) {
      this.lostTargets.add(this.currentTargetId)
      if (this.finishIfResolved()) return
      if (!this.advanceTarget()) return
      return
    }
    const protectedCode = this.protectedTarget(entity)
    if (protectedCode !== undefined) {
      this.protectedTargets.add(this.currentTargetId)
      if (this.finishIfResolved()) return
      if (!this.advanceTarget()) return
      return
    }
    if ((entity.health ?? 1) <= 0) {
      this.deadTargets.add(this.currentTargetId)
      if (this.allTargetsDead()) {
        this.finish('succeeded')
        return
      }
      if (this.finishIfResolved()) return
      if (!this.advanceTarget()) return
      return
    }
    this.updateThreats()
    if (this.creeperThreatId !== undefined && this.creeperThreatId !== this.currentTargetId) {
      this.currentTargetId = this.creeperThreatId
      this.targetSwitches += 1
      return
    }

    const distance = eyeReach(self, entity)
    const visible = this.port.canSee(this.currentTargetId)
    if (visible) {
      this.lastSeen.set(this.currentTargetId, { ...entity.position })
      this.losTicks.set(this.currentTargetId, 0)
    }
    const targetFacing = this.targetFacing(entity, self.pos)

    // Waypoint path: plan once, then follow one cell-center per 50ms tick.
    // Visible + in reach cancels the path and returns to attack normal.
    if (this.waypoints.length > 0) {
      if (visible && distance <= this.reach) {
        this.waypoints = []
      } else if (this.port.combatInput !== undefined) {
        const next = this.waypoints[0]!
        if (Math.hypot(next.x - self.pos.x, next.z - self.pos.z) < 0.8) {
          this.waypoints.shift()
          return
        }
        const pathJump = next.y > self.pos.y + 0.5
        const moved = await this.port.combatInput({
          face: next,
          forward: true,
          ...(pathJump ? { jump: true } : {}),
        })
        this.inputTicks += 1
        this.approachMoves += 1
        this.lastMoveWasInput = true
        if (moved.state !== 'ok') {
          this.waypoints = []
          this.inputBlocked += 1
        }
        return
      }
    }

    // A visible but repeatedly blocked approach also benefits from a path.
    if (this.waypoints.length === 0
      && this.stalledTicks >= STALLED_TICKS
      && distance > this.reach
      && this.port.pathTo !== undefined) {
      const lastNav = this.lastNavigateAt.get(this.currentTargetId) ?? 0
      if (now - lastNav >= 1_000) {
        this.lastNavigateAt.set(this.currentTargetId, now)
        const planned = await this.port.pathTo(entity.position, 2, 500)
        if (planned.state === 'ok' && (planned.path?.length ?? 0) > 0) {
          this.waypoints = planned.path!
          this.stalledTicks = 0
          return
        }
      }
    }

    // Guard is movement-only: it holds position, but attack/shield continue.
    const guarding = this.guardMs > 0
      && this.lastHurtAt !== undefined
      && now - this.lastHurtAt <= this.guardMs
      && this.shieldSupported
      && !this.shieldFailed
    if (guarding) this.guardWindows += 1
    if (this.guarding && !guarding) this.guardExits += 1
    this.guarding = guarding

    if (this.shieldSupported) {
      if (!this.preShieldRaised && distance <= this.preShieldRange) {
        this.preShieldRaised = true
        await this.ensureShield()
      } else {
        await this.ensureShield()
      }
    }

    // Stalled detection is about actual body progress between ticks.
    const moved = Math.hypot(self.pos.x - this.lastPos.x, self.pos.z - this.lastPos.z)
    if (this.lastMoveWasInput && moved < 0.05) this.stalledTicks += 1
    else this.stalledTicks = 0
    this.lastPos = { ...self.pos }
    this.lastMoveWasInput = false

    let decision: CombatMove = 'hold'
    if (!visible) {
      const ticks = (this.losTicks.get(this.currentTargetId) ?? 0) + 1
      this.losTicks.set(this.currentTargetId, ticks)
      if (ticks > (this.options.losRecoveryTicks ?? 40)) {
        this.finish('failed', 'ATTACK_NO_LINE_OF_SIGHT', 'LOS recovery budget')
        return
      }
      const lastNav = this.lastNavigateAt.get(this.currentTargetId) ?? 0
      if (ticks >= 10 && this.port.pathTo !== undefined && now - lastNav >= 1_000) {
        this.lastNavigateAt.set(this.currentTargetId, now)
        const point = this.lastSeen.get(this.currentTargetId) ?? entity.position
        const planned = await this.port.pathTo(point, 2, 500)
        if (planned.state === 'ok' && (planned.path?.length ?? 0) > 0) {
          this.waypoints = planned.path!
          this.losTicks.set(this.currentTargetId, 0)
          return
        }
      }
      decision = this.options.movement === false
        ? 'hold'
        : distance > this.tooClose ? 'approach' : 'backoff'
    } else if (this.options.movement === false) {
      decision = 'hold'
    } else if (distance > this.reach) {
      decision = 'approach'
    } else {
      const noDamage = this.attacksSinceDamage >= NO_DAMAGE_WINDOWS && this.strafeMoves > 0
      decision = decideCombatMove({
        distance,
        band: this.band,
        tooClose: this.tooClose,
        visible,
        recentlyHurt: guarding,
        stalled: this.stalledTicks >= STALLED_TICKS,
        noDamage,
        ...(targetFacing === undefined ? {} : { targetFacing }),
        strafeEnabled: this.options.strafe !== false,
        side: this.side,
      })
    }
    // Creeper spacing: opt-in; with a shield it adds no survival benefit and
    // only delays the fight. It stays available for fuse-aware experiments.
    if (visible
      && this.options.creeperBackpedal === true
      && /creeper/iu.test(entity.name)
      && distance <= this.reach) {
      decision = 'backoff'
    }

    if (this.detourTicks > 0) {
      decision = this.detourDecision
      this.detourTicks -= 1
    }
    const inputOk = await this.applyInput(decision)
    if (this.state !== 'running') return
    if (decision === 'strafe-left' || decision === 'strafe-right') {
      const next = nextStrafeSide(this.side, this.strafeSteps)
      this.side = next.side
      this.strafeSteps = next.steps
    } else if (!inputOk) {
      this.side = this.side === 'left' ? 'right' : 'left'
      this.strafeSteps = 0
    }

    if (!visible || distance > this.reach) return
    const cooldown = attackCooldownMs(this.port.attackSpeed())
    if (this.lastAttackAt !== undefined && now - this.lastAttackAt < cooldown) return
    if (this.attacks >= (this.options.maxAttacks ?? DEFAULT_MAX_ATTACKS)) {
      this.finish('failed', 'ATTACK_NOT_KILLED', 'max attacks')
      return
    }

    // The movement input stays active: attacks do not stop movement or drop
    // the shield. lookAt only changes facing.
    if (this.port.lookAt !== undefined) await this.port.lookAt(this.aim(entity))
    this.attacks += 1
    this.attacksIssued += 1
    this.attacksSinceDamage += 1
    this.lastAttackAt = now
    const hit = await this.port.attack(this.currentTargetId)
    if (hit.state !== 'ok') {
      this.misses += 1
      if (this.misses >= (this.options.maxMisses ?? DEFAULT_MAX_MISSES)) {
        this.finish('failed', 'ATTACK_NO_HIT', hit.code ?? 'attack failed')
      }
      return
    }
    const after = this.port.entity(this.currentTargetId)
    if (after === undefined) {
      if (this.deadTargets.has(this.currentTargetId)) {
        if (this.allTargetsDead()) {
          this.finish('succeeded')
          return
        }
        if (!this.advanceTarget()) return
        return
      }
      this.lostTargets.add(this.currentTargetId)
      if (this.finishIfResolved()) return
      if (!this.advanceTarget()) return
      return
    }
    if ((after.health ?? 1) <= 0) {
      this.deadTargets.add(this.currentTargetId)
      if (this.allTargetsDead()) {
        this.finish('succeeded')
        return
      }
      if (this.finishIfResolved()) return
      if (!this.advanceTarget()) return
    }
  }

  private protectedTarget(target: CombatEntity): string | undefined {
    if (this.options.allowAny === true) return undefined
    if (target.type === 'player') return 'ATTACK_TARGET_PROTECTED'
    if (/passive|neutral|tameable/i.test(target.kind ?? '') && this.options.allowPassive !== true) {
      return 'ATTACK_TARGET_PROTECTED'
    }
    return undefined
  }
}
