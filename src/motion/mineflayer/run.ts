import type { Bot } from 'mineflayer'
import type { ComputedPath, Movements } from 'mineflayer-pathfinder'

import type { JsonValue } from '../../contracts/types.ts'
import { PathExecutor, buildMoves, cellOf, reached } from '../execute/index.ts'
import {
  defaultConstraints,
  type BlockClassifier,
  type Cell,
  type MotionConstraints,
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
  /** P2 default is the motion A*; the existing search is a one-run fallback. */
  planner?: 'astar' | 'existing'
  /** Adapter hook so the existing search lets hand-openable doors through. */
  setDoorMode?: (enabled: boolean) => void
}

type PathfinderLike = {
  getPathFromTo(
    movements: Movements,
    startPos: { x: number; y: number; z: number } | null,
    goal: unknown,
    options: { timeout: number; tickTimeout: number; searchRadius: number; optimizePath: boolean },
  ): IterableIterator<{ result: ComputedPath }>
  setGoal(goal: null): void
  isMoving?: () => boolean
}

/**
 * P1 planner bridge: the existing search produces path nodes, this run turns
 * them into typed moves and executes them itself. It never calls setGoal, so
 * upstream cannot drive the body behind the executor's back.
 */
export class MotionRun {
  private readonly world: MineflayerMotionWorld
  private readonly context: MotionContextSource
  private readonly from: Cell
  private readonly pathfinder: PathfinderLike | undefined
  private readonly searchTimeoutMs: number
  private readonly maxNodes: number
  private readonly maxReplans: number
  private readonly setDoorMode: (enabled: boolean) => void
  private active = true
  private result: MotionRunResult = { state: 'running' }
  private phase: 'planning' | 'moving' | 'done' = 'planning'
  private planner: IterableIterator<{ result: ComputedPath }> | undefined
  private search: MotionSearch | undefined
  private plannerMode: 'astar' | 'existing'
  private searchedFallback = false
  private executor: PathExecutor | undefined
  private pathStatus = 'pending'
  private path: Cell[] = []
  private visitedNodes = 0
  private generatedNodes = 0
  private replans = 0
  private readonly startedAt: number
  private readonly healthBefore: number

  constructor(
    private readonly bot: Bot,
    private readonly movements: Movements,
    private readonly target: Cell,
    private readonly range: number,
    private readonly timeoutMs: number,
    options: MotionRunOptions = {},
  ) {
    this.world = new MineflayerMotionWorld(bot)
    this.context = new MotionContextSource(
      this.world,
      options.constraints ?? defaultConstraints(),
      options.classifier,
    )
    this.from = cellOf(this.world.self().pos)
    this.pathfinder = (bot as unknown as { pathfinder?: PathfinderLike }).pathfinder
    this.searchTimeoutMs = options.searchTimeoutMs ?? 2_000
    this.maxNodes = options.maxNodes ?? 12_000
    this.maxReplans = options.maxReplans ?? 4
    this.plannerMode = options.planner ?? 'astar'
    this.setDoorMode = options.setDoorMode ?? (() => {})
    this.startedAt = Date.now()
    this.healthBefore = this.world.self().health
    this.setDoorMode(true)
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
      this.planner = undefined
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
    this.planner = undefined
    this.search = undefined
    this.setDoorMode(false)
    const executor = this.executor
    executor?.cancel()
    const released = executor?.release() ?? true
    try {
      this.pathfinder?.setGoal(null)
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
      safeFallPass: false,
      healthBefore: this.healthBefore,
      healthAfter: self.health,
      index: observed?.index ?? 0,
      total: observed?.total ?? this.path.length,
      move: observed?.move ?? null,
      detail: observed?.detail ?? null,
      recoveries: observed?.recoveries ?? 0,
      backtracks: observed?.backtracks ?? 0,
      visitedNodes: this.visitedNodes,
      generatedNodes: this.generatedNodes,
      replans: this.replans,
      planner: this.plannerMode,
      elapsedMs: Date.now() - this.startedAt,
    }
  }

