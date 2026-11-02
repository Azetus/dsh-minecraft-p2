import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import type { Bot } from 'mineflayer'
import { MotionRun } from '../src/motion/mineflayer/run.ts'

function unloadedTargetBot(): Bot {
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    registry: { blocks: {} },
    entity: { position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true },
    health: 20,
    time: { age: 1 },
    entities: {},
    getControlState: () => false,
    clearControlStates: () => {},
    look: async () => {},
    dig: async () => {},
    placeBlock: async () => {},
    activateBlock: async () => {},
    blockAt: (p: { x: number; y: number; z: number }) => {
      if (p.x > 20) return null
      if (p.y === 63) return { type: 1, name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], hardness: 1.5, diggable: true, getProperties: () => ({}) }
      return { type: 0, name: 'air', shapes: [], getProperties: () => ({}) }
    },
  })
  return bot as unknown as Bot
}

describe('MotionRun unloaded target resolution', () => {
  it('advances toward an unloaded target with a core-owned prefix', () => {
    const run = new MotionRun(unloadedTargetBot(), { x: 100, y: 64, z: 0 }, 1, 30_000)
    run.start()
    const report = run.report() as { target: { x: number }; activeTarget: { x: number } }
    expect(report.target.x).toBe(100)
    expect(report.activeTarget.x).toBeGreaterThan(0)
    expect(report.activeTarget.x).toBeLessThan(100)
    run.stop()
  })
})
