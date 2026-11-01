import { describe, expect, it } from 'vitest'

import { Registry } from '../src/mind/registry.ts'
import { evaluateTree, loadTrees } from '../src/mind/tree.ts'
import type { TreeResult } from '../src/mind/tree.ts'
import type { Candidate, EvalCtx, Handoff, WorldView } from '../src/mind/types.ts'

/**
 * Category: state/data (tree evaluation, TODO M1-02).
 * Protects: selection only picks registered givers from one snapshot, unknown
 * predicates never reach `else`, and malformed trees never half-load.
 */

const ctx: EvalCtx = { now: 1_000 }

function world(overrides: Partial<WorldView> = {}): WorldView {
  return {
    self: {
      pos: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      food: 20,
      onGround: true,
      inWater: false,
      inLava: false,
    },
    time: { timeOfDay: 1_000, worldAge: 100 },
    inventory: [],
    blockAt: () => null,
    blocksIn: () => [],
    entitiesIn: () => [],
    ...overrides,
  }
}

function candidate(name: string): Candidate {
  return {
    driverId: 'move',
    target: { kind: 'point', pos: { x: name.length, y: 64, z: 0 } },
    params: { x: name.length, y: 64, z: 0 },
    keys: name,
  }
}

function registryWithGivers(): Registry {
  const registry = new Registry()
  registry.registerGiver({ id: 'a', factory: () => ({ id: 'a', find: () => candidate('a') }) })
  registry.registerGiver({
    id: 'b',
    factory: () => ({ id: 'b', score: () => 5, find: () => candidate('b') }),
  })
  registry.registerGiver({
    id: 'scored',
    factory: () => ({ id: 'scored', score: () => 10, find: () => candidate('scored') }),
  })
  registry.registerGiver({ id: 'none', factory: () => ({ id: 'none', find: () => null }) })
  registry.registerGiver({
    id: 'handoff',
    factory: () => ({
      id: 'handoff',
      find: (): Handoff => ({
        driverId: 'move',
        target: { kind: 'point', pos: { x: 1, y: 64, z: 2 } },
        params: { x: 1, y: 64, z: 2 },
        reason: 'clear',
      }),
    }),
  })
  registry.registerPredicate({ id: 'yes', fn: () => true })
  registry.registerPredicate({ id: 'no', fn: () => false })
  registry.registerPredicate({ id: 'unknown', fn: () => 'unknown' })
  registry.registerPredicate({ id: 'throws', fn: () => { throw new Error('boom') } })
  return registry
}

function load(definitions: Record<string, unknown>): TreeResult | ReturnType<typeof loadTrees> {
  const registry = registryWithGivers()
  const loaded = loadTrees(definitions, registry)
  if (!loaded.ok) return loaded
  return evaluateTree('root', loaded.trees, registry, ctx, world())
}

function jobRef(result: TreeResult | ReturnType<typeof loadTrees>): string | undefined {
  if ('ok' in result) return undefined
  return result.kind === 'job' ? result.candidate.keys : result.kind
}

