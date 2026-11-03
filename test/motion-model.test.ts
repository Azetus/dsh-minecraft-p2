/**
 * Non-acceptance / 非验收: pure model and predicate tests. They protect the
 * three-state rules, block-state collision, classifier isolation and the matrix
 * fixtures. Real-game behaviour is verified separately on the live server.
 */
import { describe, expect, it } from 'vitest'

import {
  createRules,
  defaultConstraints,
  resolveConstraints,
  vanillaClassifier,
  vanillaTags,
  type BlockClassifier,
  type MotionConstraints,
} from '../src/motion/model/index.ts'
import { matrixBlockMap, matrixCommands, matrixFields } from '../src/motion/matrix/index.ts'
import {
  buildFixture,
  FixtureWorld,
  FULL_CUBE,
  HALF_CUBE,
  rawBlock,
} from './helpers/motion-world.ts'

function rulesFor(
  world: FixtureWorld,
  patch: Partial<MotionConstraints> = {},
  options: { classifier?: BlockClassifier } = {},
) {
  return createRules(world, resolveConstraints(defaultConstraints(), patch), options)
}

describe('motion rules: unknown is never air', () => {
  it('treats a missing block as unknown for support, passage and hazard', () => {
    const world = new FixtureWorld()
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({ state: 'unknown', reason: 'support-unloaded' })
    expect(rules.canWalkThrough({ x: 0, y: 64, z: 0 })).toBe('unknown')
    expect(rules.isHazard({ x: 0, y: 64, z: 0 })).toBe('unknown')
  })

  it('treats a loaded:false block as unknown, not as air', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', FULL_CUBE, {}, false))
    world.blocks.set('0,64,0', rawBlock('stone', FULL_CUBE, {}, false))
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({ state: 'unknown', reason: 'support-unloaded' })
    expect(rules.canWalkThrough({ x: 0, y: 64, z: 0 })).toBe('unknown')
  })
})

describe('motion rules: collision comes from block state', () => {
  it('stands on any collision cube regardless of the block name', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('mystery_block', FULL_CUBE))
    world.blocks.set('0,64,0', rawBlock('air', []))
    world.blocks.set('0,65,0', rawBlock('air', []))
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({ state: 'yes', feetY: 64 })
  })

  it('does not invent support from a familiar name with empty collision', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', []))
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({ state: 'no', reason: 'no-support' })
  })

  it('reports unknown when collision geometry is missing', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', undefined))
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({ state: 'unknown', reason: 'collision-unknown' })
    expect(rules.canPlaceAgainst({ x: 0, y: 63, z: 0 })).toBe('unknown')
  })

  it('derives the feet height from a partial support', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone_slab', HALF_CUBE))
    world.blocks.set('0,64,0', rawBlock('air', []))
    world.blocks.set('0,65,0', rawBlock('air', []))
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({ state: 'yes', feetY: 63.5 })
  })

  it('rejects a support whose top is above one block', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('fence', [[0.375, 0, 0.375, 0.625, 1.5, 0.625]]))
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({
      state: 'no',
      reason: 'support-too-high',
      blockedBy: [{ layer: 'support', cell: { x: 0, y: 63, z: 0 }, name: 'fence' }],
    })
    expect(rules.canWalkOn({ x: 0, y: 63, z: 0 })).toBe('no')
  })
})

describe('motion rules: body clearance', () => {
  it('needs two clear cells above a full support', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,64,0', rawBlock('air', []))
    world.blocks.set('0,65,0', rawBlock('air', []))
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 }).state).toBe('yes')

    world.blocks.set('0,64,0', rawBlock('stone', FULL_CUBE))
    rules.invalidate()
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({
      state: 'no',
      reason: 'body-collision',
      blockedBy: [{ layer: 'feet', cell: { x: 0, y: 64, z: 0 }, name: 'stone' }],
    })
  })

  it('rejects a head-height collision', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,64,0', rawBlock('air', []))
    world.blocks.set('0,65,0', rawBlock('stone', FULL_CUBE))
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({
      state: 'no',
      reason: 'body-collision',
      blockedBy: [{ layer: 'head', cell: { x: 0, y: 65, z: 0 }, name: 'stone' }],
    })
  })

  it("does not let a slab's own top count as a wall", () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone_slab', HALF_CUBE))
    world.blocks.set('0,64,0', rawBlock('air', []))
    world.blocks.set('0,65,0', rawBlock('air', []))
    const rules = rulesFor(world)
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({ state: 'yes', feetY: 63.5 })
  })
})

