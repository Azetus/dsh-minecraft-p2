import { describe, expect, it } from 'vitest'

import { createMoveDriver } from '../src/mind/drivers/move.ts'
import type { Job } from '../src/mind/types.ts'
import type { ActResult, ClientPort } from '../src/port/index.ts'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function job(): Job {
  return {
    driverId: 'move',
    target: { kind: 'point', pos: { x: 30, y: 64, z: 0 } },
    params: { x: 30, y: 64, z: 0, range: 1, timeoutMs: 60_000 },
    runId: 'run-1',
    issuedAt: 0,
    budget: { maxTicks: 3_000, maxWallMs: 60_000 },
  }
}

function source(results: ActResult[]): { port: ClientPort; calls: Array<{ target: unknown }> } {
  const calls: Array<{ target: unknown }> = []
  const port = {
    moveTo: (target: unknown) => {
      calls.push({ target })
      const next = results.shift()
      return Promise.resolve(next ?? { state: 'failed', code: 'NO_MORE_RESULTS', elapsedMs: 1 })
    },
  } as unknown as ClientPort
  return { port, calls }
}

async function run(port: ClientPort): Promise<{ state: string; [key: string]: unknown }> {
  const handle = createMoveDriver().start(job(), { port, now: () => 0 })
  for (let index = 0; index < 20 && handle.result().state === 'running'; index += 1) await flush()
  return handle.result() as { state: string; [key: string]: unknown }
}

describe('segmented move driver', () => {
  it('advances to the reachable prefix and then to the final goal', async () => {
    const fake = source([
      { state: 'failed', code: 'GOTO_NO_PATH', elapsedMs: 1, observed: { bestReachable: { x: 10, y: 64, z: 0 } } },
      { state: 'ok', elapsedMs: 1 },
      { state: 'ok', elapsedMs: 1 },
    ])
    const result = await run(fake.port)

    expect(result.state).toBe('succeeded')
    expect(fake.calls.map(call => call.target)).toEqual([
      { x: 30, y: 64, z: 0 },
      { x: 10, y: 64, z: 0 },
      { x: 30, y: 64, z: 0 },
    ])
  })

  it('does not loop when the reachable prefix is the current goal', async () => {
    const fake = source([
      { state: 'failed', code: 'GOTO_NO_PATH', elapsedMs: 1, observed: { bestReachable: { x: 30, y: 64, z: 0 } } },
    ])
    const result = await run(fake.port)

    expect(result).toMatchObject({ state: 'failed', code: 'GOTO_NO_PATH' })
    expect(fake.calls).toHaveLength(1)
  })

  it('advances toward an unloaded final target before asking for it', async () => {
    let pos = { x: 0.5, y: 64, z: 0 }
    let calls = 0
    const targets: unknown[] = []
    const port = {
      self: () => ({ pos }),
      blockAt: (point: { x: number }) => {
        if (point.x !== 30) return { name: 'air', loaded: true }
        return calls === 0 ? null : { name: 'air', loaded: true }
      },
      moveTo: (target: { x: number; y: number; z: number }) => {
        calls += 1
        targets.push(target)
        pos = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }
        return Promise.resolve({ state: 'ok', elapsedMs: 1 })
      },
    } as unknown as ClientPort

    const result = await run(port)

    expect(result.state).toBe('succeeded')
    expect(targets).toEqual([
      { x: 16, y: 64, z: 0 },
      { x: 30, y: 64, z: 0 },
    ])
  })
})