  private beginPlan(): void {
    if (!this.active) return
    this.phase = 'planning'
    this.pathStatus = 'pending'
    if (this.plannerMode === 'astar') {
      const ctx = this.context.next()
      this.search = new MotionSearch(cellOf(ctx.position), this.target, () => this.context.next(), {
        sliceMs: 5,
        maxNodes: this.maxNodes,
        timeoutMs: this.searchTimeoutMs,
        isCanceled: () => !this.active,
      })
      return
    }
    if (this.pathfinder === undefined) {
      this.fail('GOTO_UNAVAILABLE', 'pathfinder-missing')
      return
    }
    try {
      this.planner = this.pathfinder.getPathFromTo(
        this.movements,
        this.bot.entity.position,
        this.goal(),
        { timeout: this.searchTimeoutMs, tickTimeout: 5, searchRadius: 48, optimizePath: false },
      )
    } catch {
      this.fail('GOTO_NO_PATH', 'search-start-failed')
    }
  }

  private planStep(): void {
    if (this.search !== undefined) {
      this.searchStep()
      return
    }
    if (this.planner === undefined) {
      this.beginPlan()
      return
    }
    let next: IteratorResult<{ result: ComputedPath }>
    try {
      next = this.planner.next()
    } catch {
      this.fail('GOTO_NO_PATH', 'search-threw')
      return
    }
    if (next.done) {
      this.fail('GOTO_NO_PATH', 'search-ended-without-route')
      return
    }
    const result = next.value.result
    this.pathStatus = result.status
    this.path = result.path.map(node => ({ x: node.x, y: node.y, z: node.z }))
    this.visitedNodes = result.visitedNodes
    this.generatedNodes = result.generatedNodes
    if (this.generatedNodes > this.maxNodes) {
      this.fail('GOTO_SEARCH_LIMIT', 'node-budget')
      return
    }
    if (result.status === 'noPath' && this.path.length === 0) {
      this.fail('GOTO_NO_PATH', 'search-exhausted-within-movement-policy')
      return
    }
    if (this.path.length === 0) {
      if (this.arrived()) this.succeed(this.report())
      else this.fail('GOTO_NO_PATH', 'empty-path')
      return
    }
    const ctx = this.context.next()
    const built = buildMoves(this.path, cellOf(ctx.position), ctx)
    if (!built.ok) {
      this.fail('GOTO_NO_PATH', built.code, { reason: built.reason, at: built.at })
      return
    }
    this.startExecutor(built.moves)
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
        if (this.arrived()) this.succeed(this.report())
        else this.fail('GOTO_NO_PATH', 'empty-path')
        return
      }
      this.startExecutor(result.moves)
      return
    }
    // Best-so-far is a prefix, never an arrival: execute it, then re-plan.
    if (result.moves.length > 0) {
      this.startExecutor(result.moves)
      return
    }
    if (!this.searchedFallback) {
      this.searchedFallback = true
      this.plannerMode = 'existing'
      this.search = undefined
      this.beginPlan()
      return
    }
    this.fail(result.status === 'timeout' ? 'GOTO_SEARCH_TIMEOUT' : 'GOTO_NO_PATH', `astar-${result.status}`)
  }

  private startExecutor(moves: Move[]): void {
    this.executor = new PathExecutor(moves, () => this.context.next())
    this.phase = 'moving'
    this.search = undefined
    this.planner = undefined
  }

  private goal(): unknown {
    const target = this.target
    const range = this.range
    return {
      heuristic: (node: { x: number; y: number; z: number }): number => Math.max(
        0,
        Math.hypot(node.x - target.x, node.y - target.y, node.z - target.z) - range,
      ),
      isEnd: (node: { x: number; y: number; z: number }): boolean => Math.hypot(
        node.x - target.x,
        node.y - target.y,
        node.z - target.z,
      ) <= range + 0.001,
      hasChanged: (): boolean => false,
      isValid: (): boolean => this.active,
    }
  }

  private arrived(): boolean {
    const self = this.world.self()
    const cell = cellOf(self.pos)
    const distance = Math.hypot(
      cell.x - this.target.x,
      cell.y - this.target.y,
      cell.z - this.target.z,
    )
    if (distance > this.range + 0.001) return false
    if (self.onGround) return true
    // Landing lag: the move already proved a standing position, but the physics
    // flag can trail one tick. Accept only when the body is at that feet height.
    return reached(self.pos, this.target, this.context.next())
  }

  private succeed(observed?: JsonValue): void {
    this.active = false
    this.phase = 'done'
    this.setDoorMode(false)
    this.world.releaseAll()
    this.result = {
      state: 'succeeded',
      observed: {
        executor: observed ?? null,
        run: this.safeReport(),
      },
    }
  }

  private fail(code: string, detail: string, observed?: JsonValue): void {
    this.active = false
    this.phase = 'done'
    this.planner = undefined
    this.setDoorMode(false)
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
    if (this.pathfinder?.isMoving?.() === true) return false
    return true
  }
}
