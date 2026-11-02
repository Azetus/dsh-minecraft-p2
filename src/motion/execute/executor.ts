import { sameCell } from '../model/block.ts'
import {
  COST_INF,
  initialMoveState,
  type Move,
  type MoveContext,
  type MoveState,
  type Vec3,
} from '../model/types.ts'
import { cellOf, reached, releaseInputs } from './moves.ts'

export type ExecutorState = 'running' | 'succeeded' | 'failed' | 'canceled'

export type ExecutorObserved = {
  phase: 'moving' | 'done'
  index: number
  total: number
  move: string | null
  position: Vec3
  status: ExecutorState
  code?: string
  detail?: string
  recoveries: number
  backtracks: number
  elapsedMs: number
}

export type ExecutorResult = {
  state: ExecutorState
  code?: string
  observed?: ExecutorObserved
}

export type PathExecutorOptions = {
  now?: () => number
  /** Time without physical displacement before the edge is declared stuck. */
  stallMs?: number
  /** Consecutive ticks off every valid position before failing. */
  offPathTicks?: number
  moveTimeoutMs?: (move: Move, cost: number) => number
}

const DEFAULT_STALL_MS = 2_500
const DEFAULT_OFF_PATH_TICKS = 20

/**
 * Executes a planned move list one tick at a time. It revalidates cost, recovers
 * to a nearby valid position after a push/slab/teleport, bounds every edge and
 * releases inputs on every terminal state. It never re-plans by itself; the
 * caller owns the search.
 */
export class PathExecutor {
  private readonly states: MoveState[]
  private index = 0
  private result: ExecutorResult = { state: 'running' }
  private readonly startedAt: number
  private lastNow: number
  private moveStartedAt: number
  private lastProgressAt: number
  private lastPos: Vec3
  private offPathTicks = 0
  private recoveries = 0
  private backtracks = 0
  private cancelRequested = false
  private released = false
  private detail: string | undefined
  private readonly stallMs: number
  private readonly maxOffPathTicks: number
  private readonly timeoutFor: (move: Move, cost: number) => number

  constructor(
    private readonly moves: readonly Move[],
    private readonly context: () => MoveContext,
    options: PathExecutorOptions = {},
  ) {
    const now = options.now?.() ?? Date.now()
    this.startedAt = now
    this.lastNow = now
    this.moveStartedAt = now
    this.lastProgressAt = now
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS
    this.maxOffPathTicks = options.offPathTicks ?? DEFAULT_OFF_PATH_TICKS
    this.timeoutFor = options.moveTimeoutMs ?? defaultTimeout
    const ctx = this.context()
    this.lastPos = ctx.position
    this.states = moves.map(() => initialMoveState(now))
    if (moves[0] !== undefined) moves[0].reset()
  }

  /** Run one bounded step. `now` is monotonic milliseconds. */
  tick(now: number): ExecutorResult {
    if (this.result.state !== 'running') return this.result
    this.lastNow = now
    if (this.cancelRequested) {
      this.finish('canceled', undefined, 'cancel-requested')
      return this.result
    }
    const ctx = this.context()
    if (this.moves.length === 0) {
      this.finish('succeeded')
      return this.result
    }
    if (this.index >= this.moves.length) {
      this.finish('succeeded')
      return this.result
    }
    const move = this.moves[this.index]!
    const cost = move.cost(ctx)
    if (cost === COST_INF) {
      this.finish('failed', 'UNREACHABLE', 'edge-became-infeasible', ctx)
      return this.result
    }
    if (ctx.self.onGround) {
      const cell = cellOf(ctx.position)
      if (!this.isValid(move, cell, ctx) && !reached(ctx.position, move.dest, ctx)) {
        this.recover(ctx, now)
        if (this.result.state !== 'running') return this.result
      }
    }
    const moved = Math.hypot(
      ctx.position.x - this.lastPos.x,
      ctx.position.y - this.lastPos.y,
      ctx.position.z - this.lastPos.z,
    )
    if (moved > 0.12) {
      this.lastProgressAt = now
      this.lastPos = ctx.position
      this.offPathTicks = 0
    } else if (now - this.lastProgressAt > this.stallMs) {
      this.finish('failed', 'STUCK', 'no-displacement', ctx)
      return this.result
    }
    if (now - this.moveStartedAt > this.timeoutFor(move, cost)) {
      this.finish('failed', 'TIMEOUT', `${move.kind}-timeout`, ctx)
      return this.result
    }
    const state = this.states[this.index]!
    const status = move.update(state, ctx)
    state.status = status
    if (status === 'success') {
      this.advance(ctx, now)
      return this.result
    }
    if (status === 'unreachable') {
      this.finish('failed', 'UNREACHABLE', state.detail ?? 'move-unreachable', ctx)
      return this.result
    }
    if (status === 'failed') {
      this.finish('failed', 'STUCK', state.detail ?? 'move-failed', ctx)
      return this.result
    }
    if (status === 'canceled') {
      this.finish('canceled', undefined, 'move-canceled', ctx)
      return this.result
    }
    return this.result
  }

