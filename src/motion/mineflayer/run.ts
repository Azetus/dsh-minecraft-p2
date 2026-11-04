import type { Bot } from 'mineflayer'

import type { JsonValue } from '../../contracts/types.ts'
import { PathExecutor, standingCell } from '../execute/index.ts'
import { WAYPOINT_TOLERANCE } from '../model/block.ts'
import {
  defaultConstraints,
  createGoal,
  fallBudgetForHealth,
  type ArrivalPolicy,
  type BlockClassifier,
  type BodyOverlap,
  type Cell,
  type MotionConstraints,
  type MotionGoal,
  type Move,
} from '../model/types.ts'
import { MotionSearch } from '../search/astar.ts'
import { MotionContextSource } from './context.ts'
import { MineflayerMotionWorld } from './world.ts'

export type MotionRunState = 'running' | 'succeeded' | 'failed' | 'canceled'

export type MotionRunResult = {
  state: MotionRunState
  code?: string
  observed?: JsonValue
}

export type MotionRunOptions = {
  constraints?: MotionConstraints
  classifier?: BlockClassifier
  /** Search slice budget per tick; kept below the action poll interval. */
  searchTimeoutMs?: number
  maxNodes?: number
  maxReplans?: number
  /** Core-owned arrival policy; defaults to a near goal of `range`. */
  arrival?: ArrivalPolicy
  /**
   * Explicit scaffold only: skip the exact-goal standability precheck because
   * the Pillar move will make the target standable. Requires `allowPlace`.
   */
  allowUnsupportedGoal?: boolean
  /** Soft hostile avoidance; defaults to a 1.5x cost within 8 blocks. */
  avoidance?: { coefficient: number; radius: number }
}

/**
 * One A* run: plan with the motion search, execute typed moves, then re-plan
 * from the reached prefix. It never asks another planner to drive the body.
 */
export class MotionRun {
  private readonly world: MineflayerMotionWorld
  private context: MotionContextSource
  private readonly baseConstraints: MotionConstraints
  private activeConstraints: MotionConstraints
  private readonly classifier: BlockClassifier | undefined
  private readonly avoidance: { coefficient: number; radius: number }
  private readonly from: Cell
  private motionGoal: MotionGoal
  private readonly finalGoal: MotionGoal
  private activeTarget: Cell
  private readonly finalArrival: ArrivalPolicy
  private readonly allowUnsupportedGoal: boolean
  private readonly searchTimeoutMs: number
  private readonly maxNodes: number
  private readonly maxReplans: number
  private active = true
  private result: MotionRunResult = { state: 'running' }
  private phase: 'planning' | 'moving' | 'done' = 'planning'
  private search: MotionSearch | undefined
  private searchedSafeFall = false
  private safeFallPass = false
  /** Consecutive empty-goal searches while the body is still landing. */
  private emptyGoalWaits = 0
  private executor: PathExecutor | undefined
  private pathStatus = 'pending'
  private path: Cell[] = []
  private visitedNodes = 0
  private generatedNodes = 0
  private replans = 0
  private readonly startedAt: number
  private readonly healthBefore: number
  private readonly startPos: { x: number; y: number; z: number }

  constructor(
    private readonly bot: Bot,
    private readonly target: Cell,
    private readonly range: number,
    private readonly timeoutMs: number,
    options: MotionRunOptions = {},
  ) {
    this.world = new MineflayerMotionWorld(bot)
    this.baseConstraints = options.constraints ?? defaultConstraints()
    this.activeConstraints = this.baseConstraints
    this.classifier = options.classifier
    this.avoidance = options.avoidance ?? { coefficient: 1.5, radius: 8 }
    this.context = new MotionContextSource(
      this.world,
      this.baseConstraints,
      this.classifier,
    )
    this.from = standingCell(this.context.next().rules, this.world.self().pos)
    this.activeTarget = target
    this.finalArrival = options.arrival ?? { kind: 'near', range }
    this.allowUnsupportedGoal = options.allowUnsupportedGoal === true
    this.motionGoal = createGoal(target, this.finalArrival)
    this.finalGoal = this.motionGoal
    this.searchTimeoutMs = options.searchTimeoutMs ?? 2_000
    this.maxNodes = options.maxNodes ?? 12_000
    this.maxReplans = options.maxReplans ?? 64
    this.startedAt = Date.now()
    this.healthBefore = this.world.self().health
    this.startPos = { ...this.world.self().pos }
  }

