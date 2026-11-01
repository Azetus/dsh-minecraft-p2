import { standingAt } from '../port/terrain.ts'
import type { Vec3 } from '../port/index.ts'
import type { WorldView } from './types.ts'

/** One shared standability rule for givers, plans and verifiers. */
export function isStandable(world: WorldView, position: Vec3): boolean {
  return standingAt(point => world.blockAt(point), position).state === 'valid'
}

/** Full result for diagnostics; callers can report the concrete reason. */
export function standability(world: WorldView, position: Vec3) {
  return standingAt(point => world.blockAt(point), position)
}
