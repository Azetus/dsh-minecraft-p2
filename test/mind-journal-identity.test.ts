import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OrderStore } from '../src/mind/orders.ts'

/**
 * Category: data integrity (recovery identity).
 * Protects: a journal written before the plan-only identity is accepted once by
 * world/character, then rewritten with the new header on the next append; a
 * plan-scoped mismatch still refuses recovery.
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

  it('still refuses a legacy header from a different world or character', () => {
    const journal = tempJournal()
    legacyJournal(journal)
    const identity = { worldId: 'world-b', characterId: 'char-b', defVersion: 'plans-1', defScope: 'plans' as const }
    const store = new OrderStore({ journalPath: journal, identity })
    expect(errorCode(() => store.restore())).toBe('RECOVERY_IDENTITY_MISMATCH')
  })

  it('refuses a plan-scoped header whose plan version changed', () => {
    const journal = tempJournal()
    writeFileSync(journal, entry({
      at: 1,
      kind: 'journal.identity',
      identity: { worldId: 'world-a', characterId: 'char-a', defVersion: 'plans-1', defScope: 'plans' },
    }))
    const store = new OrderStore({
      journalPath: journal,
      identity: { worldId: 'world-a', characterId: 'char-a', defVersion: 'plans-2', defScope: 'plans' },
    })
    expect(errorCode(() => store.restore())).toBe('RECOVERY_IDENTITY_MISMATCH')
  })
})
