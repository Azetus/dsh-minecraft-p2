/**
 * Non-acceptance / 非验收: A* edge filtering, budget and best-so-far. The
 * fixtures are the same matrix descriptions used by the live field builder.
 */
import { describe, expect, it } from 'vitest'

import { MotionContextSource } from '../src/motion/mineflayer/context.ts'
import {
  createGoal,
  defaultConstraints,
  resolveConstraints,
  type MotionConstraints,
} from '../src/motion/model/index.ts'
import { matrixFields } from '../src/motion/matrix/index.ts'
import { MinHeap, MotionSearch, reachableCells, type SearchOptions, type SearchResult } from '../src/motion/search/index.ts'
import { buildFixture, FixtureWorld, FULL_CUBE, rawBlock } from './helpers/motion-world.ts'

function contextFor(world: FixtureWorld, patch: Partial<MotionConstraints> = {}) {
  return new MotionContextSource(world, resolveConstraints(defaultConstraints(), patch))
}

function solve(
  fieldId: string,
  patch: Partial<MotionConstraints> = {},
  options: SearchOptions = {},
): { result: SearchResult; world: FixtureWorld } {
  const field = matrixFields({ x: 0, y: 100, z: 0 }).find(entry => entry.id === fieldId)
  if (field === undefined) throw new Error(`missing field ${fieldId}`)
  const world = buildFixture(field)
  const source = contextFor(world, patch)
  const search = new MotionSearch(field.start, field.goal, () => source.next(), {
    sliceMs: 50,
    timeoutMs: 2_000,
    ...options,
  })
  let result = search.step(Date.now())
  let guard = 0
  while (result.status === 'running' && guard < 1_000) {
    result = search.step(Date.now())
    guard += 1
  }
  return { result, world }
}

