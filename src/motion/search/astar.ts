import {
  AscendMove,
  BridgeMove,
  DescendMove,
  DiagonalMove,
  DownwardMove,
  FallMove,
  ParkourMove,
  PillarMove,
  TraverseMove,
} from '../execute/moves.ts'
import { cellKey, sameCell } from '../model/block.ts'
import {
  COST_INF,
  createGoal,
  type AvoidancePolicy,
  type Cell,
  type MotionGoal,
  type Move,
  type MoveContext,
  type Vec3,
} from '../model/types.ts'
import { MinHeap } from './heap.ts'

export type SearchStatus = 'running' | 'success' | 'noPath' | 'timeout' | 'canceled'

export type SearchResult = {
  status: SearchStatus
  /** Cells after the start, in order (the start cell is implicit). */
  path: Cell[]
  /** Executable moves for `path`; empty when the start is already the best. */
  moves: Move[]
  /** Best cell reached so far (the goal on success). */
  best: Cell
  nodes: number
  generated: number
  elapsedMs: number
}

export type SearchOptions = {
  sliceMs?: number
  maxNodes?: number
  timeoutMs?: number
  isCanceled?: () => boolean
  avoidance?: AvoidancePolicy
}

const DEFAULT_SLICE_MS = 5
const DEFAULT_MAX_NODES = 20_000
const DEFAULT_TIMEOUT_MS = 3_000

type Parent = { cell: Cell; move: Move }

/**
 * Sharded A* over the same Move edges the executor runs. Nodes are feet cells;
 * an edge exists only when its move's `cost` is below COST_INF, so physically
 * infeasible edges never enter the open set.
 *
 * The world is read through `context()` once per slice; the executor revalidates
 * every remaining edge, so a stale search can only over-offer, never overrun.
 */
export class MotionSearch {
  private readonly start: Cell
  private readonly target: MotionGoal
  private readonly context: () => MoveContext
  private readonly open = new MinHeap()
  private readonly g = new Map<string, number>()
  private readonly closed = new Set<string>()
  private readonly parent = new Map<string, Parent>()
  private readonly sliceMs: number
  private readonly maxNodes: number
  private readonly timeoutMs: number
  private readonly isCanceled: () => boolean
  private readonly startedAt: number
  private readonly startKey: string
  private readonly avoidance: { coefficient: number; radiusSq: number; sources: Vec3[] } | undefined
  private best: Cell
  private bestH: number
  private nodes = 0
  private generated = 0
  private terminal: SearchResult | undefined

  constructor(start: Cell, goal: Cell | MotionGoal, context: () => MoveContext, options: SearchOptions = {}) {
    this.start = start
    this.target = isMotionGoal(goal) ? goal : createGoal(goal, { kind: 'exact' })
    this.context = context
    this.sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS
    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.isCanceled = options.isCanceled ?? (() => false)
    this.startedAt = Date.now()
    this.startKey = cellKey(start)
    this.avoidance = this.buildAvoidance(options.avoidance, this.target)
    this.best = start
    this.bestH = this.target.heuristic(start)
    this.g.set(this.startKey, 0)
    this.open.push(start, this.bestH, this.bestH)
  }

  /** Advance one bounded slice. `now` is used for the deadline check only. */
  step(now: number): SearchResult {
    if (this.terminal !== undefined) return this.terminal
    if (this.isCanceled()) return this.finish('canceled')
    const ctx = this.context()
    const sliceStart = performance.now()
    while (this.open.size > 0) {
      if (this.isCanceled()) return this.finish('canceled')
      if (this.nodes >= this.maxNodes) return this.finish('timeout')
      if (now - this.startedAt >= this.timeoutMs) return this.finish('timeout')
      if (this.nodes > 0 && performance.now() - sliceStart >= this.sliceMs) break
      const item = this.open.pop()
      if (item === undefined) break
      const key = cellKey(item.cell)
      if (this.closed.has(key)) continue
      this.closed.add(key)
      this.nodes += 1
      if (this.target.isEnd(item.cell)) return this.finish('success', item.cell)
      const distance = this.target.heuristic(item.cell)
      if (distance < this.bestH) {
        this.bestH = distance
        this.best = item.cell
      }
      this.expand(item.cell, ctx)
      if (performance.now() - sliceStart >= this.sliceMs) break
    }
    if (this.open.size === 0) return this.finish('noPath')
    return { status: 'running', ...this.snapshot(this.best) }
  }

  result(): SearchResult {
    return this.terminal ?? { status: 'running', ...this.snapshot(this.best) }
  }

