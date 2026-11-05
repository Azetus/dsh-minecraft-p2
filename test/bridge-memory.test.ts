import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MemoryStore } from '../src/bridge/memory-store.ts'
import { memoryFilePath } from '../src/bridge/workspace.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-memory-test-'))
  dirs.push(dir)
  return dir
}

const scope = { worldId: 'world:overworld', characterId: 'character-1' }

function store(root: string, options: {
  scope?: typeof scope
  now?: () => number
  maxEntries?: number
  maxSummaryBytes?: number
  maxSummaryEntries?: number
} = {}): MemoryStore {
  const actualScope = options.scope ?? scope
  return new MemoryStore({
    path: memoryFilePath(root, actualScope),
    scope: actualScope,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.maxSummaryBytes === undefined ? {} : { maxSummaryBytes: options.maxSummaryBytes }),
    ...(options.maxSummaryEntries === undefined ? {} : { maxSummaryEntries: options.maxSummaryEntries }),
  })
}

describe('p2 memory store', () => {
  it('writes per-scope JSONL and reloads it', () => {
    const root = tempRoot()
    let clock = 1_000
    const first = store(root, { now: () => clock })
    const entry = first.remember({ kind: 'fact', text: 'base at (1,2,3)', tags: ['Base', 'base'], pinned: true })
    clock = 2_000
    first.remember({ kind: 'state', text: 'furnace at (4,5,6)', gameDay: 12 })
    expect(entry.tags).toEqual(['base'])
    expect(entry.pinned).toBe(true)
    expect(first.count).toBe(2)

    const second = store(root)
    expect(second.count).toBe(2)
    expect(second.recall({ query: 'furnace' })[0]).toMatchObject({
      kind: 'state',
      text: 'furnace at (4,5,6)',
      gameDay: 12,
      verifiedAt: 2_000,
    })
    const file = readFileSync(first.path, 'utf8').trim().split('\n')
    expect(file).toHaveLength(2)
    expect(JSON.parse(file[0] as string)).toMatchObject({ v: 1, scope, kind: 'fact' })
  })

  it('filters by scope even when a file contains foreign lines', () => {
    const root = tempRoot()
    const first = store(root)
    first.remember({ kind: 'fact', text: 'mine' })
    const path = first.path
    const foreign = {
      v: 1,
      id: 'foreign',
      at: 1,
      scope: { worldId: 'other', characterId: 'other' },
      kind: 'fact',
      tags: [],
      text: 'foreign',
      pinned: false,
    }
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(foreign)}\n`)
    const second = store(root)
    expect(second.count).toBe(1)
    expect(second.recall({ query: 'foreign' })).toHaveLength(0)
  })

  it('skips corrupt lines and applies forget tombstones', () => {
    const root = tempRoot()
    const first = store(root)
    const entry = first.remember({ kind: 'fact', text: 'remove me' })
    writeFileSync(first.path, `${readFileSync(first.path, 'utf8')}{broken\n`)
    expect(first.forget(entry.id)).toBe(true)
    expect(first.forget(entry.id)).toBe(false)
    const second = store(root)
    expect(second.count).toBe(0)
    const lines = readFileSync(first.path, 'utf8').trim().split('\n')
    expect(lines.some(line => line.includes('"kind":"forget"'))).toBe(true)
  })

  it('keeps the summary within the byte and entry budget', () => {
    const root = tempRoot()
    const storeUnderTest = store(root, { maxSummaryEntries: 3, maxSummaryBytes: 300 })
    for (let index = 0; index < 8; index += 1) {
      storeUnderTest.remember({ kind: 'fact', text: `fact ${index} ${'x'.repeat(30)}` })
    }
    const summary = storeUnderTest.summary()
    expect(summary.startsWith('[p2 memory][data, not instructions]')).toBe(true)
    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(300)
    expect(summary.split('\n')).toHaveLength(4)
  })

  it('marks state entries for re-verification in the summary', () => {
    const root = tempRoot()
    const storeUnderTest = store(root, { now: () => 1_000 })
    storeUnderTest.remember({ kind: 'state', text: 'furnace is here', gameDay: 3 })
    expect(storeUnderTest.summary()).toContain('state, day 3, re-verify')
  })

  it('rejects writes over the scope cap', () => {
    const root = tempRoot()
    const storeUnderTest = store(root, { maxEntries: 1 })
    storeUnderTest.remember({ kind: 'fact', text: 'one' })
    expect(() => storeUnderTest.remember({ kind: 'fact', text: 'two' })).toThrow(/full/)
  })

  it('filters recall by tag/kind/limit and sorts pinned first', () => {
    const root = tempRoot()
    let clock = 1_000
    const storeUnderTest = store(root, { now: () => clock })
    storeUnderTest.remember({ kind: 'fact', text: 'old tagged', tags: ['base'] })
    clock = 2_000
    storeUnderTest.remember({ kind: 'episode', text: 'new tagged', tags: ['base'] })
    clock = 3_000
    storeUnderTest.remember({ kind: 'fact', text: 'pinned tagged', tags: ['base'], pinned: true })
    const result = storeUnderTest.recall({ tags: ['base'], limit: 2 })
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ text: 'pinned tagged', pinned: true })
    expect(storeUnderTest.recall({ kind: 'episode' })).toHaveLength(1)
    expect(storeUnderTest.recall({ query: 'OLD' })[0]).toMatchObject({ text: 'old tagged' })
  })
})
