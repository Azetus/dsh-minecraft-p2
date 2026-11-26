import { isRecord } from '../../contracts/protocol.ts'
import type { JsonValue } from '../../contracts/types.ts'
import type { BodyApi, EntityInfo, Vec3 } from '../../body/api.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { sleep } from './handle.ts'
import { AsyncDriverHandle } from './handle.ts'
import {
  BOW_PROFILE,
  CROSSBOW_PROFILE,
  launchDirection,
  segmentHitsBox,
  solveAim,
  type AimSolution,
  type ArrowProfile,
} from '../ranged/ballistics.ts'
import { isArrowName, isCrossbowLoadedWithArrow, loadCrossbow } from '../ranged/crossbow.ts'

export const SHOOT_DRIVER_ID = 'shoot'

const SHOOT_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    entityId: { type: 'string' },
    weapon: { type: 'string', enum: ['bow', 'crossbow'] },
    targetName: { type: 'string' },
    maxShots: { type: 'integer', minimum: 1, maximum: 5 },
    maxRange: { type: 'integer', minimum: 8, maximum: 64 },
    orderId: { type: 'string' },
    continuationKey: { type: 'string' },
  },
  required: ['entityId', 'weapon'],
  additionalProperties: false,
}

type ShootParams = {
  entityId: string
  weapon: 'bow' | 'crossbow'
  targetName?: string
  maxShots?: number
  maxRange?: number
  orderId?: string
  continuationKey?: string
}

const DEFAULT_MAX_SHOTS = 3
const DEFAULT_MAX_RANGE = 32
const LOCATE_RADIUS = 64
const BOW_CHARGE_MS = 1_300
const STATIONARY_TOLERANCE = 0.25
const MAX_LEAD_BLOCKS = 6
const HIT_SETTLE_MS = 200

type HurtEvent = { sourceId?: string; directId?: string; at: number }
type ArrowLaunch = { id: string; velocity?: Vec3 }

type ShotOutcome = {
  interrupted?: boolean
  hit: boolean
  missed: boolean
  inconclusive: boolean
  fatal?: boolean
  code?: string
  observed: Record<string, unknown>
}

class StopShoot extends Error {}

/**
 * One bounded ranged order. The driver owns aiming, charge/load, release and
 * flight observation; it never acquires or switches targets.
 */
