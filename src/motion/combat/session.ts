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

  constructor(
    private readonly port: CombatPort,
    private readonly targetId: string,
    private readonly options: MeleeOptions = {},
  ) {
    this.startedAt = port.now()
    this.lastHealth = port.self().health
    this.lastPos = { ...port.self().pos }
    this.reach = clampReach(options.reach ?? port.reach?.() ?? DEFAULT_REACH)
    this.band = engageBand(this.reach)
    this.tooClose = tooCloseFor(this.reach)
    this.guardMs = Math.max(0, options.guardMs ?? DEFAULT_GUARD_MS)
    this.preShieldRange = Math.max(0, options.preShieldRange ?? DEFAULT_PRE_SHIELD_RANGE)
    this.shieldSupported = options.shield !== false
      && port.offhandHold !== undefined
      && port.hasShield?.() === true
    this.disposeDead = port.onEntityDead(id => {
      if (id === this.targetId) this.finish('succeeded')
    })
    this.disposeHurt = port.onEntityHurt(id => {
      if (id !== this.targetId) return
      this.damageObserved += 1
      this.attacksSinceDamage = 0
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
    this.disposeDead = undefined
    this.disposeHurt = undefined
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
      entityId: this.targetId,
      ...(this.options.targetName === undefined ? {} : { targetName: this.options.targetName }),
      attacks: this.attacks,
      attacksIssued: this.attacksIssued,
      damageObserved: this.damageObserved,
      deathConfirmed: this.state === 'succeeded',
      targetLost: this.state === 'failed' && code === 'ATTACK_TARGET_LOST',
      killed: this.state === 'succeeded',
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
    const entity = this.port.entity(this.targetId)
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
    const entity = this.port.entity(this.targetId)
    const face = entity === undefined
      ? { x: this.port.self().pos.x, y: this.port.self().pos.y, z: this.port.self().pos.z - 1 }
      : this.aim(entity)
    if (decision === 'approach') return { face, forward: true }
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
    const result = await this.port.combatInput(this.inputFor(decision))
    if (result.state === 'ok') {
      this.lastMoveWasInput = decision !== 'hold'
      return true
    }
    if (result.code === 'COMBAT_INPUT_BLOCKED') {
      this.inputBlocked += 1
      this.stalledTicks += 1
      this.side = this.side === 'left' ? 'right' : 'left'
      this.strafeSteps = 0
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

    const entity = this.port.entity(this.targetId)
    if (entity === undefined) {
      this.finish('failed', 'ATTACK_TARGET_LOST', 'target left query range')
      return
    }
    if (this.options.targetName !== undefined && entity.name !== this.options.targetName) {
      this.finish('failed', 'ATTACK_TARGET_CHANGED', 'target name changed')
      return
    }
    const protectedCode = this.protectedTarget(entity)
    if (protectedCode !== undefined) {
      this.finish('failed', protectedCode, 'protected target')
      return
    }
    if ((entity.health ?? 1) <= 0) {
      this.finish('succeeded')
      return
    }

    const distance = eyeReach(self, entity)
    const visible = this.port.canSee(this.targetId)
    const targetFacing = this.targetFacing(entity, self.pos)

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
      this.misses += 1
      if (this.misses >= (this.options.maxMisses ?? DEFAULT_MAX_MISSES)) {
        this.finish('failed', 'ATTACK_NO_LINE_OF_SIGHT', 'target not visible')
        return
      }
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
    const hit = await this.port.attack(this.targetId)
    if (hit.state !== 'ok') {
      this.misses += 1
      if (this.misses >= (this.options.maxMisses ?? DEFAULT_MAX_MISSES)) {
        this.finish('failed', 'ATTACK_NO_HIT', hit.code ?? 'attack failed')
      }
      return
    }
    const after = this.port.entity(this.targetId)
    if (after === undefined || (after.health ?? 1) <= 0) this.finish('succeeded')
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
