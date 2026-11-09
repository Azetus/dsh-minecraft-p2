import { describe, expect, it } from 'vitest'

import { createFatalDriver } from '../src/mind/drivers/fatal.ts'
import type { Job } from '../src/mind/types.ts'
import type { BodyApi, Vec3 } from '../src/body/api.ts'

function job(waitMs = 0): Job {
  return {
    driverId: 'fatal',
    params: { x: 4, y: 64, z: 4, waitMs },
    runId: 'run-1',
    issuedAt: 0,
    budget: { maxTicks: 100, maxWallMs: 5_000 },
  }
}

function fakePort(health: number): { port: BodyApi; fatalCalls: Vec3[] } {
  const fatalCalls: Vec3[] = []
  const port = {
    fatalStep: async (target: Vec3) => {
      fatalCalls.push({ ...target })
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    self: () => ({ pos: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health, food: 20, onGround: true, inWater: false, inLava: false }),
    on: () => {},
    off: () => {},
  } as unknown as BodyApi
  return { port, fatalCalls }
}

async function run(port: BodyApi, waitMs = 0) {
  const handle = createFatalDriver().start(job(waitMs), { body: port, now: () => 0 })
  for (let index = 0; index < 20 && handle.result().state === 'running'; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return handle.result()
}

describe('fatal exit driver (Agent layer)', () => {
  it('succeeds only when the bot actually died', async () => {
    const { port, fatalCalls } = fakePort(0)
    const result = await run(port)
    expect(result).toMatchObject({ state: 'succeeded', observed: { kind: 'fatal', died: true } })
    expect(fatalCalls).toEqual([{ x: 4, y: 64, z: 4 }])
  })

  it('reports HAZARD_SURVIVED when the step-off did not kill the bot', async () => {
    const { port } = fakePort(20)
    const result = await run(port)
    expect(result).toMatchObject({ state: 'failed', code: 'HAZARD_SURVIVED' })
  })
})
