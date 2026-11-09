import type { Box, EntityInfo, SelfInfo, Vec3 } from '../body/api.ts'

const PLAYER_WIDTH = 0.6
const PLAYER_HEIGHT = 1.8
const ITEM_WIDTH = 0.25
const ITEM_HEIGHT = 0.25

/** Player AABB in vanilla coordinates: center x/z, feet y. */
export function playerBox(self: SelfInfo): Box {
  const width = self.width ?? PLAYER_WIDTH
  const height = self.height ?? PLAYER_HEIGHT
  return {
    min: { x: self.pos.x - width / 2, y: self.pos.y, z: self.pos.z - width / 2 },
    max: { x: self.pos.x + width / 2, y: self.pos.y + height, z: self.pos.z + width / 2 },
  }
}

/** ItemEntity AABB; mineflayer reports center x/z and feet y. */
export function itemBox(entity: EntityInfo): Box {
  const width = entity.width ?? ITEM_WIDTH
  const height = entity.height ?? ITEM_HEIGHT
  return {
    min: { x: entity.position.x - width / 2, y: entity.position.y, z: entity.position.z - width / 2 },
    max: { x: entity.position.x + width / 2, y: entity.position.y + height, z: entity.position.z + width / 2 },
  }
}

/** Player.aiStep's pickup query box: player AABB inflated 1.0/0.5/1.0. */
export function pickupQueryBox(self: SelfInfo): Box {
  return inflateBox(playerBox(self), 1, 0.5, 1)
}

export function inflateBox(box: Box, x: number, y: number, z: number): Box {
  return {
    min: { x: box.min.x - x, y: box.min.y - y, z: box.min.z - z },
    max: { x: box.max.x + x, y: box.max.y + y, z: box.max.z + z },
  }
}

/** AABB.intersects uses strict inequalities; touching faces do not intersect. */
export function intersects(left: Box, right: Box): boolean {
  return left.min.x < right.max.x && left.max.x > right.min.x
    && left.min.y < right.max.y && left.max.y > right.min.y
    && left.min.z < right.max.z && left.max.z > right.min.z
}

/** Shortest distance between boxes; 0 when they intersect. */
export function boxDistance(left: Box, right: Box): number {
  if (intersects(left, right)) return 0
  const dx = Math.max(0, right.min.x - left.max.x, left.min.x - right.max.x)
  const dy = Math.max(0, right.min.y - left.max.y, left.min.y - right.max.y)
  const dz = Math.max(0, right.min.z - left.max.z, left.min.z - right.max.z)
  return Math.hypot(dx, dy, dz)
}

export function canPickupFrom(self: SelfInfo, item: EntityInfo): boolean {
  return intersects(pickupQueryBox(self), itemBox(item))
}

/** Player box at a candidate standing cell (x/z block center, feet cell.y). */
export function playerBoxAt(cell: Vec3, self: SelfInfo): Box {
  return playerBox({
    ...self,
    pos: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 },
  })
}

export function canPickupAt(cell: Vec3, self: SelfInfo, item: EntityInfo): boolean {
  return intersects(inflateBox(playerBoxAt(cell, self), 1, 0.5, 1), itemBox(item))
}