export function createShootDriver(): Driver {
  return {
    id: SHOOT_DRIVER_ID,
    schema: SHOOT_SCHEMA,
    defaults: {
      budget: { maxTicks: 1_200, maxWallMs: 45_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as ShootParams
      if (typeof params.entityId !== 'string' || params.entityId.length === 0) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (params.weapon !== 'bow' && params.weapon !== 'crossbow') {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (params.maxShots !== undefined
        && (!Number.isInteger(params.maxShots) || params.maxShots < 1 || params.maxShots > 5)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      if (params.maxRange !== undefined
        && (!Number.isInteger(params.maxRange) || params.maxRange < 8 || params.maxRange > 64)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as ShootParams
      const key = params.continuationKey ?? `shoot:${params.entityId}:${params.weapon}`
      const run = new RangedAttack(ctx.body, params)
      return new AsyncDriverHandle(key, run.work(), () => run.stop())
    },
  }
}

export type RangedAttackOptions = {
  /** Standalone `shoot` requires dry, still ground; combat may move. */
  requireStationary?: boolean
  /** Use the shooter's current velocity for bow ballistics. */
  useShooterVelocity?: boolean
  maxShots?: number
  /** Called between charge polls; lets a combat session keep moving. */
  onChargeTick?: () => Promise<void>
}

export class RangedAttack {
  private readonly options: RangedAttackOptions
  private stopRequested = false
  private useActive = false
  private targetDead = false
  private selfId: string | undefined
  private startPos: Vec3 | undefined
  private readonly launches = new Map<string, ArrowLaunch>()
  private readonly onLaunch = (payload: unknown): void => {
    if (!isRecord(payload) || typeof payload.id !== 'string' || this.launches.has(payload.id)) return
    const v = payload.velocity
    const velocity = isRecord(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'
      ? { x: v.x, y: v.y, z: v.z } : undefined
    this.launches.set(payload.id, { id: payload.id, ...(velocity === undefined ? {} : { velocity }) })
  }
  private readonly hurts: HurtEvent[] = []
  private readonly onHurt = (payload: unknown): void => {
    if (!isRecord(payload) || typeof payload.entityId !== 'string') return
    if (payload.entityId !== this.params.entityId) return
    if (payload.sourceId !== undefined && payload.sourceId !== this.selfId) return
    this.hurts.push({
      ...(typeof payload.sourceId === 'string' ? { sourceId: payload.sourceId } : {}),
      ...(typeof payload.directId === 'string' ? { directId: payload.directId } : {}),
      at: Date.now(),
    })
  }
  private readonly onDead = (payload: unknown): void => {
    if (isRecord(payload) && payload.entityId === this.params.entityId) this.targetDead = true
  }
  private targetSample: { pos: Vec3; at: number } | undefined
  private lastShot: ShotOutcome | undefined

  constructor(
    private readonly body: BodyApi,
    private readonly params: ShootParams,
    options: RangedAttackOptions = {},
  ) {
    this.options = options
  }

  stop(): void {
    this.stopRequested = true
    if (this.useActive) {
      const cancelled = this.body.itemUseCancel?.()
      if (cancelled !== undefined) void cancelled.catch(() => {})
    }
  }

  async work(): Promise<DriverResult> {
    const body = this.body
    body.on('ownArrowSpawn', this.onLaunch)
    body.on('entityDamageSource', this.onHurt)
    body.on('entityDead', this.onDead)
    try {
      const self = body.self()
      this.selfId = self.id
      this.startPos = { ...self.pos }
      if (this.options.requireStationary !== false
        && (!self.onGround || self.inWater || self.inLava)) {
        return this.failed('SHOOT_NOT_STATIONARY', { reason: 'shooter not standing on dry ground' })
      }
      const target = this.resolveTarget()
      if (target === undefined) return this.failed('SHOOT_TARGET_NOT_FOUND', {})
      this.sampleTarget(target)
      const heldBefore = body.held?.()
      const loadedCrossbow = this.params.weapon === 'crossbow'
        && heldBefore !== undefined
        && isCrossbowLoadedWithArrow(heldBefore)
      if (!loadedCrossbow
        && !body.inventory().some(item => isArrowName(item.name))
        && !isArrowName(body.offhand?.()?.name ?? '')) {
        return this.failed('SHOOT_NO_AMMO', {})
      }
      if (!body.inventory().some(item => normalize(item.name) === this.params.weapon)) {
        return this.failed('SHOOT_NO_WEAPON', { weapon: this.params.weapon })
      }
      const held = body.held?.()
      if (held === undefined) return this.failed('SHOOT_HELD_UNAVAILABLE', {})
      if (normalize(held.name) !== this.params.weapon) {
        const equipped = await body.equip(this.params.weapon)
        if (equipped.state !== 'ok') {
          return this.failed(equipped.code ?? 'SHOOT_EQUIP_FAILED', { weapon: this.params.weapon })
        }
      }
      const afterEquip = body.held?.()
      if (afterEquip === undefined || normalize(afterEquip.name) !== this.params.weapon) {
        return this.failed('SHOOT_EQUIP_FAILED', { weapon: this.params.weapon })
      }

      const shots: Record<string, unknown>[] = []
      const maxShots = this.options.maxShots ?? this.params.maxShots ?? DEFAULT_MAX_SHOTS
      let anyMiss = false
      let anyInconclusive = false
      for (let index = 0; index < maxShots; index += 1) {
        this.ensureRunning()
        const outcome = await this.shootOnce(index)
        if (outcome.interrupted) throw new StopShoot()
        shots.push(outcome.observed)
        this.lastShot = outcome
        if (outcome.hit) {
          return {
            state: 'succeeded',
            observed: this.resultObserved(shots, true),
          }
        }
        anyMiss ||= outcome.missed
        anyInconclusive ||= outcome.inconclusive
        if (outcome.fatal) {
          return {
            state: 'failed',
            code: outcome.code ?? 'SHOOT_NOT_CONFIRMED',
            observed: this.resultObserved(shots, false),
          }
        }
        if (this.targetDead) break
      }
      return {
        state: 'failed',
        code: anyInconclusive ? 'SHOOT_INCONCLUSIVE' : anyMiss ? 'SHOOT_MISSED' : 'SHOOT_NOT_CONFIRMED',
        observed: this.resultObserved(shots, false),
      }
    } catch (error) {
      if (error instanceof StopShoot) return { state: 'interrupted' }
      if (error instanceof CodedShootError) {
        return this.failed(error.code, error.observed)
      }
      return this.failed('SHOOT_DRIVER_FAULT', {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      body.off?.('ownArrowSpawn', this.onLaunch)
      body.off?.('entityDamageSource', this.onHurt)
      body.off?.('entityDead', this.onDead)
    }
  }

  private async shootOnce(index: number): Promise<ShotOutcome> {
    const target = this.resolveTarget()
    if (target === undefined) {
      return this.failedShot(index, 'SHOOT_TARGET_LOST', { reason: 'target disappeared' })
    }
    if (this.params.targetName !== undefined && target.name !== this.params.targetName) {
      return this.failedShot(index, 'SHOOT_TARGET_LOST', { reason: 'target name changed' })
    }
    const startedAt = Date.now()
    let aim: AimSolution
    try {
      aim = this.planAim(target, this.params.weapon === 'bow' ? BOW_PROFILE : CROSSBOW_PROFILE)
      this.ensureStationary()
    } catch (error) {
      if (error instanceof CodedShootError) return this.failedShot(index, error.code, error.observed)
      throw error
    }
    let loadObserved: Record<string, unknown> | undefined

    if (this.params.weapon === 'crossbow') {
      const held = this.body.held?.()
      const charged = held?.chargedProjectiles
      if (charged === undefined) {
        return this.failedShot(index, 'CROSSBOW_LOAD_STATE_UNKNOWN', { charged })
      }
      if (charged.length > 0 && !charged.every(projectile => isArrowName(projectile))) {
        return this.failedShot(index, 'CROSSBOW_UNSUPPORTED_PROJECTILE', { charged })
      }
      if (!isCrossbowLoadedWithArrow(held)) {
        const loaded = await loadCrossbow(this.body, {
          isStopped: () => this.stopRequested,
          chargeWaitMs: 1_500,
          settleWaitMs: 1_200,
        })
        loadObserved = loaded.observed as unknown as Record<string, unknown>
        if (loaded.state === 'interrupted') throw new StopShoot()
        if (loaded.state === 'failed') {
          return this.failedShot(index, loaded.code ?? 'CROSSBOW_LOAD_UNCONFIRMED', loadObserved)
        }
        const afterLoad = this.body.held?.()
        if (!isCrossbowLoadedWithArrow(afterLoad)) {
          return this.failedShot(index, 'CROSSBOW_LOAD_UNCONFIRMED', loadObserved)
        }
      }
    }

    const active = this.body.held?.()
    if (active === undefined || normalize(active.name) !== this.params.weapon) {
      return this.failedShot(index, 'SHOOT_WEAPON_MISMATCH', {})
    }

    let release: { yaw: number; pitch: number } | undefined
    if (this.params.weapon === 'bow') {
      const started = await this.body.itemUseStart?.()
      if (started === undefined || started.state !== 'ok') {
        return this.failedShot(index, started?.code ?? 'SHOOT_NOT_CONFIRMED', { act: started ?? null })
      }
      this.useActive = true
      await this.sleep(BOW_CHARGE_MS)
      const fresh = this.resolveTarget()
      if (fresh === undefined) {
        await this.cancelUse()
        return this.failedShot(index, 'SHOOT_TARGET_LOST', { reason: 'target disappeared during draw' })
      }
      try {
        aim = this.planAim(fresh, BOW_PROFILE)
        this.ensureStationary()
      } catch (error) {
        await this.cancelUse()
        if (error instanceof CodedShootError) return this.failedShot(index, error.code, error.observed)
        throw error
      }
      this.beginShot()
      const released = await this.body.itemUseRelease?.({ yaw: aim.yaw, pitch: aim.pitch })
      this.useActive = false
      if (released === undefined || released.state !== 'ok') {
        await this.cancelUse()
        return this.failedShot(index, released?.code ?? 'SHOOT_NOT_CONFIRMED', { act: released ?? null })
      }
      release = { yaw: aim.yaw, pitch: aim.pitch }
    } else {
      const fresh = this.resolveTarget()
      if (fresh === undefined) {
        return this.failedShot(index, 'SHOOT_TARGET_LOST', { reason: 'target disappeared during load' })
      }
      try {
        aim = this.planAim(fresh, CROSSBOW_PROFILE)
        this.ensureStationary()
      } catch (error) {
        if (error instanceof CodedShootError) return this.failedShot(index, error.code, error.observed)
        throw error
      }
      this.beginShot()
      const fired = await this.body.itemUseStart?.({ yaw: aim.yaw, pitch: aim.pitch })
      if (fired === undefined || fired.state !== 'ok') {
        return this.failedShot(index, fired?.code ?? 'SHOOT_NOT_CONFIRMED', { act: fired ?? null })
      }
      this.useActive = true
      const released = await this.body.itemUseRelease?.()
      this.useActive = false
      if (released === undefined || released.state !== 'ok') {
        await this.cancelUse()
        // The crossbow fires on activate; a failed release may still leave a
        // projectile in flight. Observe it rather than claiming nothing happened.
      }
      release = { yaw: aim.yaw, pitch: aim.pitch }
    }

    const observed = await this.observeShot(index, {
      aim,
      release,
      expectedArrows: this.params.weapon === 'bow' ? 1 : active.chargedProjectiles?.length,
      startedAt,
      ...(loadObserved === undefined ? {} : { load: loadObserved }),
    })
    return observed
  }

  private async observeShot(
    index: number,
    input: {
      aim: AimSolution
      release: { yaw: number; pitch: number } | undefined
      expectedArrows: number | undefined
      startedAt: number
      load?: Record<string, unknown>
    },
  ): Promise<ShotOutcome> {
    const deadline = Date.now() + Math.max(1_200, Math.min(5_000, input.aim.flightTicks * 50 + 1_200))
    let primaryId: string | undefined
    let stableSamples = 0
    let landed = false
    let lastPosition: Vec3 | undefined
    let hitEvent: HurtEvent | undefined

    while (Date.now() < deadline) {
      if (this.stopRequested) throw new StopShoot()
      primaryId = this.primaryArrow(input.aim, input.expectedArrows)
      const primary = primaryId === undefined ? undefined : this.body.entityById?.(primaryId)
      if (primary !== undefined) {
        const moved = lastPosition === undefined ? Infinity : distance(lastPosition, primary.position)
        stableSamples = moved < 0.05 ? stableSamples + 1 : 0
        lastPosition = { ...primary.position }
        if (stableSamples >= 2 && this.blockedAtFeet(primary.position)) landed = true
      }
      hitEvent = this.primaryHurt(primaryId)
      if (hitEvent !== undefined) break
      if (landed) break
      if (this.targetDead) break
      await sleep(50)
    }

    // Give the damage event a short window to arrive after a visible landing.
    if (hitEvent === undefined) {
      await sleep(HIT_SETTLE_MS)
      if (this.stopRequested) throw new StopShoot()
      primaryId = this.primaryArrow(input.aim, input.expectedArrows)
      hitEvent = this.primaryHurt(primaryId)
    }

    const sideHit = primaryId !== undefined && this.hurts.some(event =>
      event.directId !== undefined && event.directId !== primaryId && this.launches.has(event.directId))
    const ambiguousHurt = this.hurts.some(event => event.directId === undefined)
    const hit = hitEvent !== undefined
    const missed = !hit && primaryId !== undefined && landed && !ambiguousHurt
    const inconclusive = !hit && !missed
    const observedHurt = hitEvent ?? this.hurts.at(-1)
    const arrowGone = primaryId !== undefined && !this.body.entityById?.(primaryId)
    const observed: Record<string, unknown> = {
      index,
      weapon: this.params.weapon,
      targetId: this.params.entityId,
      aim: {
        yaw: input.aim.yaw,
        pitch: input.aim.pitch,
        flightTicks: input.aim.flightTicks,
        impact: input.aim.impact,
        spreadSigma: 0.0172275 * horizontalDistance(this.body.self().pos, input.aim.impact),
      },
      release: input.release ?? null,
      elapsedMs: Date.now() - input.startedAt,
      hit,
      missed,
      inconclusive,
      hitEvidence: hit ? 'damage-source-arrow' : null,
      arrow: {
        id: primaryId ?? null,
        seen: this.launches.size > 0,
        gone: arrowGone,
        lastPosition: lastPosition ?? null,
        landed,
      },
      hurt: observedHurt === undefined
        ? null
        : {
            sourceId: observedHurt.sourceId ?? null,
            directId: observedHurt.directId ?? null,
            at: observedHurt.at,
          },
      sideHit,
      ...(input.load === undefined ? {} : { load: input.load }),
    }
    return {
      hit,
      missed,
      inconclusive,
      observed,
    }
  }

  private planAim(target: EntityInfo, profile: ArrowProfile): AimSolution {
    const self = this.body.self()
    if (this.options.requireStationary !== false
      && (!self.onGround || self.inWater || self.inLava)) {
      throw new CodedShootError('SHOOT_NOT_STATIONARY', { reason: 'shooter left dry ground' })
    }
    // `canSee` checks the target's feet; a low fence can block that ray while
    // the actual ballistic path to the torso clears it. The sampled trajectory
    // below is the authoritative line-of-sight check for an arrow.
    const eye = self.pos.y + Math.max(0.1, (self.height ?? 1.8) - 0.18) - 0.1
    const origin: Vec3 = { x: self.pos.x, y: eye, z: self.pos.z }
    let point = targetCenter(target)
    const velocity = this.estimateVelocity(target)
    const range = horizontalDistance(origin, point)
    if (range > (this.params.maxRange ?? DEFAULT_MAX_RANGE)) {
      throw new CodedShootError('SHOOT_OUT_OF_RANGE', { range, maxRange: this.params.maxRange ?? DEFAULT_MAX_RANGE })
    }
    let solution: AimSolution | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = solveAim(
        origin,
        point,
        profile,
        this.options.useShooterVelocity === true ? self.velocity : undefined,
      )
      if ('code' in result) {
        throw new CodedShootError(result.code === 'NO_SOLUTION' ? 'SHOOT_NO_SOLUTION' : 'SHOOT_OUT_OF_RANGE', {
          range,
          targetY: point.y,
        })
      }
      solution = result
      const leadTicks = result.flightTicks
      const raw = {
        x: velocity.x * leadTicks,
        y: 0,
        z: velocity.z * leadTicks,
      }
      const clamped = clampLead(raw)
      const next = {
        x: targetCenter(target).x + clamped.x,
        y: targetCenter(target).y,
        z: targetCenter(target).z + clamped.z,
      }
      if (distance(next, point) < 0.05) break
      point = next
    }
    if (solution === undefined) {
      throw new CodedShootError('SHOOT_NO_SOLUTION', { range })
    }
    this.assertTrajectoryClear(solution, target)
    this.sampleTarget(target)
    return solution
  }

  private assertTrajectoryClear(solution: AimSolution, targetEntity: EntityInfo): void {
    const target = targetCenter(targetEntity)
    const halfWidth = (targetEntity.width ?? 0.6) / 2 + 0.25
    const halfHeight = (targetEntity.height ?? 1.8) / 2 + 0.25
    const box = {
      min: { x: target.x - halfWidth, y: target.y - halfHeight, z: target.z - halfWidth },
      max: { x: target.x + halfWidth, y: target.y + halfHeight, z: target.z + halfWidth },
    }
    for (let index = 2; index < solution.trajectory.length - 2; index += 2) {
      const point = solution.trajectory[index]!
      if (segmentHitsBox(point, solution.trajectory[index + 1]!, box.min, box.max)) return
      const block = this.body.blockAt({ x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) })
      if (block === null) {
        throw new CodedShootError('SHOOT_OBSERVATION_UNAVAILABLE', {
          at: { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) },
        })
      }
      if (isBlocking(block)) {
        throw new CodedShootError('SHOOT_LINE_BLOCKED', {
          at: { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) },
          block: block.name,
        })
      }
    }
  }

  private estimateVelocity(target: EntityInfo): Vec3 {
    const now = Date.now()
    const center = targetCenter(target)
    let velocity = { x: 0, y: 0, z: 0 }
    if (this.targetSample !== undefined) {
      const ticks = (now - this.targetSample.at) / 50
      if (ticks >= 1) {
        velocity = {
          x: (center.x - this.targetSample.pos.x) / ticks,
          y: 0,
          z: (center.z - this.targetSample.pos.z) / ticks,
        }
      }
    } else if (target.velocity !== undefined) {
      velocity = { x: target.velocity.x, y: 0, z: target.velocity.z }
    }
    return {
      x: clamp(velocity.x, -1.5, 1.5),
      y: 0,
      z: clamp(velocity.z, -1.5, 1.5),
    }
  }

  private sampleTarget(target: EntityInfo): void {
    this.targetSample = { pos: targetCenter(target), at: Date.now() }
  }

  private resolveTarget(): EntityInfo | undefined {
    const direct = this.body.entityById?.(this.params.entityId)
    if (direct !== undefined) return direct
    const self = this.body.self().pos
    return this.body.entities({
      min: { x: self.x - LOCATE_RADIUS, y: self.y - 16, z: self.z - LOCATE_RADIUS },
      max: { x: self.x + LOCATE_RADIUS, y: self.y + 16, z: self.z + LOCATE_RADIUS },
    }).find(entity => entity.id === this.params.entityId)
  }

  private beginShot(): void {
    this.launches.clear()
    this.hurts.length = 0
  }

  private primaryHurt(primaryId: string | undefined): HurtEvent | undefined {
    if (primaryId === undefined) return undefined
    return this.hurts.find(event => event.directId === primaryId)
  }

  private primaryArrow(aim: AimSolution, expected: number | undefined): string | undefined {
    if (this.launches.size !== expected) return undefined
    const direction = launchDirection(aim.yaw, aim.pitch)
    let best: string | undefined
    let bestDot = -Infinity
    for (const arrow of this.launches.values()) {
      if (expected === 1) return arrow.id
      if (arrow.velocity === undefined || Math.hypot(arrow.velocity.x, arrow.velocity.y, arrow.velocity.z) === 0) {
        return undefined
      }
      const vector = normalizeVector(arrow.velocity)
      const dot = vector.x * direction.x + vector.y * direction.y + vector.z * direction.z
      if (dot > bestDot) {
        best = arrow.id
        bestDot = dot
      } else if (dot === bestDot) {
        best = undefined
      }
    }
    return best
  }

  private blockedAtFeet(position: Vec3): boolean {
    const block = this.body.blockAt({ x: Math.floor(position.x), y: Math.floor(position.y) - 1, z: Math.floor(position.z) })
    return block !== null && isBlocking(block)
  }

  private ensureStationary(): void {
    if (this.options.requireStationary === false) return
    const self = this.body.self()
    if (!self.onGround || self.inWater || self.inLava) {
      throw new CodedShootError('SHOOT_NOT_STATIONARY', { reason: 'shooter left dry ground' })
    }
    if (this.startPos !== undefined
      && Math.hypot(self.pos.x - this.startPos.x, self.pos.z - this.startPos.z) > STATIONARY_TOLERANCE) {
      throw new CodedShootError('SHOOT_NOT_STATIONARY', {
        from: this.startPos,
        to: self.pos,
      })
    }
  }

  private ensureRunning(): void {
    if (this.stopRequested) throw new StopShoot()
  }

  private async cancelUse(): Promise<void> {
    this.useActive = false
    try {
      await this.body.itemUseCancel?.()
    } catch {
      // Stop path remains interrupted; cancellation failure is not a hit.
    }
  }

  private async sleep(ms: number): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      this.ensureRunning()
      await this.options.onChargeTick?.()
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())))
    }
  }

  private failedShot(index: number, code: string, observed: Record<string, unknown>): ShotOutcome {
    return {
      hit: false,
      missed: false,
      inconclusive: false,
      fatal: true,
      code,
      observed: {
        index,
        code,
        ...observed,
      },
    }
  }

  private failed(code: string, extra: Record<string, unknown>): DriverResult {
    return {
      state: 'failed',
      code,
      observed: {
        kind: 'shoot',
        entityId: this.params.entityId,
        weapon: this.params.weapon,
        hit: false,
        killed: this.targetDead,
        shots: [],
        ...extra,
      } as unknown as JsonValue,
    }
  }

  private resultObserved(shots: Record<string, unknown>[], hit: boolean): JsonValue {
    return {
      kind: 'shoot',
      entityId: this.params.entityId,
      weapon: this.params.weapon,
      hit,
      killed: this.targetDead,
      hits: shots.filter(shot => shot.hit === true).length,
      shots,
      lastCode: this.lastShot?.code ?? null,
    } as unknown as JsonValue
  }
}

