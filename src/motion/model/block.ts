import type { BlockTag, Box, Cell, ClassifiedBlock, CollisionBox, Vec3 } from './types.ts'

/** Player AABB used for clearance checks; vanilla survival dimensions. */
export const PLAYER_WIDTH = 0.6
export const PLAYER_HEIGHT = 1.8
export const PLAYER_HALF_WIDTH = PLAYER_WIDTH / 2
/**
 * Vanilla waypoint tolerance (`0.75 - bbWidth / 2`, so 0.45 for a player):
 * arrival is judged on the horizontal distance to the node centre.
 */
export const WAYPOINT_TOLERANCE = 0.75 - PLAYER_WIDTH / 2
const EPSILON = 0.001

export function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y},${cell.z}`
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

export function offset(cell: Cell, dx: number, dy: number, dz: number): Cell {
  return { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }
}

export function floorCell(p: { x: number; y: number; z: number }): Cell {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

/**
 * Feet cell for a continuous position. Path cells are "support + 1"; a bottom
 * slab puts the real feet at y-0.5, so the slab-aware rounding is `floor(y+0.5)`
 * rather than a plain floor.
 */
export function cellOf(pos: { x: number; y: number; z: number }): Cell {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y + 0.5), z: Math.floor(pos.z) }
}

export function cellCenter(cell: Cell): { x: number; y: number; z: number } {
  return { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 }
}

export function hasTag(block: ClassifiedBlock, tag: BlockTag): boolean {
  return block.tags.includes(tag)
}

/**
 * Collision geometry for a block: `undefined` is unknown. A loaded block with
 * no collision boxes is air-like, which is different from unknown.
 */
export function collisionOf(block: ClassifiedBlock): readonly CollisionBox[] | undefined {
  return block.loaded ? block.collision : undefined
}

/**
 * Highest support surface at the player's centre within one block, or
 * `undefined` when the geometry is unknown. Center coordinates are local to the
 * block (0.5, 0.5 for a block centre). A cube returns 1, a bottom slab 0.5, a
 * carpet 0.0625. Sides/fences return a value above 1 and are rejected by the
 * caller as non-standable.
 */
export function topSurfaceAt(
  block: ClassifiedBlock,
  centerX: number,
  centerZ: number,
): number | undefined {
  const boxes = collisionOf(block)
  if (boxes === undefined) return undefined
  let top = 0
  for (const box of boxes) {
    if (centerX <= box[0] || centerX >= box[3]) continue
    if (centerZ <= box[2] || centerZ >= box[5]) continue
    if (box[4] > top) top = box[4]
  }
  return top
}

/**
 * Sample points across the player's 0.6-wide footprint, in local block units.
 * A single centre sample misses shapes whose collision boxes split exactly at
 * the centre (stairs are `[0,0,0,1,0.5,1]` + `[0,0.5,0,1,1,0.5]`), so the
 * support height must be taken over the whole footprint the body occupies.
 */
export const FOOTPRINT_SAMPLES = [0.2, 0.5, 0.8] as const

/**
 * Highest surface the body can actually stand on within the footprint, or
 * `undefined` when the geometry is unknown. This is the support height used by
 * `Rules.standInfo`: a stair returns 1 (its riser), a bottom slab 0.5, a ladder
 * 0 (the thin plate is outside the footprint), a fence above 1 (rejected as too
 * high support).
 */
export function supportTopAt(block: ClassifiedBlock): number | undefined {
  const boxes = collisionOf(block)
  if (boxes === undefined) return undefined
  let top = 0
  for (const centerX of FOOTPRINT_SAMPLES) {
    for (const centerZ of FOOTPRINT_SAMPLES) {
      for (const box of boxes) {
        if (centerX <= box[0] || centerX >= box[3]) continue
        if (centerZ <= box[2] || centerZ >= box[5]) continue
        if (box[4] > top) top = box[4]
      }
    }
  }
  return top
}

/**
 * The player's real 0.6x1.8 AABB at a continuous feet position. Vanilla keeps
 * the horizontal centre at `pos` and the vertical span [pos.y, pos.y + height],
 * so a body near a block boundary covers more than one column.
 */
export function bodyBoxAt(pos: Vec3): Box {
  return {
    min: { x: pos.x - PLAYER_HALF_WIDTH, y: pos.y, z: pos.z - PLAYER_HALF_WIDTH },
    max: { x: pos.x + PLAYER_HALF_WIDTH, y: pos.y + PLAYER_HEIGHT, z: pos.z + PLAYER_HALF_WIDTH },
  }
}

/** Body AABB for a path cell whose body is centred in the cell. */
export function bodyBoxAtCell(cell: Cell, feetY: number): Box {
  return {
    min: { x: cell.x + 0.5 - PLAYER_HALF_WIDTH, y: feetY, z: cell.z + 0.5 - PLAYER_HALF_WIDTH },
    max: { x: cell.x + 0.5 + PLAYER_HALF_WIDTH, y: feetY + PLAYER_HEIGHT, z: cell.z + 0.5 + PLAYER_HALF_WIDTH },
  }
}

/**
 * Does this block's collision intersect an explicit player body box? Returns
 * `undefined` when the collision is unknown. Touching faces do not overlap.
 */
export function blockOverlapsBox(block: ClassifiedBlock, cell: Cell, box: Box): boolean | undefined {
  const boxes = collisionOf(block)
  if (boxes === undefined) return undefined
  const minY = box.min.y + EPSILON
  const maxY = box.max.y - EPSILON
  for (const single of boxes) {
    const boxMinX = cell.x + single[0]
    const boxMinY = cell.y + single[1]
    const boxMinZ = cell.z + single[2]
    const boxMaxX = cell.x + single[3]
    const boxMaxY = cell.y + single[4]
    const boxMaxZ = cell.z + single[5]
    if (boxMaxX <= box.min.x + EPSILON || boxMinX >= box.max.x - EPSILON) continue
    if (boxMaxZ <= box.min.z + EPSILON || boxMinZ >= box.max.z - EPSILON) continue
    if (boxMaxY <= minY || boxMinY >= maxY) continue
    return true
  }
  return false
}

/**
 * Does this block's collision intersect the player body at `feetY`? Returns
 * `undefined` when the collision is unknown. The support cell itself is not
 * reported: the body starts just above the derived feet height.
 */
export function bodyOverlap(
  block: ClassifiedBlock,
  cell: Cell,
  feetY: number,
): boolean | undefined {
  return blockOverlapsBox(block, cell, bodyBoxAtCell(cell, feetY))
}

/** True when the block can be replaced without first breaking it. */
export function isReplaceable(block: ClassifiedBlock): boolean {
  return hasTag(block, 'replaceable')
}

/** True for a loaded block that can be used as a placement reference. */
export function isPlaceReference(block: ClassifiedBlock): boolean {
  if (!block.loaded) return false
  if (hasTag(block, 'hazard') || hasTag(block, 'lava') || hasTag(block, 'water')) return false
  const boxes = collisionOf(block)
  if (boxes === undefined) return false
  return boxes.length > 0
}
