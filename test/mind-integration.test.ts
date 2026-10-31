import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { createMind } from '../src/body/mind.ts'
import type { ClientPort, SelfInfo } from '../src/port/index.ts'
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
}

function fakePort(): FakePort {
  const moves: Array<{ x: number; y: number; z: number }> = []
  const pending: Array<(value: { state: 'ok'; elapsedMs: number }) => void> = []
  const blocksIn = (box: Box): Array<{ name: string; loaded: boolean; pos: { x: number; y: number; z: number } }> => {
    const blocks = []
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
    entities: () => [],
    inventory: () => [],
    beginWrite: () => {},
    endWrite: () => {},
    moveTo: (target: { x: number; y: number; z: number }) => {
      moves.push({ x: target.x, y: target.y, z: target.z })
      return new Promise<{ state: 'ok'; elapsedMs: number }>(resolve => { pending.push(resolve) })
    },
  } as unknown as ClientPort
  return { port, moves, pending }
}

describe('mind integration', () => {
  it('holds still when no order is active', () => {
    const { port, moves } = fakePort()
    const mind = createMind({
      port,
      home: { x: 0, y: 64, z: 0 },
      contentDir: join(process.cwd(), 'content', 'trees'),
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    mind.tick()
    expect(mind.status().tracker).toBe('idle')
    expect(moves).toHaveLength(0)
  })

  it('selects, starts and finishes one wander job', async () => {
    const { port, moves, pending } = fakePort()
    const mind = createMind({
      port,
      home: { x: 0, y: 64, z: 0 },
      contentDir: join(process.cwd(), 'content', 'trees'),
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })

    mind.enqueueOrder({ verb: 'wander' })
    mind.tick()
    expect(mind.status().tracker).toBe('running')
    expect(moves).toHaveLength(1)
    expect(mind.status().job?.driverId).toBe('move')

    pending[0]?.({ state: 'ok', elapsedMs: 1 })
    await Promise.resolve()
    mind.tick()
    expect(mind.status().tracker).toBe('idle')
    expect(mind.status().job).toBeNull()
  })

  it('exposes active and queued orders in status', () => {
    const { port } = fakePort()
    const mind = createMind({
      port,
      contentDir: join(process.cwd(), 'content', 'trees'),
      plansDir: join(process.cwd(), 'content', 'plans'),
      journalPath: join(tempDir(), 'journal.jsonl'),
      now: () => 1_000,
    })
    mind.orders.enqueue({ id: 'ord-1', verb: 'wander' })
    mind.orders.enqueue({ id: 'ord-2', verb: 'hold' })
    expect(mind.status().activeOrder).toEqual({ id: 'ord-1', verb: 'wander' })
    expect(mind.status().queuedOrders).toBe(1)
    mind.orders.cancel('ord-1')
    expect(mind.status().activeOrder).toEqual({ id: 'ord-2', verb: 'hold' })
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
        listOrders: () => ({ active: null, queued: [] }),
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