  cancel(): void {
    this.cancelRequested = true
    if (this.result.state !== 'running') return
    this.safeRelease()
    this.result = { state: 'canceled' }
    this.result = { ...this.result, observed: this.observe() }
  }

  /** Release all movement input; returns whether the call itself completed. */
  release(): boolean {
    this.safeRelease()
    return this.released
  }

  report(): ExecutorObserved {
    return this.observe()
  }

  private advance(ctx: MoveContext, now: number): void {
    const state = this.states[this.index]!
    state.status = 'success'
    this.index += 1
    if (this.index >= this.moves.length) {
      this.finish('succeeded', undefined, undefined, ctx)
      return
    }
    const next = this.moves[this.index]!
    next.reset()
    this.states[this.index] = initialMoveState(now)
    this.moveStartedAt = now
    this.lastProgressAt = now
    this.lastPos = ctx.position
    this.offPathTicks = 0
  }

  private isValid(move: Move, cell: Vec3, ctx: MoveContext): boolean {
    for (const valid of move.validPositions()) {
      if (sameCell(valid, cell)) return true
      if (reached(ctx.position, valid, ctx, 0.35)) return true
    }
    return false
  }

  private recover(ctx: MoveContext, now: number): void {
    const cell = cellOf(ctx.position)
    const forward = this.findValidFrom(cell, ctx, this.index, Math.min(this.moves.length - 1, this.index + 4))
    if (forward !== undefined) {
      this.jumpTo(forward, now, ctx)
      this.recoveries += 1
      return
    }
    const backward = this.findValidFrom(cell, ctx, Math.max(0, this.index - 3), this.index - 1, true)
    if (backward !== undefined) {
      this.jumpTo(backward, now, ctx)
      this.backtracks += 1
      return
    }
    let nearest = Number.POSITIVE_INFINITY
    for (const move of this.moves) {
      nearest = Math.min(nearest, Math.hypot(cell.x - move.dest.x, cell.z - move.dest.z))
    }
    this.offPathTicks += 1
    releaseInputs(ctx)
    if (nearest > 4 || this.offPathTicks > this.maxOffPathTicks) {
      this.finish('failed', 'STUCK', 'off-path', ctx)
    }
  }

  private findValidFrom(
    cell: Vec3,
    ctx: MoveContext,
    from: number,
    to: number,
    descending = false,
  ): number | undefined {
    if (descending) {
      for (let index = from; index >= to; index -= 1) {
        const move = this.moves[index]
        if (move !== undefined && this.isValid(move, cell, ctx)) return index
      }
      return undefined
    }
    for (let index = from; index <= to; index += 1) {
      const move = this.moves[index]
      if (move !== undefined && this.isValid(move, cell, ctx)) return index
    }
    return undefined
  }

  private jumpTo(index: number, now: number, ctx: MoveContext): void {
    const resetFrom = Math.min(this.index, index)
    const resetTo = Math.max(this.index, index)
    for (let i = resetFrom; i <= resetTo; i += 1) {
      this.moves[i]?.reset()
      this.states[i] = initialMoveState(now)
    }
    this.index = index
    this.moveStartedAt = now
    this.lastProgressAt = now
    this.lastPos = ctx.position
    this.offPathTicks = 0
  }

  private finish(
    state: ExecutorState,
    code?: string,
    detail?: string,
    ctx?: MoveContext,
  ): void {
    if (this.result.state !== 'running') return
    this.safeRelease()
    this.detail = detail
    this.result = { state, ...(code === undefined ? {} : { code }) }
    this.result = { ...this.result, observed: this.observe(ctx?.position) }
  }

  private safeRelease(): void {
    try {
      this.context().world.releaseAll()
      this.released = true
    } catch {
      this.released = false
    }
  }

  private observe(position?: Vec3): ExecutorObserved {
    const move = this.moves[this.index]
    return {
      phase: this.result.state === 'running' ? 'moving' : 'done',
      index: this.index,
      total: this.moves.length,
      move: move?.kind ?? null,
      position: position ?? this.lastPos,
      status: this.result.state,
      ...(this.result.code === undefined ? {} : { code: this.result.code }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      recoveries: this.recoveries,
      backtracks: this.backtracks,
      elapsedMs: Math.max(0, this.lastNow - this.startedAt),
    }
  }
}

function defaultTimeout(move: Move, cost: number): number {
  const base = move.kind === 'bridge' || move.kind === 'pillar' ? 5_000
    : move.kind === 'fall' ? 3_000
      : move.kind === 'ascend' ? 2_000
        : 1_500
  return Math.max(base, Math.min(8_000, base + Math.floor(cost * 150)))
}
