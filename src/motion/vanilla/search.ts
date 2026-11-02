import { cellKey, offset, sameCell } from '../model/block.ts'
import type { Cell } from '../model/types.ts'
import { MinHeap } from '../search/heap.ts'
import { VanillaNodeReader, type VanillaNode } from './classify.ts'

/**
 * Vanilla's calm fall budget: `Mob.getMaxFallDistance()` is
 * `LivingEntity.getComfortableFallDistance(0)` = `floor(0 + 3)` = 3, and
 * `WalkNodeEvaluator.tryFindFirstGroundNodeBelow` blocks anything deeper.
 */
export const VANILLA_MAX_FALL = 3
/** Vanilla step-up ceiling for a player: max(1.125, maxUpStep) = 1.125. */
export const VANILLA_STEP_UP = 1.125

export type VanillaPlan = {
  /** `success` = the plan ends on the snapped goal; `partial` = best-so-far. */
  status: 'success' | 'partial'
  /** Cells after the search root, in order. Empty when already there. */
  waypoints: Cell[]
  /** The snapped target cell (`undefined` when the goal block is unloaded). */
  goalAdjustedTo?: Cell
  /** Whether the plan ends exactly on `goalAdjustedTo`. */
  reached: boolean
  /** Manhattan distance from the plan end to `goalAdjustedTo` (Infinity when unloaded). */
  closest: number
  nodes: number
}

export type VanillaPlanOptions = {
  /** A* node budget; vanilla uses `floor(followRange * 16)` (256 for 16). */
  maxNodes?: number
  /** Region radius in blocks; vanilla uses `followRange + 8`. */
  maxDistance?: number
  timeoutMs?: number
  maxFall?: number
  cancel?: () => boolean
}

const DEFAULT_MAX_NODES = 1024
const DEFAULT_MAX_DISTANCE = 32
const DEFAULT_TIMEOUT_MS = 250

const DIAGONALS: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const CARDINALS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)
}

function euclidean(a: Cell, b: Cell): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/**
 * Vanilla goal adjustment (`GroundPathNavigation.createPath`): an air target is
 * snapped to the cell above the first ground below it; a solid target is
 * snapped to the cell above it; anything else is used as-is. An unloaded goal
 * chunk returns `undefined` (vanilla returns null).
 */
export function snapGoal(reader: VanillaNodeReader, goal: Cell): Cell | undefined {
  if (reader.block(goal) === null) return undefined
  if (reader.isAir(goal)) {
    let below = offset(goal, 0, -1, 0)
    let guard = 0
    while (reader.isAir(below)) {
      if (reader.block(below) === null || guard++ > 400) return undefined
      below = offset(below, 0, -1, 0)
    }
    if (reader.block(below) === null) return undefined
    return offset(below, 0, 1, 0)
  }
  if (!reader.isSolid(goal)) return goal
  return offset(goal, 0, 1, 0)
}

type Step = {
  node: VanillaNode
  stepUp: boolean
  drop: number
}

/** The single landing node in a direction, resolved like `findAcceptedNode`. */
function land(
  reader: VanillaNodeReader,
  from: Cell,
  x: number,
  y: number,
  z: number,
  maxFall: number,
): Step | undefined {
  const same = reader.node({ x, y, z })
  if (same !== undefined) return { node: same, stepUp: false, drop: 0 }
  const up = reader.node({ x, y: y + 1, z })
  if (up !== undefined && reader.passable(offset(from, 0, 1, 0))) {
    return { node: up, stepUp: true, drop: 0 }
  }
  for (let drop = 1; drop <= maxFall; drop += 1) {
    const cell = { x, y: y - drop, z }
    let clear = true
    for (let yy = y - drop + 1; yy < y; yy += 1) {
      if (!reader.passable({ x, y: yy, z })) {
        clear = false
        break
      }
    }
    if (!clear) return undefined
    const node = reader.node(cell)
    if (node !== undefined) return { node, drop, stepUp: false }
    if (!reader.passable(cell)) return undefined
  }
  return undefined
}

function stepCost(step: Step): number {
  const block = step.node.kind === 'water'
    ? 2
    : step.node.kind === 'door'
      ? 1.5
      : step.node.kind === 'climbable' ? 1.5 : 1
  return block + (step.stepUp ? 0.5 : 0) + step.drop * 0.3
}

