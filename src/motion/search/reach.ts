import { cellKey, floorCell } from '../model/block.ts'
import { createRules } from '../model/rules.ts'
import {
  COST_INF,
  defaultConstraints,
  type BlockClassifier,
  type Cell,
  type MotionConstraints,
  type MotionWorld,
  type MoveContext,
  type SelfView,
} from '../model/types.ts'
import { motionNeighbors } from './astar.ts'

export type ReachOptions = {
  maxNodes?: number
  constraints?: MotionConstraints
  classifier?: BlockClassifier
  self?: SelfView
}

/**
 * Bounded breadth-first reachability over the same edges A* uses: a cell is
 * reachable only when some `motionNeighbors` move has a finite cost. `complete`
 * is false when the node budget stopped the walk, so an unseen cell is
 * *unknown*, never proven unreachable.
 */
export type ReachResult = {
  /** `cellKey` -> edge count from `from`. */
  depth: Map<string, number>
  complete: boolean
  nodes: number
}

const DEFAULT_MAX_NODES = 96

export function reachFrom(
  world: MotionWorld,
  from: Cell,
  options: ReachOptions = {},
): ReachResult {
  const constraints = options.constraints ?? defaultConstraints()
  const rules = createRules(
    world,
    constraints,
    options.classifier === undefined ? {} : { classifier: options.classifier },
  )
  const self = options.self ?? world.self()
  const ctx: MoveContext = {
    world,
    rules,
    constraints,
    self,
    tick: 0,
    now: 0,
    position: from,
  }
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? DEFAULT_MAX_NODES))
  const origin = floorCell(from)
  const depth = new Map<string, number>([[cellKey(origin), 0]])
  const queue: Cell[] = [origin]
  let cursor = 0
  let complete = true
  while (cursor < queue.length) {
    if (depth.size >= maxNodes) {
      complete = false
      break
    }
    const cell = queue[cursor]!
    cursor += 1
    const base = depth.get(cellKey(cell)) ?? 0
    for (const move of motionNeighbors(cell, ctx)) {
      if (move.cost(ctx) >= COST_INF) continue
      const key = cellKey(move.dest)
      if (depth.has(key)) continue
      depth.set(key, base + 1)
      queue.push(move.dest)
      if (depth.size >= maxNodes) {
        complete = false
        break
      }
    }
  }
  return { depth, complete, nodes: depth.size }
}
