import type { BlockInfo, EntityInfo, Vec3 } from '../../body/api.ts'
import { nearestStandCell, standCells } from '../../motion/search/index.ts'
import { boxAround } from '../sensors.ts'
import { createReadOnlyMotionWorld, isStandable } from '../standing.ts'
import type { Candidate, WorldView } from '../types.ts'

export { isStandable, standability } from '../standing.ts'

/** Reflex queries run per tick; keep the reachability walk small. */
const REFLEX_REACH_NODES = 128

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

/**
 * Nearest standable cell to `desired`, searching a radius around `center`.
 * The window, the standability check and the reachability walk all come from
 * the core stand query; this wrapper only picks the ordering.
 */
export function nearestStandable(
  world: WorldView,
  center: Vec3,
  radius: number,
  desired: Vec3 = center,
  vertical = 2,
  exclude?: Vec3,
): Vec3 | undefined {
  const query = nearestStandCell(
    createReadOnlyMotionWorld(point => world.blockAt(point)),
    {
      near: center,
      desired,
      reach: { horizontal: radius, vertical },
      ...(exclude === undefined
        ? {}
        : { accept: (cell: Vec3) => cell.x !== exclude.x || cell.y !== exclude.y || cell.z !== exclude.z }),
    },
    { from: feetOf(world.self.pos), reachability: { maxNodes: REFLEX_REACH_NODES } },
  )
  return query.best?.cell
}

/** Farthest standable cell from `threat`, for when no explicit retreat exists. */
export function farthestStandable(
  world: WorldView,
  center: Vec3,
  radius: number,
  threat: Vec3,
  vertical = 2,
): Vec3 | undefined {
  const result = standCells(
    createReadOnlyMotionWorld(point => world.blockAt(point)),
    { near: center, desired: threat, reach: { horizontal: radius, vertical } },
    { from: feetOf(world.self.pos), reachability: { maxNodes: REFLEX_REACH_NODES } },
  )
  const proven = result.cells.filter(candidate => candidate.reachable !== 'no')
  const pool = proven.length > 0 ? proven : result.cells
  let best: Vec3 | undefined
  let bestDistance = -1
  for (const candidate of pool) {
    const distance = Math.hypot(candidate.cell.x - threat.x, candidate.cell.z - threat.z)
    if (distance > bestDistance) {
      best = candidate.cell
      bestDistance = distance
    }
  }
  return best
}

export function moveCandidate(target: Vec3, keys: string, timeoutMs = 8_000, range = 1): Candidate {
  return {
    driverId: 'move',
    target: { kind: 'point', pos: target },
    params: { x: target.x, y: target.y, z: target.z, range, timeoutMs, continuationKey: keys },
    keys,
  }
}
