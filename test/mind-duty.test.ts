import { describe, expect, it } from 'vitest'

import { AreaResourceIndex } from '../src/mind/area.ts'
import { DutyController } from '../src/mind/duty.ts'
import { createDutyGiver } from '../src/mind/givers/duty.ts'
import type { EvalCtx } from '../src/mind/types.ts'
import { SnapshotWorld } from '../src/mind/world.ts'
import type { BlockInfo, Box, ClientPort, Item, SelfInfo, Vec3 } from '../src/port/index.ts'

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

function world(inventory: Item[] = []): SnapshotWorld {
  return new SnapshotWorld({
    self,
    time: { timeOfDay: 1000, worldAge: 1 },
    entities: [],
    blocks: [],
    inventory,
  })
}

function inside(point: Vec3, box: Box): boolean {
  return point.x >= box.min.x && point.x <= box.max.x
    && point.y >= box.min.y && point.y <= box.max.y
    && point.z >= box.min.z && point.z <= box.max.z
}

function portWith(blocks: BlockInfo[]): ClientPort {
  return {
    blocksIn: (box: Box) => blocks.filter(block => block.pos !== undefined && inside(block.pos, box)),
  } as unknown as ClientPort
}

describe('duty controller', () => {
  it('tracks quota, deadline and order/plan gating', () => {
    const duty = new DutyController()
    const view = duty.start({ kind: 'gather', item: 'dirt', quota: 2, radius: 8, maxJobs: 2 }, 1_000)
    expect(view).toMatchObject({ kind: 'gather', item: 'dirt', quota: 2, state: 'active' })
    expect(duty.canWork(false, false)).toBe(true)
    expect(duty.canWork(true, false)).toBe(false)
    expect(duty.canWork(false, true)).toBe(false)
    expect(duty.canStartJob()).toBe(true)

    expect(duty.refresh([{ slot: 36, name: 'dirt', count: 1 }], 1_001)).toMatchObject({
      collected: 1,
      state: 'active',
    })
    expect(duty.refresh([{ slot: 36, name: 'dirt', count: 2 }], 1_002)).toMatchObject({
      collected: 2,
      state: 'completed',
    })
  })

  it('blocks on a deadline and stops explicitly', () => {
    const duty = new DutyController()
    duty.start({ kind: 'gather', item: 'dirt', quota: 4, maxWallMs: 1_000 }, 0)
    expect(duty.refresh([], 2_000)).toMatchObject({ state: 'blocked', lastError: 'DUTY_DEADLINE' })

    const second = new DutyController()
    second.start({ kind: 'gather', item: 'dirt', quota: 1 }, 10)
    expect(second.stop(11)).toMatchObject({ state: 'stopped', lastError: 'agent' })
  })
})

describe('duty.work giver', () => {
  it('selects a source only when no order or plan is active', () => {
    const stone = { name: 'grass_block', loaded: true, pos: { x: 2, y: 64, z: 0 } }
    const duty = new DutyController()
    const area = new AreaResourceIndex(portWith([stone]), { radius: 16, vertical: 8, chunkBudget: 4 })
    const giver = createDutyGiver(duty, area)
    duty.start({ kind: 'gather', item: 'dirt', quota: 2, radius: 16 }, 0)

    const ctx: EvalCtx = { now: 0 }
    expect(giver.find({ ...ctx, orderVerb: 'go' }, world())).toBeNull()
    expect(giver.find({ ...ctx, plan: {} as never }, world())).toBeNull()

    let result: unknown = null
    for (let now = 0; now < 20 && result === null; now += 1) {
      result = giver.find({ now }, world())
    }
    expect(result).toMatchObject({
      driverId: 'dig',
      params: { purpose: 'harvest', x: 2, y: 64, z: 0 },
    })
  })

  it('completes from inventory and blocks when no source exists', () => {
    const duty = new DutyController()
    const area = new AreaResourceIndex(portWith([]), { radius: 8, vertical: 4, chunkBudget: 4 })
    const giver = createDutyGiver(duty, area)
    duty.start({ kind: 'gather', item: 'dirt', quota: 1, radius: 8 }, 0)

    expect(giver.find({ now: 0 }, world([{ slot: 36, name: 'dirt', count: 1 }]))).toBeNull()
    expect(duty.view()?.state).toBe('completed')

    const empty = new DutyController()
    const emptyArea = new AreaResourceIndex(portWith([]), { radius: 8, vertical: 4, chunkBudget: 4 })
    const emptyGiver = createDutyGiver(empty, emptyArea)
    empty.start({ kind: 'gather', item: 'dirt', quota: 1, radius: 8 }, 0)
    let result: unknown = null
    for (let now = 0; now < 20 && result === null; now += 1) {
      result = emptyGiver.find({ now }, world())
    }
    expect(result).toMatchObject({ kind: 'hold', reason: 'DUTY_NO_SOURCE' })
    expect(empty.view()?.state).toBe('blocked')
  })
})
