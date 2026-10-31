import { describe, expect, it } from 'vitest'

import { createPlanGiver } from '../src/mind/givers/plan.ts'
import { MindLoop } from '../src/mind/loop.ts'
import { evaluatePlan, instantiatePlan } from '../src/mind/plan.ts'
import type { PlanTemplate, WorkItem } from '../src/mind/plan.ts'
import { Registry } from '../src/mind/registry.ts'
import { JobTracker } from '../src/mind/tracker.ts'
import { evaluateTree } from '../src/mind/tree.ts'
import type { TreeMap } from '../src/mind/tree.ts'
import type { Driver, DriverCtx, DriverHandle, Job, WorldView } from '../src/mind/types.ts'
import { verifySealedRoom } from '../src/mind/verify/sealed-room.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, ClientPort, SelfInfo, Vec3 } from '../src/port/index.ts'

/**
 * Category: cross-module contract (todo M2-03/M2-02).
 * Protects: the plan giver + tracker + loop can build a fixed 3x3x2 room and
 * resume from a partially built world without redoing satisfied cells.
 */

const origin = { x: 0, y: 64, z: 0 }

function key(p: Vec3): string {
  return `${p.x},${p.y},${p.z}`
}

function block(name: string, p: Vec3): BlockInfo {
  return { name, loaded: true, pos: p }
}

function shellTemplate(): PlanTemplate {
  const items: WorkItem[] = []
  const add = (at: [number, number, number]): void => {
    items.push({ id: `w${items.length}`, kind: 'place', at, expected: { name: 'dirt' } })
  }
  for (let x = -1; x <= 3; x += 1) for (let z = -1; z <= 3; z += 1) add([x, -1, z]) // floor + ring
  for (let y = 0; y <= 1; y += 1) {
    for (let x = -1; x <= 3; x += 1) for (let z = -1; z <= 3; z += 1) {
      const interior = x >= 0 && x <= 2 && z >= 0 && z <= 2
      if (!interior) add([x, y, z])
    }
  }
  for (let x = -1; x <= 3; x += 1) for (let z = -1; z <= 3; z += 1) add([x, 2, z]) // roof
  return {
    id: 'room-3x3x2',
    version: 1,
    size: [3, 2, 3],
    materialPolicy: {},
    workItems: items,
    verify: { kind: 'sealed-room', min: [0, 0, 0], max: [2, 1, 2] },
  }
}

const self: SelfInfo = {
  pos: { x: 1.5, y: 65, z: 1.5 },
  yaw: 0,
  pitch: 0,
  health: 20,
  food: 20,
  onGround: true,
  inWater: false,
  inLava: false,
}

type Fake = {
  port: ClientPort
  blocks: Map<string, BlockInfo>
  state: { selfPos: Vec3 }
  snapshot(): SnapshotWorld
  writes: number
}

function fakeWorld(): Fake {
  const blocks = new Map<string, BlockInfo>()
  for (let x = -1; x <= 3; x += 1) {
    for (let z = -1; z <= 3; z += 1) {
      blocks.set(key({ x, y: 62, z }), block('stone', { x, y: 62, z }))
      for (let y = 63; y <= 66; y += 1) blocks.set(key({ x, y, z }), block('air', { x, y, z }))
    }
  }
  const state = { selfPos: { x: 1.5, y: 65, z: 1.5 } }
  const snapshot = (): SnapshotWorld => new SnapshotWorld({
    self: { ...self, pos: state.selfPos },
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: [],
    blocks: [...blocks.values()],
    inventory: [{ slot: 0, name: 'dirt', count: 999 }],
  })
  let writes = 0
  const port = {
    beginWrite: () => { writes += 1 },
    endWrite: () => {},
    blockAt: (p: Vec3) => blocks.get(key(p)) ?? null,
  } as unknown as ClientPort
  return {
    port,
    blocks,
    state,
    snapshot,
    get writes() { return writes },
  }
}

function instantDriver(id: string, mutate: (job: Job, fake: Fake) => void, fake: Fake): Driver {
  return {
    id,
    schema: { type: 'object', additionalProperties: true },
    defaults: {
      budget: { maxTicks: 100, maxWallMs: 5_000 },
      interrupt: 'constant-only',
      suspendable: true,
    },
    validate: () => ({ ok: true }),
    start(job: Job, _ctx: DriverCtx): DriverHandle {
      mutate(job, fake)
      return {
        tick: () => {},
        requestStop: () => {},
        stopStatus: () => 'stopped',
        result: () => ({ state: 'succeeded' }),
        continuationKey: () => `${id}:test`,
      }
    },
  }
}

function buildLoop(fake: Fake, plan: ReturnType<typeof instantiatePlan>, drivers: Driver[]): MindLoop {
  const registry = new Registry()
  registry.registerGiver({ id: 'plan.work', factory: () => createPlanGiver() })
  for (const driver of drivers) registry.registerDriver({ id: driver.id, driver })
  const trees: TreeMap = new Map([['main', { type: 'giver', ref: 'plan.work' }]])
  const tracker = new JobTracker({
    port: fake.port,
    driver: id => registry.driver(id),
    world: () => fake.snapshot(),
    now: () => Date.now(),
    stopTimeoutMs: 500,
  })
  return new MindLoop({
    world: () => fake.snapshot(),
    evaluate: (tree, ctx, world) => tree === 'main'
      ? evaluateTree('main', trees, registry, ctx, world)
      : { kind: 'nowork' },
    tracker,
    now: () => Date.now(),
    plan: () => plan,
  })
}

