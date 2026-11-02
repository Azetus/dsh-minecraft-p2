import { cellKey } from '../model/block.ts'
import { createRules } from '../model/rules.ts'
import {
  defaultConstraints,
  type BlockClassifier,
  type Cell,
  type MotionConstraints,
  type MotionWorld,
  type SelfView,
  type Tri,
} from '../model/types.ts'
import { reachFrom } from './reach.ts'

/**
 * How far the query may look, in cells. `vertical` defaults to `horizontal`.
 * This is the reach envelope, not a caller-owned window: the query derives the
 * candidate box itself, so no call site repeats `-3..3`/`-2..2` loops.
 */
export type StandReach = { horizontal: number; vertical?: number }

export type StandCell = {
  cell: Cell
  /** Feet height from `Rules.standInfo` (a bottom slab is `cell.y - 0.5`). */
  feetY: number
  /** Distance to `desired`, in cell units. */
  distance: number
  /** Reachability from `from`; `unknown` when the BFS budget ran out. */
  reachable: Tri
  /** BFS edge count, only when reachable. */
  steps?: number
}

export type StandMiss = 'no-stand-cell' | 'unloaded-window' | 'outside-bounds' | 'no-window'

export type StandQuery = {
  /** Window anchor: every candidate is within `reach` of this cell. */
  near: Cell
  /** Ranking anchor; defaults to `near`. */
  desired?: Cell
  reach: StandReach
  /**
   * Business predicate (pickup AABB, covered-head check, ...). It receives the
   * derived feet height, so slab cells are evaluated where the body really is.
   */
  accept?: (cell: Cell, feetY: number) => boolean
}

export type StandOptions = {
  /** Feet cell the reachability walk starts from. */
  from: Cell
  constraints?: MotionConstraints
  classifier?: BlockClassifier
  self?: SelfView
  /** `false` skips reachability (cheap reflex queries); default 256 nodes. */
  reachability?: { maxNodes?: number } | false
}

export type StandResult = {
  state: 'found' | 'none'
  /** Sorted by distance to `desired`; the ordering policy stays at the call site. */
  cells: StandCell[]
  reason?: StandMiss
  /** `complete` means every reached-or-not verdict is proven, not budgeted. */
  coverage: 'complete' | 'budget' | 'skipped'
  scanned: number
  /** Candidates whose standability is unknown (unloaded, unknown collision). */
  unknown: number
}

const MAX_RADIUS = 8
const MAX_CELLS = 64
const DEFAULT_REACH_NODES = 256

export function standCells(
  world: MotionWorld,
  query: StandQuery,
  options: StandOptions,
): StandResult {
  const constraints = options.constraints ?? defaultConstraints()
  const rules = createRules(
    world,
    constraints,
    options.classifier === undefined ? {} : { classifier: options.classifier },
  )
  const desired = query.desired ?? query.near
  const horizontal = radiusOf(query.reach.horizontal)
  const vertical = radiusOf(query.reach.vertical ?? query.reach.horizontal)

  if (horizontal === 0 && vertical === 0) {
    return { state: 'none', cells: [], reason: 'no-window', coverage: 'skipped', scanned: 0, unknown: 0 }
  }

  // An anchor outside the constraint bounds cannot have a usable neighbour.
  const anchor = rules.standInfo(query.near)
  if (anchor.state === 'no' && anchor.reason === 'outside-bounds') {
    return {
      state: 'none',
      cells: [],
      reason: 'outside-bounds',
      coverage: 'skipped',
      scanned: 0,
      unknown: 0,
    }
  }

  const cells: StandCell[] = []
  let scanned = 0
  let unknown = 0
  for (let dx = -horizontal; dx <= horizontal; dx += 1) {
    for (let dz = -horizontal; dz <= horizontal; dz += 1) {
      for (let dy = -vertical; dy <= vertical; dy += 1) {
        scanned += 1
        const cell = { x: query.near.x + dx, y: query.near.y + dy, z: query.near.z + dz }
        const info = rules.standInfo(cell)
        if (info.state === 'unknown') {
          unknown += 1
          continue
        }
        if (info.state !== 'yes') continue
        if (query.accept !== undefined && !query.accept(cell, info.feetY)) continue
        cells.push({
          cell,
          feetY: info.feetY,
          distance: Math.hypot(cell.x - desired.x, cell.y - desired.y, cell.z - desired.z),
          reachable: 'unknown',
        })
      }
    }
  }

  let coverage: StandResult['coverage'] = 'skipped'
  if (cells.length > 0 && options.reachability !== false) {
    const reach = reachFrom(world, options.from, {
      ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
      ...(options.classifier === undefined ? {} : { classifier: options.classifier }),
      ...(options.self === undefined ? {} : { self: options.self }),
      maxNodes: options.reachability?.maxNodes ?? DEFAULT_REACH_NODES,
    })
    coverage = reach.complete ? 'complete' : 'budget'
    for (const candidate of cells) {
      const depth = reach.depth.get(cellKey(candidate.cell))
      if (depth === undefined) {
        // Unloaded cells block the walk exactly like walls, which is also what
        // the planner does, so a drained walk is a real verdict. Only the node
        // budget turns the verdict into `unknown`.
        candidate.reachable = reach.complete ? 'no' : 'unknown'
      } else {
        candidate.reachable = 'yes'
        candidate.steps = depth
      }
    }
  }

  cells.sort((left, right) => left.distance - right.distance
    || left.cell.y - right.cell.y
    || left.cell.x - right.cell.x
    || left.cell.z - right.cell.z)
  const limited = cells.slice(0, MAX_CELLS)
  if (limited.length === 0) {
    return {
      state: 'none',
      cells: [],
      reason: unknown > 0 ? 'unloaded-window' : 'no-stand-cell',
      coverage,
      scanned,
      unknown,
    }
  }
  return { state: 'found', cells: limited, coverage, scanned, unknown }
}

/**
 * Nearest cell the reachability walk proved reachable; falls back to the
 * nearest geometric candidate when nothing is proven (budget or blocked), so a
 * caller keeps its old single-target behaviour with an explicit `reachable`.
 */
export function nearestStandCell(
  world: MotionWorld,
  query: StandQuery,
  options: StandOptions,
): StandResult & { best?: StandCell } {
  const result = standCells(world, query, options)
  const best = result.cells.find(candidate => candidate.reachable !== 'no') ?? result.cells[0]
  return best === undefined ? result : { ...result, best }
}

function radiusOf(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_RADIUS, Math.trunc(value)))
}
