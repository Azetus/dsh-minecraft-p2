import type { WorkGiver } from '../types.ts'
import type { Candidate, EvalCtx, WorldView } from '../types.ts'
import {
  feetOf,
  farthestStandable,
  hostilesNear,
  isSolid,
  isStandable,
  moveCandidate,
  nearestStandable,
} from './common.ts'

/**
 * Constant-tree safety giver. It only reacts to observable, immediate danger:
 * lava, deep water, or a hostile within six blocks. Everything else is normal
 * work and must not preempt an order.
 */
export function createEscapeGiver(): WorkGiver {
  let held: { threat: string; target: { x: number; y: number; z: number }; at: number; kind: 'cover' | 'hostile' } | undefined
  return {
    id: 'escape',
    find(ctx: EvalCtx, world: WorldView): Candidate | null {
      const self = world.self
      const feet = feetOf(self.pos)

      if (self.inLava || (self.inWater && !self.onGround)) {
        held = undefined
        if (self.inLava) {
          const target = nearestStandable(world, feet, 6, feet, 2)
          if (target === undefined) return null
          return moveCandidate(target, 'escape:lava', 4_000)
        }
        const target = nearestStandable(world, feet, 6, feet, 2)
        if (target === undefined) return null
        return moveCandidate(target, 'escape:water', 6_000)
      }

      const threat = hostilesNear(world, self.pos, 6)[0]
      if (threat === undefined) {
        held = undefined
        return null
      }

      // A phantom or ranged mob cannot hit through a solid roof. Prefer a
      // covered standable cell before an open-field retreat.
      if (held !== undefined
        && held.kind === 'cover'
        && held.threat === threat.id
        && ctx.now - held.at < 3_000
        && isStandable(world, held.target)) {
        return moveCandidate(held.target, `escape:cover:${threat.id}`, 6_000)
      }
      const cover = nearestCoveredStandable(world, feet, 6)
      if (cover !== undefined) {
        held = { threat: threat.id, target: cover, at: ctx.now, kind: 'cover' }
        return moveCandidate(cover, `escape:cover:${threat.id}`, 6_000)
      }

      // Keep one retreat target for the same threat. Recomputing every tick
      // makes the candidate target jitter and causes preempt/restart thrash.
      if (held !== undefined
        && held.kind === 'hostile'
        && held.threat === threat.id
        && ctx.now - held.at < 3_000
        && isStandable(world, held.target)) {
        return moveCandidate(held.target, `escape:hostile:${threat.id}`, 6_000)
      }

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
      held = { threat: threat.id, target, at: ctx.now, kind: 'hostile' }
      return moveCandidate(target, `escape:hostile:${threat.id}`, 6_000)
    },
  }
}

/** Nearest standable cell with a solid block directly above the head. */
function nearestCoveredStandable(
  world: WorldView,
  center: { x: number; y: number; z: number },
  radius: number,
): { x: number; y: number; z: number } | undefined {
  let best: { x: number; y: number; z: number } | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        const candidate = { x: center.x + dx, y: center.y + dy, z: center.z + dz }
        if (!isStandable(world, candidate)) continue
        if (!isSolid(world.blockAt({ x: candidate.x, y: candidate.y + 2, z: candidate.z }))) continue
        const distance = Math.hypot(dx, dy, dz)
        if (distance < bestDistance) {
          best = candidate
          bestDistance = distance
        }
      }
    }
  }
  return best
}