  start(): void {
    this.beginPlan()
  }

  tick(now: number): MotionRunResult {
    if (this.result.state !== 'running' || !this.active) return this.result
    if (now - this.startedAt >= this.timeoutMs) {
      this.fail('GOTO_TIMEOUT', 'deadline')
      return this.result
    }
    if (this.phase === 'planning') {
      this.planStep()
      return this.result
    }
    const executor = this.executor
    if (executor === undefined) {
      this.phase = 'planning'
      return this.result
    }
    const step = executor.tick(now)
    if (step.state === 'running') return this.result
    if (step.state === 'succeeded') {
      if (this.arrived()) {
        this.succeed(step.observed)
        return this.result
      }
      this.replans += 1
      if (this.replans > this.maxReplans) {
        this.fail('GOTO_NO_PATH', 'prefix-exhausted', step.observed)
        return this.result
      }
      this.executor = undefined
      this.phase = 'planning'
      return this.result
    }
    if (step.state === 'canceled') {
      this.active = false
      this.phase = 'done'
      this.result = { state: 'canceled', ...(step.observed === undefined ? {} : { observed: step.observed }) }
      return this.result
    }
    const code = step.code === 'STUCK' || step.code === 'TIMEOUT' ? 'GOTO_STUCK'
      : step.code === 'UNREACHABLE' ? 'GOTO_NO_PATH'
        : 'GOTO_ERROR'
    this.fail(code, step.code ?? 'executor-failed', step.observed)
    return this.result
  }

  stop(): boolean {
    this.active = false
    this.phase = 'done'
    this.search = undefined
    const executor = this.executor
    executor?.cancel()
    const released = executor?.release() ?? true
    try {
      this.bot.clearControlStates()
    } catch {
      return false
    }
    this.result = { state: 'canceled' }
    return released && this.controlsReleased()
  }

  report(): JsonValue {
    const self = this.world.self()
    const position = self.pos
    const observed = this.executor?.report()
    return {
      from: this.from,
      target: this.target,
      activeTarget: this.activeTarget,
      at: position,
      range: this.range,
      phase: this.phase,
      pathStatus: this.pathStatus,
      path: this.path.slice(0, 64),
      bestReachable: this.path.at(-1) ?? null,
      candidates: [],
      actions: [],
      hazards: null,
      hazardPass: false,
      safeFallPass: this.safeFallPass,
      ...(this.baseConstraints.safeFallBudget === undefined ? {} : { safeFall: this.baseConstraints.safeFallBudget }),
      healthBefore: this.healthBefore,
      healthAfter: self.health,
      bodyOverlap: this.bodyOverlap() ?? null,
      index: observed?.index ?? 0,
      total: observed?.total ?? this.path.length,
      move: observed?.move ?? null,
      detail: observed?.detail ?? null,
      recoveries: observed?.recoveries ?? 0,
      backtracks: observed?.backtracks ?? 0,
      visitedNodes: this.visitedNodes,
      generatedNodes: this.generatedNodes,
      replans: this.replans,
      planner: 'astar',
      swim: this.activeConstraints.waterProfile === 'swim',
      waterProfile: this.activeConstraints.waterProfile,
      arrivalKind: this.finalArrival.kind,
      movedDistance: Math.hypot(
        self.pos.x - this.startPos.x,
        self.pos.y - this.startPos.y,
        self.pos.z - this.startPos.z,
      ),
      elapsedMs: Date.now() - this.startedAt,
    }
  }

