import { describe, expect, it } from 'vitest'

import {
  countItem,
  diffPlacement,
  isPlaceSupport,
  isTargetOccupied,
  itemConsumed,
  retrySafe,
  snapshotPlaceNeighborhood,
} from '../src/provider/place-evidence.ts'

/**
 * Category: world evidence (place).
 * Protects: actual placement location and inventory consumption are observed
 * independently of `bot.placeBlock`'s destination-only confirmation.
 */
describe('place evidence', () => {
  const blockAt = (name: string, boundingBox = 'block') => () => ({ name, boundingBox })

  it('finds the target when it changed to the requested item', () => {
    const before = snapshotPlaceNeighborhood(blockAt('air'), { x: 1, y: 64, z: 0 })
    const after = snapshotPlaceNeighborhood((point) => point.x === 1 && point.y === 64 && point.z === 0
      ? { name: 'dirt', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }, { x: 1, y: 64, z: 0 })
    const diff = diffPlacement(before, after, 'dirt')

    expect(diff.placedCells).toEqual([{ x: 1, y: 64, z: 0 }])
    expect(diff.changedCells).toEqual([{ x: 1, y: 64, z: 0, name: 'dirt' }])
  })

  it('reports an off-target placement instead of hiding it', () => {
    const before = snapshotPlaceNeighborhood(blockAt('air'), { x: 1, y: 64, z: 0 })
    const after = snapshotPlaceNeighborhood((point) => point.x === 1 && point.y === 63 && point.z === 0
      ? { name: 'dirt', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' }, { x: 1, y: 64, z: 0 })
    const diff = diffPlacement(before, after, 'dirt')

    expect(diff.placedCells).toEqual([{ x: 1, y: 63, z: 0 }])
    expect(diff.placedCells).not.toContainEqual({ x: 1, y: 64, z: 0 })
  })

  it('distinguishes replaceable plants from occupied solid targets', () => {
    expect(isTargetOccupied({ name: 'grass_block', boundingBox: 'block' })).toBe(true)
    expect(isTargetOccupied({ name: 'short_grass', boundingBox: 'empty' })).toBe(false)
    expect(isTargetOccupied({ name: 'water', boundingBox: 'empty' })).toBe(false)
    expect(isTargetOccupied({ name: 'oak_fence', boundingBox: 'block' })).toBe(true)
  })

  it('requires collision for a placement reference', () => {
    expect(isPlaceSupport({ name: 'stone', boundingBox: 'block' })).toBe(true)
    expect(isPlaceSupport({ name: 'glass', boundingBox: 'block' })).toBe(true)
    expect(isPlaceSupport({ name: 'torch', boundingBox: 'empty' })).toBe(false)
    expect(isPlaceSupport({ name: 'water', boundingBox: 'empty' })).toBe(false)
    expect(isPlaceSupport(null)).toBe(false)
  })

  it('reads item counts and only treats a decrease as proven consumption', () => {
    const items = [{ name: 'dirt', count: 2 }, { name: 'stone', count: 1 }, { name: 'dirt', count: 3 }]
    expect(countItem(items, 'dirt')).toBe(5)
    expect(countItem(items, 'minecraft:dirt')).toBe(5)
    expect(itemConsumed(2, 1)).toBe(true)
    expect(itemConsumed(2, 2)).toBe(false)
    expect(itemConsumed(2, 3)).toBeNull()
  })

  it('allows face retry only for a refusal with no consumed item or placed block', () => {
    expect(retrySafe({
      message: 'Server refused to place dirt at (1, 64, 0): the block is still air',
      consumed: false,
      placedCells: [],
    })).toBe(true)
    expect(retrySafe({
      message: 'Server did not answer the placement',
      consumed: false,
      placedCells: [],
    })).toBe(false)
    expect(retrySafe({
      message: 'Server refused to place dirt',
      consumed: true,
      placedCells: [],
    })).toBe(false)
    expect(retrySafe({
      message: 'Server refused to place dirt',
      consumed: false,
      placedCells: [{ x: 1, y: 63, z: 0 }],
    })).toBe(false)
  })
})
