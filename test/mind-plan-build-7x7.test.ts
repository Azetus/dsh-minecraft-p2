import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createMind } from '../src/body/mind.ts'
import { parseBlueprint } from '../src/mind/blueprint.ts'
import type { BlockInfo, BodyApi, Item, SelfInfo, Vec3 } from '../src/body/api.ts'

/**
 * Category: cross-module contract (B1 build acceptance).
 * Protects: the real 7x7 blueprint completes through the real plan giver, place
 * driver, stage barrier and usable-room verifier inside a simulated server.
 * The world model is the same geometry as the live run; only the transport is
 * replaced. This is the deterministic gate before the single live acceptance.
 */

const root = process.cwd()
const dir = mkdtempSync(join(root, 'node_modules', '.p2-7x7-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const door = { x: 0, y: 121, z: -3 }
const bed = { x: 1, y: 121, z: 0 }
const bedHead = { x: 2, y: 121, z: 0 }

/** 7x7 footprint, `height` layers: floor at 120, interior 121..(120+h-2). */
function blueprint(height: number): Record<string, unknown> {
  const interior = { min: { x: -2, y: 121, z: -2 }, max: { x: 2, y: 120 + height - 2, z: 2 } }
  const blocks: Array<{ x: number; y: number; z: number; name: string; state?: Record<string, string> }> = []
  for (let x = -3; x <= 3; x += 1) {
    for (let y = 120; y <= 120 + height - 1; y += 1) {
      for (let z = -3; z <= 3; z += 1) {
        const inside = x >= interior.min.x && x <= interior.max.x
          && y >= interior.min.y && y <= interior.max.y
          && z >= interior.min.z && z <= interior.max.z
        if (inside) continue
        const isDoor = x === door.x && z === door.z && (y === door.y || y === door.y + 1)
        blocks.push({
          x,
          y,
          z,
          name: isDoor ? 'oak_door' : 'dirt',
          ...(isDoor ? { state: { half: y === door.y ? 'lower' : 'upper' } } : {}),
        })
      }
    }
  }
  blocks.push({ x: bed.x, y: bed.y, z: bed.z, name: 'red_bed', state: { part: 'foot', facing: 'east' } })
  blocks.push({ x: bedHead.x, y: bedHead.y, z: bedHead.z, name: 'red_bed', state: { part: 'head', facing: 'east' } })
  // The one-block apron the verifier uses as the outside standing cell.
  blocks.push({ x: 0, y: 120, z: -4, name: 'dirt' })
  return {
    version: 1,
    blocks,
    verify: {
      kind: 'usable-room',
      min: interior.min,
      max: interior.max,
      door,
      bed,
    },
  }
}

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`

type Fake = {
  port: BodyApi
  blocks: Map<string, BlockInfo>
  self: { pos: Vec3 }
  places: number
  moves: number
  moveTargets: string[]
  failures: string[]
}

function fakeWorld(): Fake {
  const blocks = new Map<string, BlockInfo>()
  for (let x = -8; x <= 8; x += 1) {
    for (let z = -9; z <= 7; z += 1) {
      blocks.set(key({ x, y: 119, z }), { name: 'stone', loaded: true, pos: { x, y: 119, z } })
      for (let y = 120; y <= 130; y += 1) {
        blocks.set(key({ x, y, z }), { name: 'air', loaded: true, pos: { x, y, z } })
      }
    }
  }
  const self: SelfInfo = {
    pos: { x: 0.5, y: 120, z: -3.5 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
  }
  const inventory: Item[] = [
    { slot: 36, name: 'dirt', count: 256 },
    { slot: 40, name: 'oak_door', count: 2 },
    { slot: 41, name: 'red_bed', count: 2 },
  ]
  let yaw = 0
  const failures: string[] = []
  const fake: Fake = {
    port: undefined as unknown as BodyApi,
    blocks,
    self: { pos: self.pos },
    places: 0,
    moves: 0,
    moveTargets: [],
    failures,
  }
  const port = {
    on: () => {},
    self: () => ({ ...self, pos: fake.self.pos }),
    time: () => ({ timeOfDay: 1000, worldAge: 100 }),
    blockAt: (p: Vec3) => blocks.get(key(p)) ?? null,
    blocksIn: (box: { min: Vec3; max: Vec3 }) => [...blocks.values()].filter(block => block.pos !== undefined
      && block.pos.x >= box.min.x && block.pos.x <= box.max.x
      && block.pos.y >= box.min.y && block.pos.y <= box.max.y
      && block.pos.z >= box.min.z && block.pos.z <= box.max.z),
    entities: () => [],
    inventory: () => inventory,
    beginWrite: () => {},
    endWrite: () => {},
    lookYaw: async (value: number) => {
      yaw = value
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    moveTo: async (target: Vec3) => {
      fake.moves += 1
      fake.moveTargets.push(key(target))
      fake.self.pos = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    place: async (p: Vec3, _face: string, item: string) => {
      const feet = {
        x: Math.floor(fake.self.pos.x),
        y: Math.floor(fake.self.pos.y),
        z: Math.floor(fake.self.pos.z),
      }
      if (p.x === feet.x && p.z === feet.z && (p.y === feet.y || p.y === feet.y + 1)) {
        failures.push('PLACE_BLOCKED_BY_SELF')
        return { state: 'failed' as const, code: 'PLACE_BLOCKED_BY_SELF', elapsedMs: 1 }
      }
      fake.places += 1
      const set = (at: Vec3, name: string, state?: Record<string, string>): void => {
        blocks.set(key(at), { name, loaded: true, pos: { ...at }, ...(state === undefined ? {} : { state }) })
      }
      if (item.endsWith('_door')) {
        set(p, item, { half: 'lower', facing: 'north', open: 'false' })
        set({ x: p.x, y: p.y + 1, z: p.z }, item, { half: 'upper', facing: 'north', open: 'false' })
        return { state: 'ok' as const, elapsedMs: 1 }
      }
      if (item.endsWith('_bed')) {
        const direction = bedDirection(yaw)
        const head = { x: p.x + direction.x, y: p.y, z: p.z + direction.z }
        set(head, item, { part: 'head', facing: direction.facing })
        set(p, item, { part: 'foot', facing: direction.facing })
        return { state: 'ok' as const, elapsedMs: 1 }
      }
      set(p, item)
      return { state: 'ok' as const, elapsedMs: 1 }
    },
  }
  fake.port = port as unknown as BodyApi
  return fake
}

function bedDirection(yaw: number): { x: number; z: number; facing: string } {
  const dx = Math.round(-Math.sin(yaw))
  const dz = Math.round(Math.cos(yaw))
  if (dx === 1) return { x: 1, z: 0, facing: 'east' }
  if (dx === -1) return { x: -1, z: 0, facing: 'west' }
  if (dz === 1) return { x: 0, z: 1, facing: 'south' }
  return { x: 0, z: -1, facing: 'north' }
}

const flush = async (): Promise<void> => {
  await new Promise(resolve => setImmediate(resolve))
}

describe('7x7 build', () => {
  for (const height of [7, 4]) {
    it(`completes every stage at height ${height} and never stalls at stage 2`, async () => {
      const orderId = `b1-7x7-h${height}`
      const fake = fakeWorld()
      const parsed = parseBlueprint(blueprint(height))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return

      const mind = createMind({
        body: fake.port,
        home: { x: 0, y: 120, z: -4 },
        baseActivity: { kind: 'idle' },
        plansDir: join(root, 'content', 'plans'),
        journalPath: join(dir, `journal-${height}.jsonl`),
      })
      mind.enqueueOrder({ id: orderId, verb: 'build', blueprint: blueprint(height) })

      const collected: Array<{ kind: string; data: unknown }> = []
      let lastSeq = 0
      const startedAt = Date.now()
      for (let index = 0; index < 40_000; index += 1) {
        mind.tick()
        await flush()
        for (const event of mind.events.since(lastSeq, 500)) collected.push({ kind: event.kind, data: event.data })
        lastSeq = mind.events.lastSeq()
        const state = mind.orders.get(orderId)?.state
        if (state === 'succeeded' || state === 'blocked' || state === 'failed') break
        if (Date.now() - startedAt > 30_000) break
      }

      const state = mind.orders.get(orderId)?.state
      const events = collected
      if (state === 'active') {
        const tail = events.slice(-25).map(event => `${event.kind}:${JSON.stringify(event.data).slice(0, 300)}`)
        console.log('DEBUG state', state, 'places', fake.places, 'self', fake.self.pos)
        console.log('DEBUG status.plan', JSON.stringify(mind.status().plan))
        console.log(tail.join('\n'))
      }
      const blocked = events.find(event => event.kind === 'plan.blocked')
      expect(blocked?.data ?? null, JSON.stringify(blocked?.data ?? state)).toBeNull()
      expect(fake.failures).toEqual([])
      expect(state).toBe('succeeded')
      // Door upper and bed head are produced by the same placement packet:
      // one packet per work item, one packet per two-cell group.
      expect(fake.places).toBe(parsed.blueprint.blocks.length - 2)
      // A stance is reused across covered items; the unbatched path used to
      // move once per item (h7 baseline: 238 moves).
      expect(fake.moves).toBeLessThan(80)

      // Every declared cell (including both door halves and both bed cells).
      for (const block of parsed.blueprint.blocks) {
        const at = { x: block.x, y: block.y, z: block.z }
        expect(fake.blocks.get(key(at))?.name, `cell ${key(at)}`).toBe(block.name)
      }

      const completed = events.filter(event => event.kind === 'stage.completed')
      expect(completed.map(event => (event.data as { stage: number }).stage).sort()).toEqual([1, 2, 3, 4])
      const terminal = events.find(event => event.kind === 'plan.terminal'
        && (event.data as { state: string }).state === 'succeeded')
      expect(terminal?.data).toMatchObject({
        stopReason: 'COMPLETE',
        summary: {
          total: parsed.blueprint.blocks.length - 2,
          satisfied: parsed.blueprint.blocks.length - 2,
          failed: 0,
          skipped: 0,
          unknown: 0,
          stopReason: 'COMPLETE',
        },
      })
      expect(events.some(event => event.kind === 'plan.terminal'
        && (event.data as { state: string }).state === 'succeeded')).toBe(true)
      expect(events.filter(event => event.kind === 'job.terminal'
        && (event.data as { state: string }).state === 'failed')).toEqual([])
    }, 60_000)
  }

  it('defers a permanently occupied cell and reports one summary', async () => {
    const orderId = 'b1-blocked'
    const fake = fakeWorld()
    fake.blocks.set(key({ x: 0, y: 120, z: 0 }), {
      name: 'chest',
      loaded: true,
      pos: { x: 0, y: 120, z: 0 },
    })
    const blueprint = {
      version: 1,
      blocks: [{ x: 0, y: 120, z: 0, name: 'dirt' }],
    }
    const parsed = parseBlueprint(blueprint)
    expect(parsed.ok).toBe(true)
    const mind = createMind({
      body: fake.port,
      home: { x: 0, y: 120, z: -4 },
      baseActivity: { kind: 'idle' },
      plansDir: join(root, 'content', 'plans'),
      journalPath: join(dir, 'journal-blocked.jsonl'),
    })
    mind.enqueueOrder({ id: orderId, verb: 'build', blueprint })

    const collected: Array<{ kind: string; data: unknown }> = []
    let lastSeq = 0
    for (let index = 0; index < 2_000; index += 1) {
      mind.tick()
      await flush()
      for (const event of mind.events.since(lastSeq, 500)) collected.push({ kind: event.kind, data: event.data })
      lastSeq = mind.events.lastSeq()
      const state = mind.orders.get(orderId)?.state
      if (state === 'succeeded' || state === 'blocked' || state === 'failed') break
    }

    expect(mind.orders.get(orderId)?.state).toBe('blocked')
    const blocked = collected.find(event => event.kind === 'plan.blocked')
    expect(blocked?.data).toMatchObject({
      stopReason: 'NO_FRONTIER',
      summary: {
        total: 1,
        satisfied: 0,
        failed: 1,
        skipped: 0,
        unknown: 0,
        codes: { PLACE_TARGET_OCCUPIED: 1 },
        stopReason: 'NO_FRONTIER',
      },
    })
    const data = blocked?.data as { items?: Array<Record<string, unknown>> } | undefined
    expect(data?.items?.[0]).toMatchObject({
      workItemId: 'b:0,120,0',
      reason: 'PLACE_FAILED',
      lastCode: 'PLACE_TARGET_OCCUPIED',
    })
    const placeFailures = collected.filter(event => event.kind === 'job.terminal'
      && (event.data as { driverId?: string }).driverId === 'place'
      && (event.data as { state?: string }).state === 'failed')
    expect(placeFailures).toHaveLength(2)
  })
})
