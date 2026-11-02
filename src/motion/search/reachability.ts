import type { Cell, MotionWorld } from '../model/types.ts'
import { reachFrom, type ReachOptions } from './reach.ts'

export type ReachabilityOptions = ReachOptions

/**
 * Bounded reachability set over the same move edges as A*. This is intentionally
 * a hint (one cheap BFS), not a replacement for a full path search: placement
 * scores many stances and must not run A* for each one. Doors, drops and
 * hazards still use the same Rules as the planner.
 */
export function reachableCells(
  world: MotionWorld,
  start: Cell,
  options: ReachabilityOptions = {},
): Set<string> {
  return new Set(reachFrom(world, start, options).depth.keys())
}
