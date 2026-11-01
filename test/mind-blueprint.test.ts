import { describe, expect, it } from 'vitest'

import { blueprintMaterials, blueprintPlan, parseBlueprint } from '../src/mind/blueprint.ts'

/**
 * Category: data (M3-02 blueprint ingestion).
 * Protects: final geometry validation, absolute-to-relative translation, and
 * material counts before any world write.
 */

const valid = {
  blocks: [
    { x: -2, y: 64, z: 3, name: 'minecraft:dirt' },
    { x: -1, y: 64, z: 3, name: 'dirt' },
  ],
}

describe('blueprint parser', () => {
  it('accepts final geometry and normalizes block names', () => {
    const parsed = parseBlueprint(valid)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.blueprint.blocks).toEqual([
      { x: -2, y: 64, z: 3, name: 'dirt' },
      { x: -1, y: 64, z: 3, name: 'dirt' },
    ])
  })

  it('rejects duplicate cells, empty/oversized input and bad coordinates', () => {
    expect(parseBlueprint({ blocks: [] }).ok).toBe(false)
    expect(parseBlueprint({ blocks: [valid.blocks[0], valid.blocks[0]] }).ok).toBe(false)
    expect(parseBlueprint({ blocks: [{ x: 0.5, y: 64, z: 0, name: 'dirt' }] }).ok).toBe(false)
    expect(parseBlueprint({ blocks: [{ x: 0, y: 64, z: 0, name: '' }] }).ok).toBe(false)
    expect(parseBlueprint({ blocks: valid.blocks, script: ['dig'] }).ok).toBe(false)
    expect(parseBlueprint({ blocks: new Array(4097).fill({ x: 0, y: 0, z: 0, name: 'dirt' }) }).ok).toBe(false)
  })

  it('validates an optional sealed-room verifier', () => {
    const parsed = parseBlueprint({
      blocks: valid.blocks,
      verify: { kind: 'sealed-room', min: { x: -3, y: 63, z: 2 }, max: { x: 0, y: 65, z: 4 } },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.blueprint.verify?.kind).toBe('sealed-room')

    const bad = parseBlueprint({
      blocks: valid.blocks,
      verify: { kind: 'sealed-room', min: { x: 0, y: 63, z: 2 }, max: { x: -1, y: 65, z: 4 } },
    })
    expect(bad.ok).toBe(false)
  })

  it('validates a usable-room verifier and translates door/bed offsets', () => {
    const parsed = parseBlueprint({
      blocks: [
        { x: 5, y: 64, z: -2, name: 'dirt' },
        { x: 6, y: 64, z: -2, name: 'dirt' },
        { x: 7, y: 64, z: -2, name: 'red_bed' },
        { x: 5, y: 64, z: -1, name: 'oak_door' },
      ],
      verify: {
        kind: 'usable-room',
        min: { x: 5, y: 64, z: -2 },
        max: { x: 7, y: 65, z: -1 },
        door: { x: 5, y: 64, z: -1 },
        bed: { x: 7, y: 64, z: -2 },
      },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = blueprintPlan(parsed.blueprint, 'ord-usable')
    expect(plan.verify).toMatchObject({
      kind: 'usable-room',
      min: [0, 0, 0],
      max: [2, 1, 1],
      door: [0, 0, 1],
      bed: [2, 0, 0],
    })
  })

  it('rejects a usable-room verifier without proper triples', () => {
    expect(parseBlueprint({
      blocks: valid.blocks,
      verify: { kind: 'usable-room', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, door: [0, 0] },
    }).ok).toBe(false)
  })

  it('rejects an unknown blueprint version', () => {
    const parsed = parseBlueprint({ version: 2, blocks: valid.blocks })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.join(' ')).toContain('version')
  })
})

describe('blueprint to plan', () => {
  it('uses the minimum corner as origin and keeps absolute verify bounds', () => {
    const parsed = parseBlueprint({
      blocks: [
        { x: 5, y: 64, z: -2, name: 'dirt' },
        { x: 6, y: 64, z: -2, name: 'dirt' },
      ],
      verify: { kind: 'sealed-room', min: { x: 4, y: 63, z: -3 }, max: { x: 7, y: 65, z: -1 } },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = blueprintPlan(parsed.blueprint, 'ord-bp')
    expect(plan.origin).toEqual({ x: 5, y: 64, z: -2 })
    expect(plan.workItems).toHaveLength(2)
    expect(plan.workItems[0]).toMatchObject({
      kind: 'place',
      at: [0, 0, 0],
      expected: { name: 'dirt' },
    })
    expect(plan.verify).toEqual({
      kind: 'sealed-room',
      min: [-1, -1, -1],
      max: [2, 1, 1],
    })
  })

  it('counts materials by block name', () => {
    const parsed = parseBlueprint(valid)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(blueprintMaterials(parsed.blueprint)).toEqual({ dirt: 2 })
  })
})
