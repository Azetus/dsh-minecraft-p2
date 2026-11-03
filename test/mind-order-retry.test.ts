import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createMind } from '../src/body/mind.ts'
import type { ClientPort, SelfInfo } from '../src/port/index.ts'

/**
 * Category: state safety (order retry policy).
 * Protects: a transient primitive failure retries inside the same order; a
 * one-shot verb fails on the first attempt; exhausted retries become blocked.
 */

const dirs: string[] = []

function tempJournal(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-retry-'))
  dirs.push(dir)
  return join(dir, 'journal.jsonl')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function fakePort(outcomes: Array<{ state: 'ok' | 'failed'; code?: string }>): {
  port: ClientPort
  attempts: () => number
  equips: () => number
} {
  const self: SelfInfo = {
    pos: { x: 0.5, y: 64, z: 0.5 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
  }
  let attempts = 0
  let equips = 0
  const port = {
    on: () => {},
    self: () => self,
    time: () => ({ timeOfDay: 1000, worldAge: 1 }),
    blockAt: () => null,
    blocksIn: () => [],
    entities: () => [],
    inventory: () => [],
    beginWrite: () => {},
    endWrite: () => {},
    moveTo: async () => {
      const outcome = outcomes[Math.min(attempts, outcomes.length - 1)]
      attempts += 1
      return { ...outcome, elapsedMs: 1 }
    },
    equip: async () => {
      equips += 1
      return { state: 'ok' as const, elapsedMs: 1 }
    },
  } as unknown as ClientPort
  return { port, attempts: () => attempts, equips: () => equips }
}

async function runUntilTerminal(mind: ReturnType<typeof createMind>, id: string): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    mind.tick()
    await wait(0)
    const state = mind.orders.get(id)?.state
    if (state === 'succeeded' || state === 'failed' || state === 'blocked') return
  }
}

function makeMind(port: ClientPort) {
  return makeMindAt(port, tempJournal())
}

function makeMindAt(port: ClientPort, journalPath: string) {
  return createMind({
    port,
    home: { x: 0, y: 64, z: 0 },
    plansDir: join(process.cwd(), 'content', 'plans'),
    journalPath,
  })
}