describe('motion rules: doors and gates', () => {
  function doorWorld(name: string, open: string | undefined): FixtureWorld {
    const world = new FixtureWorld()
    const lower = open === undefined
      ? { half: 'lower', facing: 'north', hinge: 'left' }
      : { half: 'lower', facing: 'north', hinge: 'left', open }
    world.blocks.set('0,64,0', rawBlock(name, open === 'true' ? [] : FULL_CUBE, lower))
    world.blocks.set('0,65,0', rawBlock(name, open === 'true' ? [] : FULL_CUBE, { ...lower, half: 'upper' }))
    return world
  }

  it('passes an open wooden door and a closed one when opening is allowed', () => {
    const open = doorWorld('oak_door', 'true')
    expect(rulesFor(open).doorState({ x: 0, y: 64, z: 0 })).toBe('open')
    expect(rulesFor(open).isDoorPassable({ x: 0, y: 64, z: 0 }, 'south')).toBe('yes')

    const closed = doorWorld('oak_door', 'false')
    expect(rulesFor(closed).doorState({ x: 0, y: 64, z: 0 })).toBe('closed')
    expect(rulesFor(closed).isDoorPassable({ x: 0, y: 64, z: 0 }, 'south')).toBe('yes')
    expect(rulesFor(closed, { allowDoor: false }).isDoorPassable({ x: 0, y: 64, z: 0 }, 'south')).toBe('no')
  })

  it('refuses an iron door even when it is closed', () => {
    const world = doorWorld('iron_door', 'false')
    const rules = rulesFor(world)
    expect(rules.doorState({ x: 0, y: 64, z: 0 })).toBe('locked')
    expect(rules.isDoorPassable({ x: 0, y: 64, z: 0 }, 'south')).toBe('no')
  })

  it('keeps an unknown door state unknown', () => {
    const world = doorWorld('oak_door', undefined)
    const rules = rulesFor(world)
    expect(rules.doorState({ x: 0, y: 64, z: 0 })).toBe('unknown')
    expect(rules.isDoorPassable({ x: 0, y: 64, z: 0 }, 'south')).toBe('unknown')
  })

  it('handles a closed fence gate as passable', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,64,0', rawBlock('oak_fence_gate', FULL_CUBE, { open: 'false' }))
    const rules = rulesFor(world)
    expect(rules.doorState({ x: 0, y: 64, z: 0 })).toBe('closed')
    expect(rules.isGatePassable({ x: 0, y: 64, z: 0 }, 'east')).toBe('yes')
  })
})

describe('motion rules: classifier is the only name-aware layer', () => {
  it('follows a custom classifier even for a name the vanilla table does not know', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('mystery_block', FULL_CUBE))
    world.blocks.set('0,64,0', rawBlock('air', []))
    const hazardAll: BlockClassifier = { classify: () => ['hazard'] }
    const rules = rulesFor(world, {}, { classifier: hazardAll })
    expect(rules.isHazard({ x: 0, y: 63, z: 0 })).toBe('yes')
    expect(rules.standInfo({ x: 0, y: 64, z: 0 })).toEqual({
      state: 'no',
      reason: 'hazard-support',
      blockedBy: [{ layer: 'support', cell: { x: 0, y: 63, z: 0 }, name: 'mystery_block' }],
    })
  })

  it('vanilla tags lava as hazard and distinguishes wooden from iron doors', () => {
    expect(vanillaTags('lava')).toEqual(expect.arrayContaining(['hazard', 'lava']))
    expect(vanillaTags('oak_door')).toEqual(expect.arrayContaining(['door', 'openable']))
    expect(vanillaTags('iron_door')).toEqual(expect.arrayContaining(['door', 'locked']))
    expect(vanillaTags('iron_door')).not.toContain('openable')
    expect(vanillaTags('water')).toEqual(expect.arrayContaining(['water', 'replaceable']))
    expect(vanillaTags('magma_block')).toEqual(expect.arrayContaining(['hazard', 'magma']))
  })

  it('never lets classification rewrite collision geometry', () => {
    const block = { loaded: true, name: 'stone', state: {}, collision: [] } as const
    expect(vanillaClassifier.classify(block)).not.toContain('solid')
    expect(vanillaClassifier.classify({ ...block, collision: FULL_CUBE })).toContain('solid')
  })

  it('uses server tags before names for doors and gates', () => {
    const tagged = (name: string, tags: string[]) => vanillaClassifier.classify({
      loaded: true,
      name,
      state: {},
      collision: [],
      serverTags: new Set(tags),
    })
    expect(tagged('pale_oak_door', ['minecraft:doors', 'minecraft:wooden_doors']))
      .toEqual(expect.arrayContaining(['door', 'openable']))
    expect(tagged('pale_oak_door', ['minecraft:doors']))
      .toEqual(expect.arrayContaining(['door', 'locked']))
    expect(tagged('iron_door', ['minecraft:doors']))
      .toEqual(expect.arrayContaining(['door', 'locked']))
    expect(tagged('copper_door', ['minecraft:doors', 'minecraft:mob_interactable_doors']))
      .toEqual(expect.arrayContaining(['door', 'openable']))
    expect(tagged('oak_fence_gate', ['minecraft:fence_gates']))
      .toEqual(expect.arrayContaining(['gate', 'openable']))
  })

  it('uses server tags for climbable, replaceable and fire', () => {
    const tagged = (tags: string[]) => vanillaClassifier.classify({
      loaded: true,
      name: 'mystery_block',
      state: {},
      collision: [],
      serverTags: new Set(tags),
    })
    expect(tagged(['minecraft:climbable'])).toContain('climbable')
    expect(tagged(['minecraft:replaceable'])).toContain('replaceable')
    expect(tagged(['minecraft:fire'])).toContain('hazard')
    expect(tagged(['minecraft:campfires'])).toContain('hazard')
  })

  it('does not fall back to a name suffix when tags are authoritative', () => {
    const tagged = (name: string, tags: string[]) => vanillaClassifier.classify({
      loaded: true,
      name,
      state: {},
      collision: [],
      serverTags: new Set(tags),
    })
    // A door-like name with explicit non-door tags is not a door.
    expect(tagged('oak_door', [])).not.toContain('door')
    // An unknown name with the doors tag is a door; iron rule stays conservative.
    expect(tagged('mystery_block', ['minecraft:doors'])).toEqual(expect.arrayContaining(['door', 'locked']))
  })
})