describe('tree evaluation', () => {
  it('priority skips a giver with no work and takes the first candidate', () => {
    const result = load({
      root: { type: 'priority', children: [{ type: 'giver', ref: 'none' }, { type: 'giver', ref: 'a' }, { type: 'giver', ref: 'b' }] },
    })
    expect(jobRef(result)).toBe('a')
  })

  it('sequence continues on skip but stops on no-candidate', () => {
    const skipped = load({
      root: {
        type: 'sequence',
        children: [
          { type: 'when', predicate: 'unknown', onUnknown: 'skip', then: { type: 'giver', ref: 'a' } },
          { type: 'giver', ref: 'b' },
        ],
      },
    })
    expect(jobRef(skipped)).toBe('b')

    const stopped = load({
      root: {
        type: 'sequence',
        children: [
          { type: 'when', predicate: 'unknown', onUnknown: 'noCandidate', then: { type: 'giver', ref: 'a' } },
          { type: 'giver', ref: 'b' },
        ],
      },
    })
    expect(jobRef(stopped)).toBe('nowork')
  })

  it('never enters else on an unknown predicate', () => {
    const result = load({
      root: {
        type: 'when',
        predicate: 'unknown',
        onUnknown: 'skip',
        then: { type: 'giver', ref: 'a' },
        else: { type: 'giver', ref: 'b' },
      },
    })
    expect(jobRef(result)).toBe('nowork')
  })

  it('takes the highest score in a sorter and the first on a tie', () => {
    const highest = load({
      root: { type: 'sorter', children: [{ type: 'giver', ref: 'a' }, { type: 'giver', ref: 'scored' }, { type: 'giver', ref: 'b' }] },
    })
    expect(jobRef(highest)).toBe('scored')

    const tie = load({
      root: { type: 'sorter', children: [{ type: 'giver', ref: 'b' }, { type: 'giver', ref: 'a' }] },
    })
    // b scores 5, a scores 0.
    expect(jobRef(tie)).toBe('b')
  })

  it('resolves subtrees and converts a handoff into a job', () => {
    const result = load({
      root: { type: 'priority', children: [{ type: 'subtree', ref: 'guard' }] },
      guard: { type: 'giver', ref: 'handoff' },
    })
    expect('ok' in result).toBe(false)
    if ('ok' in result || result.kind !== 'job') throw new Error('expected a job')
    expect(result.candidate.driverId).toBe('move')
    expect(result.candidate.keys).toBe('handoff:move:1,64,2')
  })

  it('returns need-observation for a stale snapshot', () => {
    const registry = registryWithGivers()
    const loaded = loadTrees({ root: { type: 'giver', ref: 'a' } }, registry)
    if (!loaded.ok) throw new Error('tree should load')
    const result = evaluateTree('root', loaded.trees, registry, ctx, world({ stale: true }))
    expect(result).toEqual({ kind: 'need-observation', reason: 'stale-snapshot' })
  })

  it('returns definition-error when a predicate throws', () => {
    const result = load({
      root: { type: 'when', predicate: 'throws', onUnknown: 'skip', then: { type: 'giver', ref: 'a' } },
    })
    expect('ok' in result).toBe(false)
    if ('ok' in result) return
    expect(result.kind).toBe('definition-error')
  })

  it('passes the same snapshot object to every giver', () => {
    const registry = new Registry()
    const seen: WorldView[] = []
    for (const id of ['one', 'two']) {
      registry.registerGiver({
        id,
        factory: () => ({ id, find: (_ctx, view) => { seen.push(view); return id === 'one' ? null : candidate(id) } }),
      })
    }
    const loaded = loadTrees({ root: { type: 'sorter', children: [{ type: 'giver', ref: 'one' }, { type: 'giver', ref: 'two' }] } }, registry)
    if (!loaded.ok) throw new Error('tree should load')
    const snapshot = world()
    evaluateTree('root', loaded.trees, registry, ctx, snapshot)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(snapshot)
    expect(seen[1]).toBe(snapshot)
  })
})

describe('tree loading', () => {
  function code(definitions: Record<string, unknown>): string | undefined {
    const loaded = loadTrees(definitions, registryWithGivers())
    return loaded.ok ? undefined : loaded.error.code
  }

  it('rejects unknown node types, fields, predicates, givers and subtrees', () => {
    expect(code({ root: { type: 'mystery' } })).toBe('DEFINITION_ERROR')
    expect(code({ root: { type: 'giver', ref: 'a', extra: true } })).toBe('DEFINITION_ERROR')
    expect(code({ root: { type: 'when', predicate: 'nope', onUnknown: 'skip', then: { type: 'giver', ref: 'a' } } }))
      .toBe('DEFINITION_ERROR')
    expect(code({ root: { type: 'giver', ref: 'nope' } })).toBe('DEFINITION_ERROR')
    expect(code({ root: { type: 'subtree', ref: 'nope' } })).toBe('DEFINITION_ERROR')
  })

  it('rejects subtree cycles', () => {
    expect(code({ root: { type: 'subtree', ref: 'a' }, a: { type: 'subtree', ref: 'root' } }))
      .toBe('DEFINITION_ERROR')
  })

  it('rejects depth over 8 and more than 500 expanded nodes', () => {
    const deeper: Record<string, unknown> = { leaf: { type: 'giver', ref: 'a' } }
    let node: Record<string, unknown> = { type: 'giver', ref: 'a' }
    for (let index = 0; index < 8; index += 1) node = { type: 'priority', children: [node] }
    deeper.root = node
    expect(code(deeper)).toBe('DEFINITION_ERROR')

    const wide = {
      root: {
        type: 'priority',
        children: Array.from({ length: 500 }, () => ({ type: 'giver' as const, ref: 'a' })),
      },
    }
    expect(code(wide)).toBe('DEFINITION_ERROR')
  })
})