  /** Snapshot hostile entities once per search; cost stays soft. */
  private buildAvoidance(
    policy: AvoidancePolicy | undefined,
    goal: MotionGoal,
  ): { coefficient: number; radiusSq: number; sources: Vec3[] } | undefined {
    if (policy === undefined || policy.coefficient <= 1 || policy.radius <= 0) return undefined
    const ctx = this.context()
    const target = goal.target ?? this.start
    const radius = Math.max(1, policy.radius)
    const box = {
      min: {
        x: Math.min(this.start.x, target.x) - radius,
        y: Math.min(this.start.y, target.y) - radius,
        z: Math.min(this.start.z, target.z) - radius,
      },
      max: {
        x: Math.max(this.start.x, target.x) + radius,
        y: Math.max(this.start.y, target.y) + radius,
        z: Math.max(this.start.z, target.z) + radius,
      },
    }
    const sources = ctx.world.entities(box)
      .filter(entity => entity.hostile === true)
      .map(entity => ({ ...entity.position }))
    if (sources.length === 0) return undefined
    return { coefficient: policy.coefficient, radiusSq: radius * radius, sources }
  }

  private avoidanceMultiplier(cell: Cell): number {
    if (this.avoidance === undefined) return 1
    let multiplier = 1
    for (const source of this.avoidance.sources) {
      const dx = cell.x - source.x
      const dy = cell.y - source.y
      const dz = cell.z - source.z
      if (dx * dx + dy * dy + dz * dz <= this.avoidance.radiusSq) multiplier *= this.avoidance.coefficient
    }
    return multiplier
  }

  private expand(cell: Cell, ctx: MoveContext): void {
    const key = cellKey(cell)
    const base = this.g.get(key) ?? Number.POSITIVE_INFINITY
    for (const move of motionNeighbors(cell, ctx)) {
      const next = move.dest
      const cost = move.cost(ctx) * this.avoidanceMultiplier(next)
      if (cost === COST_INF) continue
      const nextKey = cellKey(next)
      if (this.closed.has(nextKey)) continue
      const candidate = base + cost
      const known = this.g.get(nextKey)
      if (known !== undefined && known <= candidate) continue
      this.g.set(nextKey, candidate)
      this.parent.set(nextKey, { cell, move })
      this.generated += 1
      const h = this.target.heuristic(next)
      this.open.push(next, candidate + h, h)
    }
  }

  private finish(status: SearchStatus, best = this.best): SearchResult {
    this.terminal = { status, ...this.snapshot(best) }
    return this.terminal
  }

  private snapshot(best: Cell): Omit<SearchResult, 'status'> {
    const cells: Cell[] = [best]
    const moves: Move[] = []
    let cursor = best
    while (!sameCell(cursor, this.start)) {
      const parent = this.parent.get(cellKey(cursor))
      if (parent === undefined) break
      moves.push(parent.move)
      cursor = parent.cell
      cells.push(cursor)
    }
    cells.reverse()
    moves.reverse()
    return {
      path: cells.slice(1),
      moves,
      best,
      nodes: this.nodes,
      generated: this.generated,
      elapsedMs: Date.now() - this.startedAt,
    }
  }
}

export function motionNeighbors(cell: Cell, ctx: MoveContext): Move[] {
  const moves: Move[] = []
  const directions: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dz] of directions) {
    const flat = { x: cell.x + dx, y: cell.y, z: cell.z + dz }
    moves.push(new TraverseMove(cell, flat))
    moves.push(new AscendMove(cell, { x: flat.x, y: cell.y + 1, z: flat.z }))
    moves.push(new DescendMove(cell, { x: flat.x, y: cell.y - 1, z: flat.z }))
    for (let drop = 2; drop <= Math.max(ctx.constraints.maxFall, ctx.constraints.safeFallBudget ?? 0); drop += 1) {
      moves.push(new FallMove(cell, { x: flat.x, y: cell.y - drop, z: flat.z }))
    }
  }
  for (let drop = 1; drop <= ctx.constraints.maxFall; drop += 1) {
    moves.push(new DownwardMove(cell, { x: cell.x, y: cell.y - drop, z: cell.z }))
  }
  if (ctx.constraints.allowDiagonal) {
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      moves.push(new DiagonalMove(cell, { x: cell.x + dx, y: cell.y, z: cell.z + dz }))
    }
  }
  if (ctx.constraints.allowParkour) {
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
      moves.push(new ParkourMove(cell, { x: cell.x + dx, y: cell.y, z: cell.z + dz }))
    }
  }
  if (ctx.constraints.allowPlace) {
    for (const [dx, dz] of directions) {
      moves.push(new BridgeMove(cell, { x: cell.x + dx, y: cell.y, z: cell.z + dz }))
    }
    for (let levels = 1; levels <= 4; levels += 1) {
      moves.push(new PillarMove(cell, { x: cell.x, y: cell.y + levels, z: cell.z }))
    }
  }
  return moves
}

function isMotionGoal(value: Cell | MotionGoal): value is MotionGoal {
  return typeof value === 'object' && value !== null
    && typeof (value as { isEnd?: unknown }).isEnd === 'function'
    && typeof (value as { heuristic?: unknown }).heuristic === 'function'
}
