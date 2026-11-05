import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { createMind } from '../src/body/mind.ts'
import type { ClientPort, Item, SelfInfo } from '../src/port/index.ts'
import type { Box } from '../src/port/index.ts'

/**
 * Category: cross-module contract (todo M1-05 wiring).
 * Protects: one real mind tick selects, starts and finishes maintenance work
 * through the actual registry/trees/tracker/driver, and body status exposes it.
 */

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-mind-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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

type FakePort = {
  port: ClientPort
  moves: Array<{ x: number; y: number; z: number }>
  pending: Array<(value: { state: 'ok'; elapsedMs: number }) => void>
  equips: string[]
}

function fakePort(
  items: Item[] = [],
  options: {
    emptyBlocks?: boolean
    autoMove?: boolean
    blocks?: Map<string, { name: string; loaded: boolean; pos: { x: number; y: number; z: number } }>
  } = {},
): FakePort {
  const moves: Array<{ x: number; y: number; z: number }> = []
  const pending: Array<(value: { state: 'ok'; elapsedMs: number }) => void> = []
  const equips: string[] = []
  const blocks = options.blocks ?? new Map()
  const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`
  const blocksIn = (box: Box): Array<{ name: string; loaded: boolean; pos: { x: number; y: number; z: number } }> => {
    const blocks: Array<{ name: string; loaded: boolean; pos: { x: number; y: number; z: number } }> = []
    if (options.emptyBlocks === true) return blocks
    for (let x = box.min.x; x <= box.max.x; x += 1) {
      for (let z = box.min.z; z <= box.max.z; z += 1) {
        blocks.push({ name: 'stone', loaded: true, pos: { x, y: 63, z } })
        blocks.push({ name: 'air', loaded: true, pos: { x, y: 64, z } })
        blocks.push({ name: 'air', loaded: true, pos: { x, y: 65, z } })
      }
    }
    return blocks
  }
  const port = {
    on: () => {},
    self: () => self,
    time: () => ({ timeOfDay: 1000, worldAge: 100 }),
    blocksIn,
    blockAt: (p: { x: number; y: number; z: number }) => blocks.get(key(p)) ?? null,
    entities: () => [],
    inventory: () => items,
    equip: async (item: string) => {
      equips.push(item)
      return { state: 'ok' as const, observed: { kind: 'equip', item, held: item }, elapsedMs: 1 }
    },
    dig: async (p: { x: number; y: number; z: number }) => {
      blocks.set(key(p), { name: 'air', loaded: true, pos: { ...p } })
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    beginWrite: () => {},
    endWrite: () => {},
    moveTo: (target: { x: number; y: number; z: number }) => {
      moves.push({ x: target.x, y: target.y, z: target.z })
      if (options.autoMove === true) return Promise.resolve({ state: 'ok' as const, elapsedMs: 1 })
      return new Promise<{ state: 'ok'; elapsedMs: number }>(resolve => { pending.push(resolve) })
    },
  } as unknown as ClientPort
  return { port, moves, pending, equips }
}

describe('mind integration', () => {
  it('holds still when no order is active', () => {
    const { port, moves } = fakePort()
    const mind = createMind({
      port,
      home: { x: 0, y: 64, z: 0 },
      baseActivity: { kind: 'idle' },
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    mind.tick()
    expect(mind.status().tracker).toBe('idle')
    expect(moves).toHaveLength(0)
  })

  it('starts in wandering and reports the base layer', () => {
    const { port } = fakePort([], { emptyBlocks: true })
    const mind = createMind({
      port,
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    mind.tick()
    expect(mind.status().baseActivity).toMatchObject({
      kind: 'wandering',
      state: 'active',
      params: { radius: 8 },
    })
    expect(mind.status().activity).toMatchObject({
      layer: 'base',
      kind: 'wandering',
      state: 'active',
    })
  })

  it('lets an order preempt the base activity and restores it afterwards', () => {
    const { port } = fakePort([], { emptyBlocks: true })
    const mind = createMind({
      port,
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    mind.tick()
    expect(mind.status().baseActivity?.state).toBe('active')

    mind.enqueueOrder({ verb: 'hold' })
    mind.tick()
    expect(mind.status().activity).toMatchObject({ layer: 'order', kind: 'hold', state: 'waiting' })
    expect(mind.status().baseActivity?.state).toBe('inactive')

    mind.cancelAll()
    mind.tick()
    expect(mind.status().baseActivity?.state).toBe('active')
    expect(mind.status().activity).toMatchObject({ layer: 'base', kind: 'wandering' })
  })

  it('resets base activity to wandering after a body restart', () => {
    const journalPath = join(tempDir(), 'journal.jsonl')
    const first = createMind({
      port: fakePort([], { emptyBlocks: true }).port,
      baseActivity: { kind: 'idle' },
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath,
      now: () => 1_000,
    })
    first.tick()
    expect(first.status().baseActivity).toMatchObject({ kind: 'idle', state: 'active' })

    const second = createMind({
      port: fakePort([], { emptyBlocks: true }).port,
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath,
      now: () => 2_000,
    })
    second.tick()
    expect(second.status().baseActivity).toMatchObject({ kind: 'wandering', state: 'active' })
  })

  it('replaces an active duty with a terminal event and starts the new one', () => {
    const { port } = fakePort([], { emptyBlocks: true })
    const mind = createMind({
      port,
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    const first = mind.startDuty({ kind: 'gather', item: 'dirt', quota: 2 })
    expect(first.previousDuty).toBeNull()
    mind.tick()

    const replaced = mind.startDuty({ kind: 'gather', item: 'dirt', quota: 4 })
    expect(replaced.previousDuty).toMatchObject({
      state: 'cancelled',
      lastError: 'REPLACED_BY_NEW_DUTY',
    })
    expect(replaced.started).toMatchObject({ quota: 4, state: 'active' })
    const terminal = [...mind.events.since(0)].find(candidate => candidate.kind === 'duty.terminal')
    expect(terminal?.data).toMatchObject({ state: 'cancelled', lastError: 'REPLACED_BY_NEW_DUTY' })
  })

  it('pauses a duty behind an order and keeps base inactive', () => {
    const { port } = fakePort([], { emptyBlocks: true })
    const mind = createMind({
      port,
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    mind.startDuty({ kind: 'gather', item: 'dirt', quota: 8 })
    mind.tick()
    expect(mind.status().activity).toMatchObject({ layer: 'duty', state: 'active' })

    mind.enqueueOrder({ verb: 'hold' })
    mind.tick()
    expect(mind.status().activity).toMatchObject({ layer: 'order', kind: 'hold' })
    expect(mind.status().duty).toMatchObject({ state: 'active', paused: true })
    expect(mind.status().baseActivity?.state).toBe('inactive')

    mind.cancelAll()
    mind.tick()
    expect(mind.status().duty?.paused).not.toBe(true)
  })

  it('blocks a duty without a source and keeps base inactive', () => {
    const { port } = fakePort([], { emptyBlocks: true })
    const mind = createMind({
      port,
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    mind.startDuty({ kind: 'gather', item: 'dirt', quota: 1 })
    for (let index = 0; index < 40; index += 1) mind.tick()

    expect(mind.status().duty).toMatchObject({ state: 'blocked', lastError: 'DUTY_NO_SOURCE' })
    expect(mind.status().activity).toMatchObject({ layer: 'duty', kind: 'gather', state: 'waiting' })
    expect(mind.status().baseActivity?.state).toBe('inactive')
  })

  it('sets and resets the body reaction policy without persistence', () => {
    const first = createMind({
      port: fakePort([], { emptyBlocks: true }).port,
      baseActivity: { kind: 'idle' },
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    expect(first.status().reaction).toMatchObject({ source: 'default', mode: 'flee', fight: null })
    const set = first.setReactionPolicy({ fight: { allowedTargets: [] } })
    expect(set).toMatchObject({ source: 'agent', mode: 'all-hostiles' })
    expect(first.status().reaction).toMatchObject({ mode: 'all-hostiles' })

    const second = createMind({
      port: fakePort([], { emptyBlocks: true }).port,
      baseActivity: { kind: 'idle' },
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal2.jsonl'),
      now: () => 2_000,
    })
    expect(second.status().reaction).toMatchObject({ source: 'default', mode: 'flee', fight: null })
    expect(first.resetReactionPolicy()).toMatchObject({ source: 'default', mode: 'flee' })
  })

  it('honors an explicit equip for the next dig action', async () => {
    const target = { x: 1, y: 64, z: 0 }
    const blocks = new Map([
      [`${target.x},${target.y},${target.z}`, { name: 'stone', loaded: true, pos: target }],
    ])
    const fake = fakePort([{ slot: 36, name: 'stone_pickaxe', count: 1 }], { autoMove: true, blocks })
    const mind = createMind({
      port: fake.port,
      baseActivity: { kind: 'idle' },
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })

    mind.enqueueOrder({ verb: 'equip', params: { item: 'stone_pickaxe' } })
    mind.tick()
    for (let index = 0; index < 40; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      mind.tick()
      if (mind.status().activeOrder === null) break
    }
    expect(fake.equips).toEqual(['stone_pickaxe'])

    mind.enqueueOrder({ verb: 'dig', params: target })
    mind.tick()
    for (let index = 0; index < 100; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      mind.tick()
      if (mind.status().activeOrder === null) break
    }
    expect(fake.equips).toEqual(['stone_pickaxe'])
    expect(mind.status().activeOrder).toBeNull()
  })

  it('selects, starts and finishes one go job', async () => {
    const { port, moves, pending } = fakePort()
    const mind = createMind({
      port,
      home: { x: 0, y: 64, z: 0 },
      baseActivity: { kind: 'idle' },
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })

    mind.enqueueOrder({ verb: 'go', params: { x: 1, y: 64, z: 1 } })
    mind.tick()
    expect(mind.status().tracker).toBe('running')
    expect(moves).toHaveLength(1)
    expect(mind.status().job?.driverId).toBe('move')

    pending[0]?.({ state: 'ok', elapsedMs: 1 })
    await new Promise(resolve => setTimeout(resolve, 0))
    mind.tick()
    expect(mind.status().tracker).toBe('idle')
    expect(mind.status().job).toBeNull()
  })

  it('completes a traverse order through the motion move job', async () => {
    const { port, moves, pending } = fakePort([{ slot: 36, name: 'dirt', count: 2 }])
    const mind = createMind({
      port,
      home: { x: 0, y: 64, z: 0 },
      baseActivity: { kind: 'idle' },
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    mind.enqueueOrder({ verb: 'traverse', params: { mode: 'scaffold', x: 0, y: 66, z: 0, item: 'dirt' } })
    mind.tick()
    expect(mind.status().job?.driverId).toBe('traverse')
    expect(moves).toEqual([{ x: 0, y: 66, z: 0 }])
    pending.at(-1)?.({ state: 'ok', elapsedMs: 1 })
    for (let index = 0; index < 20 && mind.status().activeOrder !== null; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
      mind.tick()
    }
    expect(mind.status().activeOrder).toBeNull()
  })

  it('exposes active and queued orders in status', () => {
    const { port } = fakePort()
    const mind = createMind({
      port,
      baseActivity: { kind: 'idle' },
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    mind.orders.enqueue({ id: 'ord-1', verb: 'hold' })
    mind.orders.enqueue({ id: 'ord-2', verb: 'check', params: { x: 0, y: 64, z: 0 } })
    expect(mind.status().activeOrder).toEqual({ id: 'ord-1', verb: 'hold' })
    expect(mind.status().queuedOrders).toBe(1)
    expect(mind.listOrders().queueBlockedBy).toEqual({ id: 'ord-1', verb: 'hold' })
    mind.orders.cancel('ord-1')
    expect(mind.status().activeOrder).toEqual({ id: 'ord-2', verb: 'check' })
    expect(mind.listOrders().queueBlockedBy).toBeNull()
    const cancelled = mind.cancelAll()
    expect(cancelled.cancelled).toBe(1)
    expect(mind.status().activeOrder).toBeNull()
  })

  it('runs the mind from BodyRuntime.tick and reports it in status', () => {
    let ticks = 0
    const runtime = new BodyRuntime({
      body: {
        manifest: {
          schemaVersion: 1,
          bodyVersion: '0.1.0',
          protocolVersion: 1,
          entry: 'body.mjs',
          files: { 'body.mjs': 'a'.repeat(64) },
        },
        manifestDigest: 'b'.repeat(64),
        bindingId: null,
        capabilities: [],
        provider: null,
      },
      mind: {
        tick: () => { ticks += 1 },
        status: () => ({
          tracker: 'idle',
          job: null,
          fault: null,
          home: null,
          activeOrder: null,
          queuedOrders: 0,
          eventsSeq: 0,
        }),
        report: () => null,
        enqueueOrder: () => ({ id: 'ord-1', state: 'active' }),
        cancelOrder: id => ({ id, state: 'cancelled' }),
        cancelAll: () => ({ cancelled: 0 }),
        startDuty: () => ({
          previousDuty: null,
          started: {
            id: 'duty-1', kind: 'gather', item: 'dirt', quota: 1, baseline: 0, collected: 0,
            progress: 0, activeMs: 0, pausedMs: 0, jobs: 0, state: 'active', startedAt: 0,
          },
        }),
        stopDuty: () => null,
        baseActivity: () => ({
          kind: 'wandering', state: 'inactive', params: { radius: 8 }, waitingReason: null,
        }),
        setBaseActivity: () => ({
          kind: 'wandering', state: 'inactive', params: { radius: 8 }, waitingReason: null,
        }),
        reactionPolicy: () => ({
          source: 'default', mode: 'flee', fight: null,
          selfCare: {
            eat: { enabled: true, foodBelow: 14 },
            retreat: { enabled: true, healthBelow: 8 },
            unstuck: { enabled: true },
          },
        }),
        setReactionPolicy: () => ({
          source: 'agent', mode: 'flee', fight: null,
          selfCare: {
            eat: { enabled: true, foodBelow: 14 },
            retreat: { enabled: true, healthBelow: 8 },
            unstuck: { enabled: true },
          },
        }),
        resetReactionPolicy: () => ({
          source: 'default', mode: 'flee', fight: null,
          selfCare: {
            eat: { enabled: true, foodBelow: 14 },
            retreat: { enabled: true, healthBelow: 8 },
            unstuck: { enabled: true },
          },
        }),
        listOrders: () => ({ active: null, queued: [], queueBlockedBy: null }),
        sinceEvents: () => ({ events: [], seq: 0 }),
        watchedBlock: () => undefined,
        orders: {} as never,
        events: {} as never,
      },
    })
    runtime.tick()
    runtime.tick()
    expect(ticks).toBe(2)
    expect(runtime.status().mind).toMatchObject({ tracker: 'idle', queuedOrders: 0 })
  })
})



