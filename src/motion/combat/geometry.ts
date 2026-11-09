import type { Vec3 } from '../model/types.ts'

export const DEFAULT_ENTITY_WIDTH = 0.6
export const DEFAULT_ENTITY_HEIGHT = 1.8
export const PLAYER_EYE_OFFSET = 0.18

/**
 * Player eye height. The adapter reports the player's AABB height; vanilla's
 * eye height is height - 0.18 (1.8 -> 1.62).
 */
export function eyeHeight(self: { height?: number }): number {
  return Math.max(0.1, (self.height ?? DEFAULT_ENTITY_HEIGHT) - PLAYER_EYE_OFFSET)
}

/**
 * Entity AABB from mineflayer's `position` (feet centre) and width/height.
 * Missing dimensions fall back to the player box.
 */
export function entityBox(entity: {
  position: Vec3
  width?: number
  height?: number
}): { min: Vec3; max: Vec3 } {
  const width = entity.width ?? DEFAULT_ENTITY_WIDTH
  const height = entity.height ?? DEFAULT_ENTITY_HEIGHT
  return {
    min: {
      x: entity.position.x - width / 2,
      y: entity.position.y,
      z: entity.position.z - width / 2,
    },
    max: {
      x: entity.position.x + width / 2,
      y: entity.position.y + height,
      z: entity.position.z + width / 2,
    },
  }
}

/**
 * Distance from the player's eye point to the nearest point of the target
 * AABB. A point inside the box is distance 0.
 */
export function eyeReach(
  self: { pos: Vec3; height?: number },
  entity: { position: Vec3; width?: number; height?: number },
): number {
  const box = entityBox(entity)
  const eye = {
    x: self.pos.x,
    y: self.pos.y + eyeHeight(self),
    z: self.pos.z,
  }
  const nearest = {
    x: Math.min(Math.max(eye.x, box.min.x), box.max.x),
    y: Math.min(Math.max(eye.y, box.min.y), box.max.y),
    z: Math.min(Math.max(eye.z, box.min.z), box.max.z),
  }
  return Math.hypot(eye.x - nearest.x, eye.y - nearest.y, eye.z - nearest.z)
}