describe('MotionSearch', () => {
  it('finds the six flat traverses', () => {
    const { result } = solve('flat')
    expect(result.status).toBe('success')
    expect(result.path).toHaveLength(6)
    expect(result.moves.every(move => move.kind === 'traverse')).toBe(true)
  })

  it('finds a one-block ascend', () => {
    const { result } = solve('step-up')
    expect(result.status).toBe('success')
    expect(result.moves.some(move => move.kind === 'ascend')).toBe(true)
  })

  it('routes through a closed hand-openable door', () => {
    const { result } = solve('door')
    expect(result.status).toBe('success')
    expect(result.path).toContainEqual({ x: 0, y: 101, z: 3 })
  })

  it('reports the one-cell gap as no path while parkour is off', () => {
    const { result } = solve('gap-1')
    expect(result.status).toBe('noPath')
    expect(result.moves.some(move => move.kind === 'parkour')).toBe(false)
  })

  it('finds the gap once parkour is authorized', () => {
    const { result } = solve('gap-1', { allowParkour: true })
    expect(result.status).toBe('success')
    expect(result.moves.some(move => move.kind === 'parkour')).toBe(true)
  })

  it('prices a two-block drop as a fall', () => {
    const { result } = solve('drop-2')
    expect(result.status).toBe('success')
    expect(result.moves.some(move => move.kind === 'fall')).toBe(true)
  })

  it('bridges two missing supports only when placement is authorized', () => {
    const blocked = solve('bridge')
    expect(blocked.result.status).toBe('noPath')
    const allowed = solve('bridge', { allowPlace: true, material: 'dirt' })
    expect(allowed.result.status).toBe('success')
    expect(allowed.result.moves.filter(move => move.kind === 'bridge').length).toBe(2)
  })

  it('pillars up two levels only when placement is authorized', () => {
    const blocked = solve('pillar')
    expect(blocked.result.status).toBe('noPath')
    const allowed = solve('pillar', { allowPlace: true, material: 'dirt' })
    expect(allowed.result.status).toBe('success')
    const pillars = allowed.result.moves.filter(move => move.kind === 'pillar')
    expect(pillars).toHaveLength(1)
    expect(pillars[0]?.toPlace()).toHaveLength(2)
  })

  it('uses a diagonal shortcut when diagonal movement is authorized', () => {
    const allowed = solve('diagonal', { allowDiagonal: true })
    expect(allowed.result.status).toBe('success')
    expect(allowed.result.moves[0]?.kind).toBe('diagonal')
    const blocked = solve('diagonal')
    expect(blocked.result.status).toBe('success')
    expect(blocked.result.moves[0]?.kind).toBe('traverse')
  })

  it('stops at the node budget with a best-so-far prefix', () => {
    const { result } = solve('flat', {}, { maxNodes: 1, timeoutMs: 10 })
    expect(result.status).toBe('timeout')
    expect(result.best).not.toEqual({ x: 0, y: 101, z: 6 })
  })

  it('exposes a bounded core reachability hint for placement', () => {
    const door = matrixFields({ x: 0, y: 100, z: 0 }).find(entry => entry.id === 'door')
    expect(door).toBeDefined()
    if (door === undefined) return
    const world = buildFixture(door)
    const reachable = reachableCells(world, door.start, { maxNodes: 96 })
    expect([...reachable]).toContain('0,101,3')
    const gap = matrixFields({ x: 0, y: 100, z: 0 }).find(entry => entry.id === 'gap-1')
    expect(gap).toBeDefined()
    if (gap === undefined) return
    const gapWorld = buildFixture(gap)
    const gapReachable = reachableCells(gapWorld, gap.start, { maxNodes: 96 })
    expect([...gapReachable]).toContain('0,101,2')
    expect([...gapReachable]).not.toContain('0,101,4')
    expect([...gapReachable]).not.toContain('0,101,6')
  })

  it('honours cancellation', () => {
    const { result } = solve('flat', {}, { isCanceled: () => true })
    expect(result.status).toBe('canceled')
  })

  it('supports exact, near and adjacent arrival goals', () => {
    const target = { x: 2, y: 64, z: 2 }
    expect(createGoal(target, { kind: 'exact' }).isEnd(target)).toBe(true)
    expect(createGoal(target, { kind: 'exact' }).isEnd({ x: 2, y: 64, z: 3 })).toBe(false)
    expect(createGoal(target, { kind: 'near', range: 1 }).isEnd({ x: 2, y: 64, z: 3 })).toBe(true)
    expect(createGoal(target, { kind: 'adjacent' }).isEnd({ x: 2, y: 64, z: 3 })).toBe(true)
    expect(createGoal(target, { kind: 'adjacent' }).isEnd({ x: 2, y: 64, z: 4 })).toBe(false)
  })

  it('uses hostile avoidance as a soft cost instead of a hard wall', () => {
    class HostileWorld extends FixtureWorld {
      override entities(): readonly {
        id: string; name: string; position: { x: number; y: number; z: number }; hostile: boolean
      }[] {
        return [{ id: 'zombie-1', name: 'zombie', position: { x: 0, y: 64, z: 2 }, hostile: true }]
      }
    }
    const world = new HostileWorld()
    for (let x = -2; x <= 2; x += 1) {
      for (let z = 0; z <= 4; z += 1) {
        world.blocks.set(`${x},63,${z}`, rawBlock('stone', FULL_CUBE))
        for (let y = 64; y <= 65; y += 1) world.blocks.set(`${x},${y},${z}`, rawBlock('air', []))
      }
    }
    world.selfView = { ...world.selfView, pos: { x: 0.5, y: 64, z: 0.5 } }
    const source = contextFor(world)
    const search = (avoidance?: { coefficient: number; radius: number }) => {
      const instance = new MotionSearch({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 4 }, () => source.next(), {
        sliceMs: 50,
        timeoutMs: 2_000,
        ...(avoidance === undefined ? {} : { avoidance }),
      })
      let result = instance.step(Date.now())
      while (result.status === 'running') result = instance.step(Date.now())
      return result
    }
    expect(search().status).toBe('success')
    const avoided = search({ coefficient: 8, radius: 1 })
    expect(avoided.status).toBe('success')
    expect(avoided.path).not.toContainEqual({ x: 0, y: 64, z: 2 })
  })
})

describe('MinHeap', () => {
  it('pops the lowest f, then h', () => {
    const heap = new MinHeap()
    heap.push({ x: 0, y: 0, z: 1 }, 5, 5)
    heap.push({ x: 0, y: 0, z: 2 }, 3, 3)
    heap.push({ x: 0, y: 0, z: 3 }, 3, 1)
    expect(heap.pop()?.cell).toEqual({ x: 0, y: 0, z: 3 })
    expect(heap.pop()?.cell).toEqual({ x: 0, y: 0, z: 2 })
    expect(heap.pop()?.cell).toEqual({ x: 0, y: 0, z: 1 })
    expect(heap.pop()).toBeUndefined()
  })
})