  private beginPlan(): void {
    if (!this.active) return
    // A body whose real AABB already intersects a block cannot be moved by a
    // path: every edge starts from an invalid state. Report the exact cells so
    // the caller can clear them instead of re-planning into GOTO_STUCK.
    if (this.failOnBodyOverlap('start-embedded')) return
    // An exact arrival promises a standing position. Refuse a target that is
    // provably not standable instead of silently ending one cell below it.
    const scaffoldGoal = this.allowUnsupportedGoal && this.activeConstraints.allowPlace
    if (this.finalArrival.kind === 'exact' && !scaffoldGoal) {
      const info = this.context.next().rules.standInfo(this.target)
      if (info.state !== 'yes') {
        this.fail('GOAL_NOT_STANDABLE', 'goal-not-standable', {
          target: this.target,
          reason: info.reason,
          ...(info.state === 'no' && info.blockedBy !== undefined ? { blockedBy: info.blockedBy } : {}),
        })
        return
      }
    }
    this.phase = 'planning'
    this.pathStatus = 'pending'
    this.activeTarget = this.resolveTarget()
    this.motionGoal = this.activeTarget.x === this.target.x
      && this.activeTarget.y === this.target.y
      && this.activeTarget.z === this.target.z
      ? createGoal(this.target, this.finalArrival)
      : createGoal(this.activeTarget, { kind: 'near', range: 1 })
    const ctx = this.context.next()
    this.search = new MotionSearch(standingCell(ctx.rules, ctx.position), this.motionGoal, () => this.context.next(), {
      sliceMs: 5,
      maxNodes: this.maxNodes,
      timeoutMs: this.searchTimeoutMs,
      isCanceled: () => !this.active,
      avoidance: this.avoidance,
    })
  }

  /**
   * A target outside the loaded world cannot be searched directly. Advance
   * along the straight line to the nearest standable loaded prefix; after that
   * prefix is reached, the next plan resolves again (and eventually the real
   * target once its chunk is loaded). This is core policy, not a driver hack.
   */
  private resolveTarget(): Cell {
    if (this.world.blockAt(this.target) !== null) return this.target
    const self = standingCell(this.context.next().rules, this.world.self().pos)
    const dx = this.target.x - self.x
    const dz = this.target.z - self.z
    const distance = Math.hypot(dx, dz)
    if (distance <= 1) return this.target
    const advance = Math.min(16, distance - 1)
    const projected = {
      x: Math.floor(self.x + dx / distance * advance),
      y: self.y,
      z: Math.floor(self.z + dz / distance * advance),
    }
    const rules = this.context.next().rules
    let best: Cell | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (let ox = -2; ox <= 2; ox += 1) {
      for (let oz = -2; oz <= 2; oz += 1) {
        for (let oy = -3; oy <= 3; oy += 1) {
          const candidate = { x: projected.x + ox, y: projected.y + oy, z: projected.z + oz }
          if (candidate.x === self.x && candidate.y === self.y && candidate.z === self.z) continue
          if (rules.standInfo(candidate).state !== 'yes') continue
          const d = Math.hypot(candidate.x - projected.x, candidate.y - projected.y, candidate.z - projected.z)
          if (d < bestDistance) {
            best = candidate
            bestDistance = d
          }
        }
      }
    }
    return best ?? projected
  }

  private planStep(): void {
    if (this.search === undefined) {
      this.beginPlan()
      return
    }
    this.searchStep()
  }

  private searchStep(): void {
    const search = this.search
    if (search === undefined) return
    const result = search.step(Date.now())
    this.pathStatus = result.status === 'running' ? 'partial' : result.status
    this.path = result.path
    this.visitedNodes = result.nodes
    this.generatedNodes = result.generated
    if (result.status === 'running') return
    if (result.status === 'canceled') {
      this.active = false
      this.phase = 'done'
      this.result = { state: 'canceled' }
      return
    }
    if (result.status === 'success') {
      if (result.moves.length === 0) {
        if (this.arrived()) {
          this.succeed(this.report())
          return
        }
        // A pillar/scaffold can finish with the feet already in the target
        // cell but still airborne for a tick. Do not turn that transient into
        // GOTO_NO_PATH; re-plan a few times so `arrived` can observe onGround.
        if (this.emptyGoalWaits < 20) {
          this.emptyGoalWaits += 1
          this.search = undefined
          this.phase = 'planning'
          return
        }
        this.fail('GOTO_NO_PATH', 'empty-path')
        return
      }
      this.emptyGoalWaits = 0
      this.startExecutor(result.moves)
      return
    }
    // Best-so-far is a prefix, never an arrival: execute it, then re-plan.
    if (result.moves.length > 0) {
      this.startExecutor(result.moves)
      return
    }
    if (!this.searchedSafeFall && this.target.y < standingCell(this.context.next().rules, this.world.self().pos).y - 1) {
      const budget = fallBudgetForHealth(this.world.self().health)
      if (budget > this.activeConstraints.maxFall) {
        this.searchedSafeFall = true
        this.safeFallPass = true
        this.context = new MotionContextSource(
          this.world,
          { ...this.activeConstraints, safeFallBudget: budget },
          this.classifier,
        )
        this.search = undefined
        this.beginPlan()
        return
      }
    }
    this.fail(result.status === 'timeout' ? 'GOTO_SEARCH_TIMEOUT' : 'GOTO_NO_PATH', `astar-${result.status}`)
  }

