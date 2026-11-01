import type { BlockInfo, EntityInfo, Vec3 } from '../../port/index.ts'
import { boxAround } from '../sensors.ts'
import { isStandable } from '../standing.ts'
import type { Candidate, WorldView } from '../types.ts'

export { isStandable } from '../standing.ts'

/** Lower-level entity names the escape giver treats as immediate danger. */
export const HOSTILE_NAMES: ReadonlySet<string> = new Set([
  'zombie',
  'husk',
  'drowned',
  'skeleton',
  'stray',
  'creeper',
  'spider',
  'cave_spider',
  'enderman',
  'witch',
  'pillager',
  'vindicator',
  'evoker',
  'ravager',
  'phantom',
  'blaze',
  'wither_skeleton',
  'piglin',
  'piglin_brute',
  'zoglin',
])

export function feetOf(pos: Vec3): Vec3 {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
}

export function isAirName(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

export function isFluidName(name: string): boolean {
  return name === 'water' || name === 'lava'
}

export function isSolid(block: BlockInfo | null): boolean {
  return block !== null && block.loaded && !isAirName(block.name) && !isFluidName(block.name)
}

export function hostilesNear(world: WorldView, center: Vec3, radius: number): EntityInfo[] {
  return world.entitiesIn(boxAround(center, radius))
    .filter(entity => HOSTILE_NAMES.has(entity.name))
}

/** Nearest standable cell to `desired`, searching a radius around `center`. */
export function nearestStandable(
  world: WorldView,
  center: Vec3,
  radius: number,
  desired: Vec3 = center,
  vertical = 2,
  exclude?: Vec3,
): Vec3 | undefined {
  let best: Vec3 | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dy = -vertical; dy <= vertical; dy += 1) {
        const candidate = { x: center.x + dx, y: center.y + dy, z: center.z + dz }
        if (exclude !== undefined
          && candidate.x === exclude.x && candidate.y === exclude.y && candidate.z === exclude.z) continue
        if (!isStandable(world, candidate)) continue
        const distance = Math.hypot(
          candidate.x - desired.x,
          candidate.y - desired.y,
          candidate.z - desired.z,
        )
        if (distance < bestDistance) {
          best = candidate
          bestDistance = distance
        }
      }
    }
  }
  return best
}

/** Farthest standable cell from `threat`, for when no explicit retreat exists. */
export function farthestStandable(
  world: WorldView,
  center: Vec3,
  radius: number,
  threat: Vec3,
  vertical = 2,
): Vec3 | undefined {
  let best: Vec3 | undefined
  let bestDistance = -1
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dy = -vertical; dy <= vertical; dy += 1) {
        const candidate = { x: center.x + dx, y: center.y + dy, z: center.z + dz }
        if (!isStandable(world, candidate)) continue
        const distance = Math.hypot(candidate.x - threat.x, candidate.z - threat.z)
        if (distance > bestDistance) {
          best = candidate
          bestDistance = distance
        }
      }
    }
  }
  return best
}

export function moveCandidate(target: Vec3, keys: string, timeoutMs = 8_000, range = 1): Candidate {
  return {
    driverId: 'move',
    target: { kind: 'point', pos: target },
    params: { x: target.x, y: target.y, z: target.z, range, timeoutMs },
    keys,
  }
}