function neighbors(
  reader: VanillaNodeReader,
  from: Cell,
  fromKind: VanillaNode['kind'] | undefined,
  maxFall: number,
): Array<{ cell: Cell; cost: number }> {
  const result: Array<{ cell: Cell; cost: number }> = []
  const push = (step: Step | undefined): void => {
    if (step === undefined) return
    result.push({ cell: step.node.cell, cost: stepCost(step) })
  }
  for (const [dx, dz] of CARDINALS) {
    push(land(reader, from, from.x + dx, from.y, from.z + dz, maxFall))
  }
  for (const [dx, dz] of DIAGONALS) {
    // Vanilla only opens a diagonal when both orthogonal steps are valid and
    // neither of them is above the source (no diagonal step-up).
    const a = land(reader, from, from.x + dx, from.y, from.z, maxFall)
    const b = land(reader, from, from.x, from.y, from.z + dz, maxFall)
    if (a === undefined || b === undefined) continue
    if (a.node.cell.y > from.y || b.node.cell.y > from.y) continue
    push(land(reader, from, from.x + dx, from.y, from.z + dz, maxFall))
  }
  // Ladders/vines get vertical neighbors (vanilla mobs cannot climb; this is the
  // one deliberate extension, documented in MOTION.md §4.2).
  if (fromKind === 'climbable') {
    for (const dy of [1, -1]) {
      const cell = offset(from, 0, dy, 0)
      const node = reader.node(cell)
      if (node?.kind !== 'climbable') continue
      result.push({ cell, cost: 1.5 })
    }
  }
  return result
}

/**
 * A vanilla-shaped A*: 1-cell nodes, no per-edge preconditions, accuracy 0
 * (exact snapped goal). Like vanilla, it returns the best-so-far path when the
 * goal is not reached, so the caller can still walk closer.
 */
export function planVanillaPath(
  reader: VanillaNodeReader,
  start: Cell,
  goal: Cell,
  options: VanillaPlanOptions = {},
): VanillaPlan {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxFall = options.maxFall ?? VANILLA_MAX_FALL
  const cancel = options.cancel ?? (() => false)
  const startedAt = Date.now()

  const goalCell = snapGoal(reader, goal)
  if (goalCell === undefined) {
    return { status: 'partial', waypoints: [], reached: false, closest: Number.POSITIVE_INFINITY, nodes: 0 }
  }
  const root = reader.node(start) ?? reader.node(offset(start, 0, -1, 0)) ?? reader.node(offset(start, 0, 1, 0))
  if (root === undefined) {
    return { status: 'partial', waypoints: [], goalAdjustedTo: goalCell, reached: false, closest: manhattan(start, goalCell), nodes: 0 }
  }

  const rootKey = cellKey(root.cell)
  const g = new Map<string, number>([[rootKey, 0]])
  const parent = new Map<string, Cell>()
  const closed = new Set<string>()
  const open = new MinHeap()
  const heuristic = (cell: Cell): number => manhattan(cell, goalCell)
  open.push(root.cell, heuristic(root.cell), heuristic(root.cell))
  let nodes = 0
  let best: Cell = root.cell
  let bestDistance = heuristic(root.cell)
  let reached = bestDistance === 0

  while (open.size > 0 && !reached) {
    if (cancel()) break
    if (nodes >= maxNodes || Date.now() - startedAt > timeoutMs) break
    const popped = open.pop()!
    const key = cellKey(popped.cell)
    if (closed.has(key)) continue
    closed.add(key)
    nodes += 1

    const distance = heuristic(popped.cell)
    if (distance < bestDistance) {
      bestDistance = distance
      best = popped.cell
    }
    if (distance === 0) {
      reached = true
      break
    }
    if (euclidean(popped.cell, root.cell) >= maxDistance) continue

    const current = reader.node(popped.cell)
    for (const next of neighbors(reader, popped.cell, current?.kind, maxFall)) {
      const nextKey = cellKey(next.cell)
      if (closed.has(nextKey)) continue
      const cost = (g.get(key) ?? Number.POSITIVE_INFINITY) + next.cost
      if (cost >= (g.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue
      g.set(nextKey, cost)
      parent.set(nextKey, popped.cell)
      const h = heuristic(next.cell)
      open.push(next.cell, cost + h, h)
    }
  }

  const end = reached ? goalCell : best
  const waypoints: Cell[] = []
  if (!sameCell(end, root.cell)) {
    const chain: Cell[] = []
    let cursor: Cell | undefined = end
    let guard = 0
    while (cursor !== undefined && !sameCell(cursor, root.cell) && guard++ < 4096) {
      chain.push(cursor)
      cursor = parent.get(cellKey(cursor))
    }
    chain.reverse()
    if (sameCell(chain[0] ?? end, root.cell)) chain.shift()
    waypoints.push(...chain)
  }

  return {
    status: reached ? 'success' : 'partial',
    waypoints,
    goalAdjustedTo: goalCell,
    reached,
    closest: heuristic(end),
    nodes,
  }
}