class CodedShootError extends Error {
  constructor(
    readonly code: string,
    readonly observed: Record<string, unknown>,
  ) {
    super(code)
  }
}

function targetCenter(target: EntityInfo): Vec3 {
  return {
    x: target.position.x,
    y: target.position.y + (target.height ?? 1.8) / 2,
    z: target.position.z,
  }
}

function horizontalDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z)
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampLead(lead: Vec3): Vec3 {
  const length = Math.hypot(lead.x, lead.z)
  if (length <= MAX_LEAD_BLOCKS) return lead
  const scale = MAX_LEAD_BLOCKS / length
  return { x: lead.x * scale, y: 0, z: lead.z * scale }
}

function normalizeVector(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z)
  if (length < 1e-9) return { x: 0, y: 0, z: 0 }
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length }
}

function isBlocking(block: { name: string; solid?: boolean; collision?: number[][] }): boolean {
  const name = block.name.replace(/^minecraft:/u, '')
  if (name === 'air' || name === 'cave_air' || name === 'void_air'
    || name === 'water' || name === 'flowing_water' || name === 'lava' || name === 'flowing_lava') return false
  if (block.solid === false) return false
  if (block.solid === true) return true
  if (Array.isArray(block.collision)) return block.collision.length > 0
  return true
}

function normalize(name: string): string {
  return name.replace(/^minecraft:/u, '').trim()
}
