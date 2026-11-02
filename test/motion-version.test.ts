/**
 * Non-acceptance / 非验收: 26.1 content fixture. The real 26.1 server is not
 * available in this environment, so this only proves the data/classifier path;
 * it is not a game acceptance.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import { createRules, defaultConstraints, vanillaClassifier } from '../src/motion/model/index.ts'
import { TraverseMove } from '../src/motion/execute/index.ts'
import { FixtureWorld, FULL_CUBE, rawBlock } from './helpers/motion-world.ts'
import { MotionContextSource } from '../src/motion/mineflayer/context.ts'

const require = createRequire(import.meta.url)
const minecraftData = require('minecraft-data') as (version: string) => {
  blocksByName: Record<string, { id: number; states?: Array<{ name: string }> } | undefined>
}

const DOOR_TAGS = new Set([
  'minecraft:doors',
  'minecraft:wooden_doors',
  'minecraft:mob_interactable_doors',
])

describe('26.1 door fixture', () => {
  it('has pale_oak_door in 26.1 data, not in 1.21.1', () => {
    const modern = minecraftData('26.1').blocksByName.pale_oak_door
    expect(modern?.id).toBe(652)
    expect(modern?.states?.map(state => state.name)).toEqual(expect.arrayContaining(['half', 'open']))
    expect(minecraftData('1.21.1').blocksByName.pale_oak_door).toBeUndefined()
  })

  it('classifies a pale oak door from tags without a name table', () => {
    const tags = vanillaClassifier.classify({
      loaded: true,
      name: 'pale_oak_door',
      state: { half: 'lower', open: 'false' },
      collision: [],
      serverTags: DOOR_TAGS,
    })
    expect(tags).toEqual(expect.arrayContaining(['door', 'openable']))
  })

  it('opens a closed tagged pale oak door through the normal rules', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,63,-1', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,64,0', {
      ...rawBlock('pale_oak_door', FULL_CUBE, {
        half: 'lower', facing: 'north', hinge: 'left', open: 'false', powered: 'false',
      }),
      serverTags: DOOR_TAGS,
    })
    world.blocks.set('0,65,0', {
      ...rawBlock('pale_oak_door', FULL_CUBE, {
        half: 'upper', facing: 'north', hinge: 'left', open: 'false', powered: 'false',
      }),
      serverTags: DOOR_TAGS,
    })
    for (let y = 64; y <= 66; y += 1) {
      if (world.blockAt({ x: 0, y, z: -1 }) === null) world.blocks.set(`0,${y},-1`, rawBlock('air', []))
    }
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64, z: -0.5 } }
    const rules = createRules(world, defaultConstraints())
    expect(rules.doorState({ x: 0, y: 64, z: 0 })).toBe('closed')
    expect(rules.isDoorPassable({ x: 0, y: 64, z: 0 }, 'south')).toBe('yes')

    const source = new MotionContextSource(world, defaultConstraints())
    const move = new TraverseMove({ x: 0, y: 64, z: -1 }, { x: 0, y: 64, z: 0 })
    expect(move.cost(source.next())).toBeLessThan(Number.POSITIVE_INFINITY)
  })
})