describe('motion rules: placement reference and constraints', () => {
  it('requires a loaded solid box for placement reference', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', FULL_CUBE))
    const rules = rulesFor(world)
    expect(rules.canPlaceAgainst({ x: 0, y: 63, z: 0 })).toBe('yes')
    expect(rules.canPlaceAgainst({ x: 0, y: 64, z: 0 })).toBe('unknown')
  })

  it('denies world-changing actions by default', () => {
    const constraints = defaultConstraints()
    expect(constraints.allowBreak).toBe(false)
    expect(constraints.allowPlace).toBe(false)
    expect(constraints.allowParkour).toBe(false)
    expect(constraints.maxFall).toBe(2)
    expect(resolveConstraints(constraints, { allowPlace: true, profile: 'parkour' })).toMatchObject({
      allowPlace: true,
      profile: 'parkour',
      allowBreak: false,
    })
  })

  it('honours the world border as a hard rule', () => {
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', FULL_CUBE))
    const rules = rulesFor(world, {
      worldBorder: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 128, z: 0 } },
    })
    expect(rules.standInfo({ x: 5, y: 64, z: 0 })).toEqual({ state: 'no', reason: 'outside-bounds' })
  })
})

describe('movement matrix fixtures', () => {
  const fields = matrixFields({ x: 0, y: 100, z: 0 })

  it('defines the required fields in a stable order', () => {
    expect(fields.map(field => field.id)).toEqual([
      'flat', 'step-up', 'gap-1', 'door', 'drop-2', 'bridge', 'pillar', 'diagonal',
    ])
  })

  it('builds a standable start for every field and a standable goal where P1 expects success', () => {
    for (const field of fields) {
      const world = buildFixture(field)
      const rules = createRules(world, defaultConstraints())
      expect(rules.standInfo(field.start).state, `${field.id} start`).toBe('yes')
      if (field.expect.p1 === 'success') {
        expect(rules.standInfo(field.goal).state, `${field.id} goal`).toBe('yes')
      }
    }
  })

  it('leaves the gap cell unstandable and marks its P1 expectation as unreachable', () => {
    const gap = fields.find(field => field.id === 'gap-1')
    expect(gap).toBeDefined()
    if (gap === undefined) return
    const world = buildFixture(gap)
    const rules = createRules(world, defaultConstraints())
    expect(rules.standInfo({ x: gap.origin.x, y: gap.origin.y + 1, z: gap.origin.z + 3 }).state).toBe('no')
    expect(gap.expect.p1).toBe('unreachable')
    expect(gap.expect.p3).toBe('success')
  })

  it('emits LAN setup commands, including door state and gap removal', () => {
    const door = fields.find(field => field.id === 'door')
    const gap = fields.find(field => field.id === 'gap-1')
    expect(door).toBeDefined()
    expect(gap).toBeDefined()
    if (door === undefined || gap === undefined) return
    const doorCommands = matrixCommands(door)
    expect(doorCommands[0]).toMatch(/^\/fill .* air$/)
    expect(doorCommands.some(command => command.includes('oak_door[half=lower'))).toBe(true)
    expect(doorCommands.some(command => command.includes('oak_door[half=upper'))).toBe(true)
    const gapCommands = matrixCommands(gap)
    expect(gapCommands.some(command => command.startsWith('/fill') && command.endsWith(' air'))).toBe(true)
  })

  it('keeps the door state in the fixture block map', () => {
    const door = fields.find(field => field.id === 'door')
    if (door === undefined) return
    const map = matrixBlockMap(door)
    const lower = map.get(`${door.origin.x},${door.origin.y + 1},${door.origin.z + 3}`)
    expect(lower?.name).toBe('oak_door')
    expect(lower?.state?.half).toBe('lower')
  })
})
