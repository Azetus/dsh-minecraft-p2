/**
 * Non-acceptance / 非验收: the core stand query. These are pure-model
 * regressions for the API `approach`/`pickup`/givers call; live acceptance is
 * the approach/pickup script.
 */
import { describe, expect, it } from 'vitest'

import { cellOf } from '../src/motion/model/index.ts'
import { nearestStandCell, reachFrom, standCells } from '../src/motion/search/index.ts'
import { matrixFields } from '../src/motion/matrix/index.ts'
import { buildFixture, FixtureWorld, FULL_CUBE, HALF_CUBE, rawBlock } from './helpers/motion-world.ts'

const AIR = [] as const

function flat(radius = 4): FixtureWorld {
  const world = new FixtureWorld()
  for (let x = -radius; x <= radius; x += 1) {
    for (let z = -radius; z <= radius; z += 1) {
      world.blocks.set(`${x},63,${z}`, rawBlock('stone', FULL_CUBE))
      world.blocks.set(`${x},64,${z}`, rawBlock('air', AIR))
      world.blocks.set(`${x},65,${z}`, rawBlock('air', AIR))
    }
  }
  world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64, z: 0.5 } }
  return world
}

const from = { x: 0, y: 64, z: 0 }

describe('stand query', () => {
  it('finds a neighbour when the target block itself cannot be stood on', () => {
    const world = flat()
    world.blocks.set('2,64,0', rawBlock('stone', FULL_CUBE))
    const result = nearestStandCell(
      world,
      { near: { x: 2, y: 64, z: 0 }, reach: { horizontal: 3, vertical: 2 } },
      { from },
    )
    expect(result.state).toBe('found')
    expect(result.best).toBeDefined()
    expect(result.best?.cell).not.toEqual({ x: 2, y: 64, z: 0 })
    expect(result.best?.reachable).toBe('yes')
    expect(result.best?.feetY).toBe(64)
  })

  it('walks through a closed wooden door to reach a target behind it', () => {
    const field = matrixFields({ x: 0, y: 100, z: 0 }).find(entry => entry.id === 'door')!
    const world = buildFixture(field)
    const result = nearestStandCell(
      world,
      { near: { x: 0, y: 101, z: 6 }, reach: { horizontal: 3, vertical: 2 } },
      { from: field.start },
    )
    expect(result.state).toBe('found')
    expect(result.coverage).toBe('complete')
    expect(result.best?.reachable).toBe('yes')
  })

  it('proves a target across a one-cell gap unreachable without parkour', () => {
    const field = matrixFields({ x: 0, y: 100, z: 0 }).find(entry => entry.id === 'gap-1')!
    const world = buildFixture(field)
    const result = nearestStandCell(
      world,
      { near: { x: 0, y: 101, z: 6 }, reach: { horizontal: 3, vertical: 2 } },
      { from: field.start },
    )
    expect(result.state).toBe('found')
    expect(result.coverage).toBe('complete')
    expect(result.best?.reachable).toBe('no')
  })

  it('reports an unloaded window instead of a standable cell', () => {
    const world = flat(1)
    const result = standCells(
      world,
      { near: { x: 20, y: 64, z: 0 }, reach: { horizontal: 3, vertical: 2 } },
      { from },
    )
    expect(result.state).toBe('none')
    expect(result.reason).toBe('unloaded-window')
    expect(result.unknown).toBeGreaterThan(0)
  })

  it('treats an unloaded border as blocked, exactly like the planner', () => {
    // One loaded column only: the walk cannot expand. This matches what A*
    // would conclude from the same snapshot; only a budget stop is `unknown`.
    const world = new FixtureWorld()
    world.blocks.set('0,63,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('0,64,0', rawBlock('air', AIR))
    world.blocks.set('0,65,0', rawBlock('air', AIR))
    world.blocks.set('2,63,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('2,64,0', rawBlock('air', AIR))
    world.blocks.set('2,65,0', rawBlock('air', AIR))
    const result = nearestStandCell(
      world,
      { near: { x: 2, y: 64, z: 0 }, reach: { horizontal: 3, vertical: 2 } },
      { from },
    )
    expect(result.state).toBe('found')
    expect(result.coverage).toBe('complete')
    expect(result.cells.find(cell => cell.cell.x === 2 && cell.cell.z === 0)?.reachable).toBe('no')
  })

  it('prefers a reachable cell over a nearer pocketed one', () => {
    const world = flat()
    // Standable but sealed pocket at (2,64,0): stone on all four sides.
    world.blocks.set('2,63,0', rawBlock('stone', FULL_CUBE))
    world.blocks.set('2,64,0', rawBlock('air', AIR))
    world.blocks.set('2,65,0', rawBlock('air', AIR))
    for (const [x, z] of [[1, 0], [3, 0], [2, 1], [2, -1]] as const) {
      world.blocks.set(`${x},64,${z}`, rawBlock('stone', FULL_CUBE))
      world.blocks.set(`${x},65,${z}`, rawBlock('stone', FULL_CUBE))
    }
    // Target block is the pocket's only wall opening: the pocket itself is
    // closer (distance 1) than the open cell at (0,64,2).
    const result = nearestStandCell(
      world,
      {
        near: { x: 1, y: 64, z: 0 },
        reach: { horizontal: 3, vertical: 2 },
        accept: cell => cell.x !== 1 || cell.z !== 0,
      },
      { from },
    )
    expect(result.state).toBe('found')
    expect(result.best?.reachable).toBe('yes')
    expect(result.best?.cell).not.toEqual({ x: 2, y: 64, z: 0 })
  })

  it('reports the derived feet height of a bottom slab to the accept predicate', () => {
    const world = flat()
    // Stone floor at 63, bottom slab at 64: the standable cell is 65 and the
    // real feet are at 64.5, not at the cell base.
    world.blocks.set('2,64,0', rawBlock('oak_slab', HALF_CUBE, { type: 'bottom' }))
    world.blocks.set('2,65,0', rawBlock('air', AIR))
    world.blocks.set('2,66,0', rawBlock('air', AIR))
    const seen: number[] = []
    const result = standCells(
      world,
      {
        near: { x: 2, y: 64, z: 0 },
        reach: { horizontal: 1, vertical: 1 },
        accept: (cell, feetY) => {
          if (cell.x === 2 && cell.y === 65 && cell.z === 0) seen.push(feetY)
          return true
        },
      },
      { from },
    )
    expect(result.state).toBe('found')
    expect(seen).toEqual([64.5])
  })

  it('marks reachability unknown when the budget runs out', () => {
    const world = flat(6)
    // The window must not contain the BFS origin, otherwise that one cell is
    // legitimately reached even with a one-node budget.
    const result = standCells(
      world,
      { near: { x: 4, y: 64, z: 0 }, reach: { horizontal: 2, vertical: 2 } },
      { from, reachability: { maxNodes: 1 } },
    )
    expect(result.coverage).toBe('budget')
    expect(result.cells.every(cell => cell.reachable === 'unknown')).toBe(true)
  })

  it('skips reachability when the caller asks for a cheap query', () => {
    const world = flat()
    const result = standCells(
      world,
      { near: { x: 2, y: 64, z: 0 }, reach: { horizontal: 2, vertical: 2 } },
      { from, reachability: false },
    )
    expect(result.coverage).toBe('skipped')
    expect(result.cells.every(cell => cell.reachable === 'unknown')).toBe(true)
  })

  it('excludes the target cell only when the caller asks', () => {
    const world = flat()
    const included = nearestStandCell(
      world,
      { near: { x: 1, y: 64, z: 0 }, reach: { horizontal: 1, vertical: 1 } },
      { from },
    )
    expect(included.cells.some(cell => cell.cell.x === 1 && cell.cell.z === 0)).toBe(true)
    const excluded = nearestStandCell(
      world,
      {
        near: { x: 1, y: 64, z: 0 },
        reach: { horizontal: 1, vertical: 1 },
        accept: cell => cell.x !== 1 || cell.z !== 0,
      },
      { from },
    )
    expect(excluded.cells.every(cell => cell.cell.x !== 1 || cell.cell.z !== 0)).toBe(true)
  })

  it('derives the same feet cell as the executor', () => {
    expect(cellOf({ x: 1.5, y: 64, z: 0.5 })).toEqual({ x: 1, y: 64, z: 0 })
    expect(cellOf({ x: 1.5, y: 63.5, z: 0.5 })).toEqual({ x: 1, y: 64, z: 0 })
  })
})

describe('reachFrom', () => {
  it('reports exhaustion and budget separately', () => {
    const world = flat(2)
    const complete = reachFrom(world, from, { maxNodes: 500 })
    expect(complete.complete).toBe(true)
    expect(complete.depth.size).toBeGreaterThan(4)
    const budget = reachFrom(world, from, { maxNodes: 1 })
    expect(budget.complete).toBe(false)
    expect(budget.depth.size).toBe(1)
  })

  it('uses the same door edge as the planner', () => {
    const field = matrixFields({ x: 0, y: 100, z: 0 }).find(entry => entry.id === 'door')!
    const world = buildFixture(field)
    const reach = reachFrom(world, field.start, { maxNodes: 500 })
    expect(reach.depth.has('0,101,6')).toBe(true)
  })
})
