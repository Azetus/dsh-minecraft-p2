import type { BlockTag, Cell, ClassifiedBlock, CollisionBox } from './types.ts'

/** Player AABB used for clearance checks; vanilla survival dimensions. */
export const PLAYER_WIDTH = 0.6
export const PLAYER_HEIGHT = 1.8
export const PLAYER_HALF_WIDTH = PLAYER_WIDTH / 2
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
 * Does this block's collision intersect the player body at `feetY`? Returns
 * `undefined` when the collision is unknown. The support cell itself is not
 * reported: the body starts just above the derived feet height.
 */
export function bodyOverlap(
  block: ClassifiedBlock,
  cell: Cell,
  feetY: number,
): boolean | undefined {
  const boxes = collisionOf(block)
  if (boxes === undefined) return undefined
  const minX = cell.x + 0.5 - PLAYER_HALF_WIDTH
  const maxX = cell.x + 0.5 + PLAYER_HALF_WIDTH
  const minZ = cell.z + 0.5 - PLAYER_HALF_WIDTH
  const maxZ = cell.z + 0.5 + PLAYER_HALF_WIDTH
  const minY = feetY + EPSILON
  const maxY = feetY + PLAYER_HEIGHT - EPSILON
  for (const box of boxes) {
    const boxMinX = cell.x + box[0]
    const boxMinY = cell.y + box[1]
    const boxMinZ = cell.z + box[2]
    const boxMaxX = cell.x + box[3]
    const boxMaxY = cell.y + box[4]
    const boxMaxZ = cell.z + box[5]
    if (boxMaxX <= minX + EPSILON || boxMinX >= maxX - EPSILON) continue
    if (boxMaxZ <= minZ + EPSILON || boxMinZ >= maxZ - EPSILON) continue
    if (boxMaxY <= minY || boxMinY >= maxY) continue
    return true
  }
  return false
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
