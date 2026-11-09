import { describe, expect, it } from 'vitest'

import {
  canPickupAt,
  canPickupFrom,
  intersects,
  itemBox,
  pickupQueryBox,
  playerBox,
} from '../src/mind/aabb.ts'
import type { Box, EntityInfo, SelfInfo } from '../src/body/api.ts'

const self: SelfInfo = {
  pos: { x: 0.5, y: 64, z: 0.5 },
  yaw: 0,
  pitch: 0,
  health: 20,
  food: 20,
  onGround: true,
  inWater: false,
  inLava: false,
  width: 0.6,
  height: 1.8,
}

const item = (position: { x: number; y: number; z: number }): EntityInfo => ({
  id: 'item-1',
  name: 'item',
  position,
  width: 0.25,
  height: 0.25,
  item: { name: 'dirt', count: 1 },
})

describe('pickup AABB', () => {
  it('uses strict AABB intersection so touching faces do not count', () => {
    const left: Box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
    const touching: Box = { min: { x: 1, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } }
    const overlapping: Box = { min: { x: 0.99, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } }
    expect(intersects(left, touching)).toBe(false)
    expect(intersects(left, overlapping)).toBe(true)
  })

  it('builds the vanilla inflated player query box', () => {
    const query = pickupQueryBox(self)
    expect(query).toMatchObject({
      min: { x: -0.8, y: 63.5, z: -0.8 },
      max: { x: 1.8, y: 66.3, z: 1.8 },
    })
    expect(playerBox(self)).toMatchObject({
      min: { x: 0.2, y: 64, z: 0.2 },
      max: { x: 0.8, y: 65.8, z: 0.8 },
    })
  })

  it('accepts an item whose AABB intersects even when centre distance is large', () => {
    const drop = item({ x: 1.4, y: 64, z: 0.5 })
    expect(canPickupFrom(self, drop)).toBe(true)
    expect(playerBox(self).max.x - playerBox(self).min.x).toBeCloseTo(0.6)
    expect(itemBox(drop).min.x).toBeCloseTo(1.275)
  })

  it('rejects a cell whose inflated query box does not intersect the item', () => {
    const drop = item({ x: 5, y: 64, z: 0.5 })
    expect(canPickupAt({ x: 0, y: 64, z: 0 }, self, drop)).toBe(false)
  })
})
