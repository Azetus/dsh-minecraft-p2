import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OrderStore } from '../src/mind/orders.ts'
import type { OrderEvent } from '../src/mind/orders.ts'

/**
 * Category: data integrity (recovery identity).
 * Protects: a matching journal restores; a legacy header is accepted once by
 * world/character and rewritten with the plan-only header; any identity drift
 * archives the journal (one latest copy) and starts empty instead of blocking
 * the body; corrupt JSON still refuses recovery.
 */

const dirs: string[] = []

function tempJournal(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-identity-'))
  dirs.push(dir)
  return join(dir, 'journal.jsonl')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

function entry(value: unknown): string {
  return `${JSON.stringify({ v: 1, ...value as object })}\n`
}

function legacyJournal(journal: string, worldId = 'world-a', characterId = 'char-a'): void {
  writeFileSync(journal, [
    entry({
      at: 1,
      kind: 'journal.identity',
      identity: { worldId, characterId, defVersion: 'legacy-trees-and-plans' },
    }),
    entry({ at: 2, kind: 'order.accepted', order: { id: 'ord-1', verb: 'hold' } }),
  ].join(''))
}

function archivePath(journal: string): string {
  return join(dirname(journal), 'archive', 'journal.jsonl')
}

describe('journal identity migration', () => {
  it('accepts a legacy header once and writes the plan-only header on the next append', () => {
    const journal = tempJournal()
    legacyJournal(journal)
    const identity = { worldId: 'world-a', characterId: 'char-a', defVersion: 'plans-1', defScope: 'plans' as const }
    const events: string[] = []
    const store = new OrderStore({ journalPath: journal, identity, onEvent: event => events.push(event.kind) })
    store.restore()

    expect(store.get('ord-1')?.state).toBe('active')
    expect(events).toContain('journal.legacy-accepted')

    store.enqueue({ id: 'ord-2', verb: 'hold' })
    const headers = readFileSync(journal, 'utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line))
      .filter(line => line.kind === 'journal.identity')
    expect(headers).toHaveLength(2)
    expect(headers.at(-1)).toMatchObject({ identity: { defScope: 'plans', defVersion: 'plans-1' } })

    const restored = new OrderStore({ journalPath: journal, identity })
    restored.restore()
    expect(restored.get('ord-1')?.state).toBe('active')
    expect(restored.get('ord-2')?.state).toBe('queued')
  })

  it('archives a journal from another world or character and starts empty', () => {
    const journal = tempJournal()
    legacyJournal(journal)
    const identity = { worldId: 'world-b', characterId: 'char-b', defVersion: 'plans-1', defScope: 'plans' as const }
    const events: OrderEvent[] = []
    const store = new OrderStore({ journalPath: journal, identity, onEvent: event => events.push(event) })
    expect(() => store.restore()).not.toThrow()
    expect(store.all()).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ kind: 'journal.archived', reason: 'world' }))
    expect(readFileSync(archivePath(journal), 'utf8')).toContain('world-a')
    expect(readFileSync(journal, 'utf8')).toBe('')
  })

  it('archives a plan-scoped header whose plan version changed', () => {
    const journal = tempJournal()
    writeFileSync(journal, entry({
      at: 1,
      kind: 'journal.identity',
      identity: { worldId: 'world-a', characterId: 'char-a', defVersion: 'plans-1', defScope: 'plans' },
    }))
    const events: OrderEvent[] = []
    const store = new OrderStore({
      journalPath: journal,
      identity: { worldId: 'world-a', characterId: 'char-a', defVersion: 'plans-2', defScope: 'plans' },
      onEvent: event => events.push(event),
    })
    expect(() => store.restore()).not.toThrow()
    expect(store.all()).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ kind: 'journal.archived', reason: 'plans' }))
    expect(readFileSync(archivePath(journal), 'utf8')).toContain('plans-1')
  })

  it('keeps only the latest archived journal', () => {
    const journal = tempJournal()
    legacyJournal(journal, 'world-a', 'char-a')
    const first = new OrderStore({
      journalPath: journal,
      identity: { worldId: 'world-b', characterId: 'char-b', defVersion: 'plans-1', defScope: 'plans' },
    })
    first.restore()
    expect(readFileSync(archivePath(journal), 'utf8')).toContain('world-a')

    legacyJournal(journal, 'world-c', 'char-c')
    const second = new OrderStore({
      journalPath: journal,
      identity: { worldId: 'world-d', characterId: 'char-d', defVersion: 'plans-1', defScope: 'plans' },
    })
    second.restore()
    const archived = readFileSync(archivePath(journal), 'utf8')
    expect(archived).toContain('world-c')
    expect(archived).not.toContain('world-a')
  })

  it('still refuses a corrupt journal instead of archiving it', () => {
    const journal = tempJournal()
    writeFileSync(journal, 'not json\n')
    const store = new OrderStore({
      journalPath: journal,
      identity: { worldId: 'world-a', characterId: 'char-a', defVersion: 'plans-1', defScope: 'plans' },
    })
    expect(errorCode(() => store.restore())).toBe('JOURNAL_CORRUPT')
  })
})