function runUntil(loop: MindLoop, fake: Fake, plan: ReturnType<typeof instantiatePlan>, limit = 2_000): void {
  for (let index = 0; index < limit; index += 1) {
    loop.tick()
    if (evaluatePlan(plan, fake.snapshot()).satisfied) return
  }
  throw new Error('plan did not complete')
}

describe('plan loop integration', () => {
  it('builds the fixed 3x3x2 room and verifies it', () => {
    const fake = fakeWorld()
    const plan = instantiatePlan(shellTemplate(), 'ord-1', origin)
    const clear = instantDriver('clear', (_job, _fake) => { throw new Error('unused') }, fake)
    const place = instantDriver('place', (job, world) => {
      world.blocks.set(key({ x: job.params.x as number, y: job.params.y as number, z: job.params.z as number }),
        block(job.params.item as string, { x: job.params.x as number, y: job.params.y as number, z: job.params.z as number }))
    }, fake)
    const move = instantDriver('move', (job, world) => {
      world.state.selfPos = {
        x: (job.params.x as number) + 0.5,
        y: job.params.y as number,
        z: (job.params.z as number) + 0.5,
      }
    }, fake)
    const loop = buildLoop(fake, plan, [clear, move, place])
    runUntil(loop, fake, plan)

    const evaluation = evaluatePlan(plan, fake.snapshot())
    expect(evaluation.satisfied).toBe(true)
    const verify = verifySealedRoom(plan, plan.verify ?? { kind: 'sealed-room', min: [0, 0, 0], max: [2, 1, 2] }, fake.snapshot())
    expect(verify.state).toBe('confirmed')
  })

  it('resumes from the world after an interruption without redoing cells', () => {
    const fake = fakeWorld()
    const template: PlanTemplate = {
      id: 'dig',
      version: 1,
      size: [3, 1, 3],
      materialPolicy: {},
      workItems: Array.from({ length: 9 }, (_, index) => ({
        id: `c${index}`,
        kind: 'clear' as const,
        at: [index % 3, 0, Math.floor(index / 3)] as [number, number, number],
      })),
    }
    const plan = instantiatePlan(template, 'ord-2', origin)
    for (const item of plan.workItems) {
      const at = { x: plan.origin.x + item.at[0], y: plan.origin.y + item.at[1], z: plan.origin.z + item.at[2] }
      fake.blocks.set(key(at), block('stone', at))
    }
    let digs = 0
    const clear = instantDriver('clear', (job, world) => {
      const at = { x: job.params.x as number, y: job.params.y as number, z: job.params.z as number }
      if (world.blocks.get(key(at))?.name !== 'air') digs += 1
      world.blocks.set(key(at), block('air', at))
    }, fake)

    // First body: stop after four cleared cells.
    const first = buildLoop(fake, plan, [clear])
    for (let index = 0; index < 200; index += 1) {
      first.tick()
      const cleared = [...plan.workItems].filter(item => {
        const at = { x: plan.origin.x + item.at[0], y: plan.origin.y + item.at[1], z: plan.origin.z + item.at[2] }
        return fake.blocks.get(key(at))?.name === 'air'
      }).length
      if (cleared >= 4) break
    }
    expect(digs).toBe(4)

    // New body/tracker sees the cleared cells as satisfied and only does the rest.
    const second = buildLoop(fake, plan, [clear])
    runUntil(second, fake, plan)
    expect(evaluatePlan(plan, fake.snapshot()).satisfied).toBe(true)
    expect(digs).toBe(9)
  })

  it('does not let one failing cell block the other work items', () => {
    const fake = fakeWorld()
    const template: PlanTemplate = {
      id: 'mixed',
      version: 1,
      size: [3, 1, 1],
      materialPolicy: {},
      workItems: [
        { id: 'bad', kind: 'clear', at: [0, 0, 0] },
        { id: 'ok1', kind: 'clear', at: [1, 0, 0] },
        { id: 'ok2', kind: 'clear', at: [2, 0, 0] },
      ],
    }
    const plan = instantiatePlan(template, 'ord-3', origin)
    for (const item of plan.workItems) {
      const at = { x: plan.origin.x + item.at[0], y: plan.origin.y + item.at[1], z: plan.origin.z + item.at[2] }
      fake.blocks.set(key(at), block('stone', at))
    }
    const clear = instantDriver('clear', (job, world) => {
      if (job.params.x === 0) throw new Error('cannot dig')
      const at = { x: job.params.x as number, y: job.params.y as number, z: job.params.z as number }
      world.blocks.set(key(at), block('air', at))
    }, fake)
    const loop = buildLoop(fake, plan, [clear])
    for (let index = 0; index < 100; index += 1) loop.tick()

    const evaluation = evaluatePlan(plan, fake.snapshot())
    expect(evaluation.states.get('ok1')).toEqual({ kind: 'satisfied' })
    expect(evaluation.states.get('ok2')).toEqual({ kind: 'satisfied' })
    expect(evaluation.states.get('bad')).toEqual({ kind: 'executable', driverId: 'clear' })
  })
})