  private startExecutor(moves: Move[]): void {
    this.executor = new PathExecutor(moves, () => this.context.next())
    this.phase = 'moving'
    this.search = undefined
  }

  private arrived(): boolean {
    const self = this.world.self()
    const rules = this.context.next().rules
    // The planner's identity is the feet cell derived from the real feet height;
    // a loose "inside the target column" fallback could accept one cell below.
    const cell = standingCell(rules, self.pos)
    if (!this.finalGoal.isEnd(cell)) return false
    // A water-surface goal is reached while floating; a land goal needs the
    // physics flag and the support height the node promised.
    if (rules.isWater(cell) === 'yes') return true
    if (!self.onGround) return false
    const info = rules.standInfo(cell)
    return info.state === 'yes' && Math.abs(info.feetY - self.pos.y) <= WAYPOINT_TOLERANCE
  }

  private bodyOverlap(): BodyOverlap | undefined {
    try {
      const ctx = this.context.next()
      return ctx.rules.bodyOverlapAt(ctx.position)
    } catch {
      // A missing bot position is observed elsewhere; never invent an overlap.
      return undefined
    }
  }

  /** Fail fast with the exact cells to clear when the real body is embedded. */
  private failOnBodyOverlap(phase: string): boolean {
    const overlap = this.bodyOverlap()
    if (overlap === undefined || overlap.blocks.length === 0) return false
    this.fail('BODY_OVERLAP', phase, {
      at: this.world.self().pos,
      blockedBy: overlap.blocks,
      ...(overlap.unknown.length === 0 ? {} : { unknown: overlap.unknown }),
      hint: 'clear the listed block(s) before moving',
    })
    return true
  }

  private succeed(observed?: JsonValue): void {
    // Arriving inside a block is not a usable standing position.
    if (this.failOnBodyOverlap('arrived-embedded')) return
    const self = this.world.self()
    const rules = this.context.next().rules
    const cell = standingCell(rules, self.pos)
    const info = rules.standInfo(cell)
    this.active = false
    this.phase = 'done'
    this.world.releaseAll()
    this.result = {
      state: 'succeeded',
      observed: {
        executor: observed ?? null,
        arrival: {
          kind: this.finalArrival.kind,
          policy: this.finalArrival,
          from: { ...this.startPos },
          to: { ...this.target },
          cell,
          feetY: info.state === 'yes' ? info.feetY : null,
          at: { ...self.pos },
          movedDistance: Math.hypot(
            self.pos.x - this.startPos.x,
            self.pos.y - this.startPos.y,
            self.pos.z - this.startPos.z,
          ),
          elapsedMs: Date.now() - this.startedAt,
        },
        run: this.safeReport(),
      },
    }
  }

  private fail(code: string, detail: string, observed?: JsonValue): void {
    this.active = false
    this.phase = 'done'
    this.executor?.cancel()
    this.world.releaseAll()
    this.result = {
      state: 'failed',
      code,
      observed: {
        detail,
        ...(observed === undefined ? {} : { executor: observed }),
        run: this.safeReport(),
      },
    }
  }

  private safeReport(): JsonValue {
    try {
      return this.report()
    } catch {
      return null
    }
  }

  private controlsReleased(): boolean {
    const getControl = (this.bot as unknown as { getControlState?: (name: string) => boolean }).getControlState
    if (typeof getControl !== 'function') return true
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'] as const) {
      if (getControl.call(this.bot, control) === true) return false
    }
    return true
  }
}
