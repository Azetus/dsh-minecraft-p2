import { describe, expect, it } from 'vitest'

import { createCheckDriver } from '../src/mind/drivers/check.ts'
import { checkPosition, createCheckGiver } from '../src/mind/givers/check.ts'
import type { Job } from '../src/mind/types.ts'
import type { ClientPort } from '../src/port/index.ts'

/**
 * Category: data (M4-02 check job).
 * Protects: only the check driver opens a screen; its result is three-state;
 * verifiers never need to open one.
 */

function fakePort(result: unknown): ClientPort {
  return { containerAt: async () => result } as unknown as ClientPort
}

async function runCheck(result: unknown) {
  const driver = createCheckDriver()
  const job = { driverId: 'check', params: { x: 1, y: 64, z: 1 } } as unknown as Job
  const handle = driver.start(job, { port: fakePort(result), now: () => 1 })
  for (let index = 0; index < 50; index += 1) {
    handle.tick()
    if (handle.result().state !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  return handle.result()
}

describe('check job', () => {
  it('returns an ok container observation', async () => {
    const result = await runCheck({ state: 'ok', block: 'chest', items: [{ slot: 0, name: 'apple', count: 2 }] })
    expect(result.state).toBe('succeeded')
    expect(result.observed).toMatchObject({ kind: 'container', state: 'ok', block: 'chest' })
  })

  it('keeps failed and unknown as distinct results', async () => {
    const failed = await runCheck({ state: 'failed', code: 'CHECK_OPEN_FAILED', message: 'blocked' })
    expect(failed.state).toBe('succeeded')
    expect(failed.observed).toMatchObject({ state: 'failed', code: 'CHECK_OPEN_FAILED' })

    const unknown = await runCheck({ state: 'unknown', code: 'CHECK_NOT_LOADED' })
    expect(unknown.state).toBe('failed')
    expect(unknown.observed).toMatchObject({ state: 'unknown', code: 'CHECK_NOT_LOADED' })
  })

  it('selects the target only from an active check order', () => {
    const giver = createCheckGiver(() => ({
      order: { id: 'ord-1', verb: 'check', params: { x: 4.7, y: 64, z: -2 } },
    }))
    const candidate = giver.find({ now: 1 } as never, {} as never)
    expect(candidate).toMatchObject({
      driverId: 'check',
      target: { kind: 'point', pos: { x: 4, y: 64, z: -2 } },
      keys: 'check:ord-1',
    })
    expect(checkPosition({ order: { id: 'x', verb: 'fly' } })).toBeUndefined()
  })
})
