import { describe, expect, it } from 'vitest'

/**
 * Category: core software test (controlled pure input).
 * Protects: the discrete vanilla arrow model and the low-angle aim solver;
 * failure mode is a trajectory that silently disagrees with the server model.
 */

import {
  BOW_PROFILE,
  CROSSBOW_PROFILE,
  horizontalRange,
  segmentHitsBox,
  simulateShot,
  solveAim,
  verticalDrop,
} from '../src/mind/ranged/ballistics.ts'

const origin = { x: 0, y: 70, z: 0 }

describe('ranged ballistics', () => {
  it('matches the discrete arrow model at full draw', () => {
    const points = simulateShot(origin, 0, 0, BOW_PROFILE, 20)
    expect(points).toHaveLength(21)
    expect(points[20]!.x).toBeCloseTo(0, 6)
    expect(points[20]!.y).toBeCloseTo(70 - 8.953, 2)
    expect(points[20]!.z).toBeCloseTo(-54.628, 2)
  })

  it('reports horizontal range and drop from the same closed form', () => {
    expect(horizontalRange(60, 0.2, BOW_PROFILE)).toBeCloseTo(60, 6)
    expect(verticalDrop(20, 0, BOW_PROFILE)).toBeCloseTo(-8.953, 3)
    expect(CROSSBOW_PROFILE.speed).toBeCloseTo(3.15, 6)
  })

  it('solves a low-angle shot at 60 blocks', () => {
    const result = solveAim(origin, { x: 60, y: 70, z: 0 }, BOW_PROFILE)
    expect('code' in result).toBe(false)
    if ('code' in result) return
    expect(result.pitch).toBeGreaterThan(0)
    expect(result.pitch).toBeLessThan(Math.PI / 4)
    expect(result.flightTicks).toBeGreaterThan(0)
    expect(Math.abs(result.impact.y - 70)).toBeLessThan(0.3)
  })

  it('handles a target above and below the shooter', () => {
    const above = solveAim(origin, { x: 20, y: 75, z: 0 }, BOW_PROFILE)
    const below = solveAim(origin, { x: 20, y: 65, z: 0 }, BOW_PROFILE)
    expect('code' in above).toBe(false)
    expect('code' in below).toBe(false)
    if ('code' in above || 'code' in below) return
    expect(above.pitch).toBeGreaterThan(below.pitch)
  })

  it('refuses a range beyond the model limit', () => {
    const result = solveAim(origin, { x: 350, y: 70, z: 0 }, BOW_PROFILE)
    expect(result).toMatchObject({ code: 'OUT_OF_RANGE' })
  })

  it('intersects a target AABB along a segment', () => {
    expect(segmentHitsBox(
      { x: 0, y: 70, z: 0 },
      { x: 2, y: 70, z: 0 },
      { x: 1.5, y: 69.5, z: -0.5 },
      { x: 2.5, y: 71, z: 0.5 },
    )).toBe(true)
    expect(segmentHitsBox(
      { x: 0, y: 70, z: 0 },
      { x: 2, y: 70, z: 0 },
      { x: 1.5, y: 72, z: -0.5 },
      { x: 2.5, y: 73, z: 0.5 },
    )).toBe(false)
  })
})
