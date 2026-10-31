import type { WorkGiver } from '../types.ts'
import type { Candidate, EvalCtx, WorldView } from '../types.ts'
import {
  feetOf,
  farthestStandable,
  hostilesNear,
  moveCandidate,
  nearestStandable,
} from './common.ts'

/**
 * Constant-tree safety giver. It only reacts to observable, immediate danger:
 * lava, deep water, or a hostile within six blocks. Everything else is normal
 * work and must not preempt an order.
 */
export function createEscapeGiver(): WorkGiver {
  return {
    id: 'escape',
    find(_ctx: EvalCtx, world: WorldView): Candidate | null {
      const self = world.self
      const feet = feetOf(self.pos)

      if (self.inLava) {
        const target = nearestStandable(world, feet, 6, feet, 2)
        if (target === undefined) return null
        return moveCandidate(target, 'escape:lava', 4_000)
      }

      if (self.inWater && !self.onGround) {
        const target = nearestStandable(world, feet, 6, feet, 2)
        if (target === undefined) return null
        return moveCandidate(target, 'escape:water', 6_000)
      }

      const threat = hostilesNear(world, self.pos, 6)[0]
      if (threat === undefined) return null

      const dx = feet.x - Math.floor(threat.position.x)
      const dz = feet.z - Math.floor(threat.position.z)
      const length = Math.hypot(dx, dz)
      const desired = length === 0
        ? { x: feet.x + 5, y: feet.y, z: feet.z }
        : {
            x: Math.round(feet.x + (dx / length) * 5),
            y: feet.y,
            z: Math.round(feet.z + (dz / length) * 5),
          }
      const target = nearestStandable(world, feet, 7, desired, 2)
        ?? farthestStandable(world, feet, 7, threat.position, 2)
      if (target === undefined) return null
      return moveCandidate(target, `escape:hostile:${threat.id}`, 6_000)
    },
  }
}
