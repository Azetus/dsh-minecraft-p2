import { describe, expect, it } from 'vitest'

import { Sensors } from '../src/mind/sensors.ts'
import type { BlockInfo, ClientPort, SelfInfo, Vec3 } from '../src/port/index.ts'

/**
 * Category: cross-module contract (B1 observation).
 * Protects: a plan observation box survives re-sampling, so walls/roof/stances
 * do not turn back into `unknown` when the default box follows the body.
 */

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`

function fakePort(): { port: ClientPort; state: { pos: Vec3 }; blocks: Map<string, BlockInfo> } {
  const blocks = new Map<string, BlockInfo>()
  for (const [x, y, z, name] of [
    [0, 64, 0, 'air'],
    [0, 63, 0, 'stone'],
    [40, 66, 40, 'dirt'],
  ] as const) {
    blocks.set(key({ x, y, z }), { name, loaded: true, pos: { x, y, z } })
  }
  const state = { pos: { x: 0.5, y: 64, z: 0.5 } }
  const self = (): SelfInfo => ({
    pos: state.pos,
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    onGround: true,
    inWater: false,
    inLava: false,
  })
  const port = {
    self,
    time: () => ({ timeOfDay: 1000, worldAge: 1 }),
    blockAt: (p: Vec3) => blocks.get(key(p)) ?? null,
    blocksIn: (box: { min: Vec3; max: Vec3 }) => [...blocks.values()].filter(block => block.pos !== undefined
      && block.pos.x >= box.min.x && block.pos.x <= box.max.x
      && block.pos.y >= box.min.y && block.pos.y <= box.max.y
      && block.pos.z >= box.min.z && block.pos.z <= box.max.z),
    entities: () => [],
    inventory: () => [],
  } as unknown as ClientPort
  return { port, state, blocks }
}

describe('sensors observation groups', () => {
  it('re-reads a plan box on every sample instead of losing it', () => {
    const { port, state } = fakePort()
    let now = 0
    const sensors = new Sensors({ port, now: () => now, refreshMs: 100 })

    sensors.setObservation('plan', [{ min: { x: 38, y: 64, z: 38 }, max: { x: 42, y: 68, z: 42 } }])
    expect(sensors.read()?.blockAt({ x: 40, y: 66, z: 40 })?.name).toBe('dirt')

    // A new default-box sample after the refresh interval must still include
    // the plan box.
    state.pos = { x: 12.5, y: 64, z: 12.5 }
    now += 1_000
    const after = sensors.read()
    expect(after.blockAt({ x: 40, y: 66, z: 40 })?.name).toBe('dirt')

    sensors.clearObservation('plan')
    now += 1_000
    const cleared = sensors.read()
    expect(cleared.blockAt({ x: 40, y: 66, z: 40 })).toBeNull()
  })

  it('refreshes self and time when a targeted observation is requested', () => {
    const { port, state } = fakePort()
    let now = 0
    const sensors = new Sensors({ port, now: () => now, refreshMs: 1_000 })
    sensors.read()
    state.pos = { x: 5.5, y: 64, z: 5.5 }
    const fresh = sensors.observeBox({ min: { x: -1, y: 63, z: -1 }, max: { x: 1, y: 65, z: 1 } })
    expect(fresh.self.pos).toEqual({ x: 5.5, y: 64, z: 5.5 })
  })
})