describe('primitive order retry policy', () => {
  it('reports a hold barrier and the orders queued behind it', () => {
    const fake = fakePort([{ state: 'ok' }])
    const mind = makeMind(fake.port)
    const hold = mind.enqueueOrder({ id: 'ord-hold', verb: 'hold' })
    expect(hold.queue).toMatchObject({
      active: { id: 'ord-hold', verb: 'hold' },
      holdsActiveSlot: true,
      queuedBehind: 0,
    })
    const go = mind.enqueueOrder({ id: 'ord-go-behind', verb: 'go', params: { x: 1, y: 64, z: 0 } })
    expect(go.queue).toMatchObject({
      queued: 1,
      blockedBy: { id: 'ord-hold', verb: 'hold' },
      release: expect.stringContaining('p2_cancel'),
    })
  })

  it('retries a transient go failure inside the same order', async () => {
    const fake = fakePort([
      { state: 'failed', code: 'GOTO_NO_PATH' },
      { state: 'failed', code: 'GOTO_NO_PATH' },
      { state: 'ok' },
    ])
    const mind = makeMind(fake.port)
    mind.enqueueOrder({ id: 'ord-go', verb: 'go', params: { x: 1, y: 64, z: 0 } })
    await runUntilTerminal(mind, 'ord-go')

    expect(mind.orders.get('ord-go')?.state).toBe('succeeded')
    expect(fake.attempts()).toBe(3)
    const retries = [...mind.events.since(0)]
      .filter(event => event.kind === 'job.terminal')
      .map(event => event.data as { retry?: boolean })
    expect(retries.filter(data => data.retry === true)).toHaveLength(2)
  })

  it('blocks after the third retryable failure instead of failing on the first', async () => {
    const fake = fakePort([{ state: 'failed', code: 'GOTO_NO_PATH' }])
    const mind = makeMind(fake.port)
    mind.enqueueOrder({ id: 'ord-blocked', verb: 'go', params: { x: 1, y: 64, z: 0 } })
    await runUntilTerminal(mind, 'ord-blocked')

    expect(mind.orders.get('ord-blocked')?.state).toBe('blocked')
    expect(fake.attempts()).toBe(3)
    const terminal = [...mind.events.since(0)]
      .filter(event => event.kind === 'job.terminal')
      .map(event => event.data as { blocked?: boolean; retry?: boolean })
    expect(terminal.at(-1)).toMatchObject({ blocked: true })
    expect(terminal.at(-1)?.retry).not.toBe(true)
  })

  it('does not retry an unconfirmed action timeout', async () => {
    const fake = fakePort([{ state: 'failed', code: 'ACT_UNCONFIRMED' }])
    const mind = makeMind(fake.port)
    mind.enqueueOrder({ id: 'ord-unconfirmed', verb: 'go', params: { x: 1, y: 64, z: 0 } })
    await runUntilTerminal(mind, 'ord-unconfirmed')

    expect(mind.orders.get('ord-unconfirmed')?.state).toBe('failed')
    expect(fake.attempts()).toBe(1)
    const terminals = [...mind.events.since(0)].filter(event => event.kind === 'job.terminal')
    expect(terminals).toHaveLength(1)
    expect((terminals[0]?.data as { retry?: boolean }).retry).not.toBe(true)
  })

  it('does not retry a one-shot equip failure', async () => {
    const fake = fakePort([{ state: 'failed', code: 'EQUIP_ITEM_MISSING' }])
    const mind = makeMind(fake.port)
    mind.enqueueOrder({ id: 'ord-equip', verb: 'equip', params: { item: 'stone_pickaxe' } })
    await runUntilTerminal(mind, 'ord-equip')

    expect(mind.orders.get('ord-equip')?.state).toBe('failed')
    expect(fake.equips()).toBe(0)
  })

  it('does not retry a placement whose target is inside the body', async () => {
    const port = {
      on: () => {},
      self: () => ({ pos: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, pitch: 0, health: 20, food: 20,
        onGround: true, inWater: false, inLava: false }),
      time: () => ({ timeOfDay: 1000, worldAge: 1 }),
      blockAt: (p: { x: number; y: number; z: number }) => ({ name: 'air', loaded: true, pos: p }),
      blocksIn: () => [],
      entities: () => [],
      inventory: () => [],
      beginWrite: () => {},
      endWrite: () => {},
      moveTo: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
      place: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    } as unknown as ClientPort
    const mind = makeMind(port)
    mind.enqueueOrder({ id: 'ord-self', verb: 'place', params: { x: 0, y: 64, z: 0, item: 'dirt' } })
    await runUntilTerminal(mind, 'ord-self')

    expect(mind.orders.get('ord-self')?.state).toBe('failed')
    const terminals = [...mind.events.since(0)].filter(event => event.kind === 'job.terminal')
    expect(terminals).toHaveLength(1)
  })

  it('does not retry an interaction whose required item is missing', async () => {
    const port = {
      on: () => {},
      self: () => ({ pos: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, pitch: 0, health: 20, food: 20,
        onGround: true, inWater: false, inLava: false }),
      time: () => ({ timeOfDay: 1000, worldAge: 1 }),
      blockAt: (p: { x: number; y: number; z: number }) => ({ name: 'air', loaded: true, pos: p }),
      blocksIn: () => [],
      entities: () => [],
      inventory: () => [],
      beginWrite: () => {},
      endWrite: () => {},
      moveTo: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
      equip: async () => ({ state: 'failed' as const, code: 'EQUIP_NO_ITEM', elapsedMs: 1 }),
      useItem: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    } as unknown as ClientPort
    const mind = makeMind(port)
    mind.enqueueOrder({ id: 'ord-noitem', verb: 'use', params: { item: 'dirt' } })
    await runUntilTerminal(mind, 'ord-noitem')

    expect(mind.orders.get('ord-noitem')?.state).toBe('failed')
    const terminals = [...mind.events.since(0)].filter(event => event.kind === 'job.terminal')
    expect(terminals).toHaveLength(1)
  })

  it('appends one metrics line per order terminal with attempts and last code', async () => {
    const journalPath = tempJournal()
    const fake = fakePort([
      { state: 'failed', code: 'GOTO_NO_PATH' },
      { state: 'failed', code: 'GOTO_NO_PATH' },
      { state: 'ok' },
    ])
    const mind = makeMindAt(fake.port, journalPath)
    mind.enqueueOrder({ id: 'ord-metrics', verb: 'go', params: { x: 1, y: 64, z: 0 } })
    await runUntilTerminal(mind, 'ord-metrics')

    expect(mind.orders.get('ord-metrics')?.state).toBe('succeeded')
    const lines = readFileSync(join(dirname(journalPath), 'metrics.jsonl'), 'utf8')
      .trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      orderId: 'ord-metrics',
      verb: 'go',
      state: 'succeeded',
      attempts: 3,
      lastCode: 'GOTO_NO_PATH',
      target: { x: 1, y: 64, z: 0 },
    })
  })
})
