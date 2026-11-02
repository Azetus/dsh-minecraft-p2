import { cellKey } from '../model/block.ts'
import { createRules } from '../model/rules.ts'
import {
  COST_INF,
  defaultConstraints,
  type BlockClassifier,
  type Cell,
  type MotionConstraints,
  type MotionWorld,
  type MoveContext,
} from '../model/types.ts'
import { motionNeighbors } from './astar.ts'

export type ReachabilityOptions = {
  maxNodes?: number
  constraints?: MotionConstraints
  classifier?: BlockClassifier
}

const DEFAULT_MAX_NODES = 96

/**
 * Bounded reachability over the same move edges as A*. This is intentionally a
 * hint (one cheap BFS), not a replacement for a full path search: placement
 * scores many stances and must not run A* for each one. Doors, drops and
 * hazards still use the same Rules as the planner.
 */
export function reachableCells(
  world: MotionWorld,
  start: Cell,
  options: ReachabilityOptions = {},
): Set<string> {
  const constraints = options.constraints ?? defaultConstraints()
  const rules = createRules(world, constraints, options.classifier === undefined ? {} : { classifier: options.classifier })
  const self = world.self()
  const ctx: MoveContext = {
    world,
    rules,
    constraints,
    self,
    tick: 0,
    now: 0,
    position: self.pos,
  }
  const origin = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) }
  const maxNodes = Math.max(1, options.maxNodes ?? DEFAULT_MAX_NODES)
  const seen = new Set<string>([cellKey(origin)])
  const queue: Cell[] = [origin]
  while (queue.length > 0 && seen.size < maxNodes) {
    const cell = queue.shift()!
    for (const move of motionNeighbors(cell, ctx)) {
      if (move.cost(ctx) >= COST_INF) continue
      const key = cellKey(move.dest)
      if (seen.has(key)) continue
      seen.add(key)
      queue.push(move.dest)
      if (seen.size >= maxNodes) break
    }
  }
  return seen
}
