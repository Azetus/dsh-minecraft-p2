import { describe, expect, it } from 'vitest'

import { createMoveDriver } from '../src/mind/drivers/move.ts'
import { AsyncDriverHandle } from '../src/mind/drivers/handle.ts'
import type { Job, WorldView } from '../src/mind/types.ts'
import type { ActResult, ClientPort } from '../src/port/index.ts'

/**
 * Category: cross-module contract (todo M1-03, driver half).
 * Protects: the driver executes only the given point, reports three-state
 * results without turning `unknown` into success, and exposes stop.
 */

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function job(params: Record<string, unknown> = { x: 1, y: 64, z: 0, range: 2 }): Job {
  return {
    driverId: 'move',
    target: { kind: 'point', pos: { x: 1, y: 64, z: 0 } },
    params: params as Job['params'],
    runId: 'run-1',
    issuedAt: 0,
    budget: { maxTicks: 100, maxWallMs: 1_000 },
  }
}

function portWith(promise: Promise<ActResult>): {
  port: ClientPort
  calls: Array<{ target: unknown; opts: unknown }>
} {
  const calls: Array<{ target: unknown; opts: unknown }> = []
  const port = {
    moveTo: (target: unknown, opts: unknown) => {
      calls.push({ target, opts })
      return promise
    },
  } as unknown as ClientPort
  return { port, calls }
}

const world = {} as WorldView
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('move driver', () => {
  it('executes one moveTo for the selected point', async () => {
    const pending = deferred<ActResult>()
    const { port, calls } = portWith(pending.promise)
    const driver = createMoveDriver()
    const handle = driver.start(job(), { port, now: () => 0 })

    expect(calls).toEqual([{ target: { x: 1, y: 64, z: 0 }, opts: { range: 2, timeoutMs: 1_000 } }])
    expect(handle.result()).toEqual({ state: 'running' })
    expect(handle.continuationKey()).toBe('move:1,64,0,2')

    pending.resolve({ state: 'ok', observed: { x: 1, y: 64, z: 0 }, elapsedMs: 10 })
    await flush()
    expect(handle.result()).toMatchObject({ state: 'succeeded', observed: { x: 1, y: 64, z: 0 } })
    expect(handle.stopStatus()).toBe('stopping')
  })

  it('never reports an unknown ActResult as success', async () => {
    const pending = deferred<ActResult>()
    const { port } = portWith(pending.promise)
    const handle = createMoveDriver().start(job(), { port, now: () => 0 })
    pending.resolve({ state: 'unknown', code: 'CLIENT_TIMEOUT', elapsedMs: 10 })
    await flush()
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'CLIENT_TIMEOUT' })
    expect((handle.result().observed as { failure?: unknown }).failure)
      .toMatchObject({ layer: 'motion', phase: 'execute', code: 'CLIENT_TIMEOUT' })
  })

  it('keeps a provider failure code', async () => {
    const pending = deferred<ActResult>()
    const { port } = portWith(pending.promise)
    const handle = createMoveDriver().start(job(), { port, now: () => 0 })
    pending.resolve({ state: 'failed', code: 'GOTO_NO_PATH', elapsedMs: 10, observed: { pathStatus: 'noPath' } })
    await flush()
    expect(handle.result()).toMatchObject({ state: 'failed', code: 'GOTO_NO_PATH', observed: { pathStatus: 'noPath' } })
    expect((handle.result().observed as { failure?: unknown }).failure)
      .toMatchObject({ layer: 'motion', code: 'GOTO_NO_PATH', facts: { pathStatus: 'noPath' } })
  })

  it('adds a stuck failure body with probe and exact clear suggestions', async () => {
    const pending = deferred<ActResult>()
    const port = {
      moveTo: () => pending.promise,
      self: () => ({ pos: { x: 0.5, y: 64, z: 0.5 } }),
      blockAt: () => ({ name: 'dirt', loaded: true }),
    } as unknown as ClientPort
    const handle = createMoveDriver().start(job(), { port, now: () => 0 })
    pending.resolve({
      state: 'failed',
      code: 'GOTO_STUCK',
      elapsedMs: 10,
      observed: { bodyOverlap: { blocks: [{ x: 0, y: 64, z: 0, name: 'dirt' }] } },
    })
    await flush()

    const failure = (handle.result().observed as { failure?: Record<string, unknown> }).failure
    expect(failure).toMatchObject({
      layer: 'motion',
      code: 'GOTO_STUCK',
      cause: { kind: 'world', code: 'GOTO_STUCK' },
    })
    expect((failure?.facts as { probe?: unknown[] }).probe).toHaveLength(6)
    expect((failure?.facts as { blockedAhead?: unknown[] }).blockedAhead).toHaveLength(1)
    expect((failure?.suggestions as Array<{ action: string; confidence: string }>)[0])
      .toMatchObject({ action: 'dig', confidence: 'exact' })
  })

  it('never reports stopped when the port cannot confirm release', async () => {
    const pending = deferred<ActResult>()
    const { port } = portWith(pending.promise)
    const handle = createMoveDriver().start(job(), { port, now: () => 0 })
    handle.requestStop()
    pending.resolve({ state: 'unknown', code: 'STOP_UNCONFIRMED', elapsedMs: 10 })
    await flush()
    expect(handle.stopStatus()).toBe('unconfirmed')
    const compound = new AsyncDriverHandle('compound', Promise.resolve({ state: 'failed', code: 'STOP_UNCONFIRMED' }))
    compound.requestStop()
    await Promise.resolve()
    expect(compound.stopStatus()).toBe('unconfirmed')
  })

  it('reports interrupted and stopped when stopped before completion', async () => {
    const pending = deferred<ActResult>()
    const { port } = portWith(pending.promise)
    const handle = createMoveDriver().start(job(), { port, now: () => 0 })
    handle.requestStop()
    expect(handle.stopStatus()).toBe('stopping')
    pending.resolve({ state: 'ok', elapsedMs: 10 })
    await flush()
    expect(handle.result()).toEqual({ state: 'interrupted' })
    expect(handle.stopStatus()).toBe('stopped')
  })

  it('rejects non-finite coordinates in validate', () => {
    const driver = createMoveDriver()
    expect(driver.validate(job({ x: Number.NaN, y: 64, z: 0 }), world)).toEqual({ ok: false, code: 'BAD_ARGS' })
    expect(driver.validate(job(), world)).toEqual({ ok: true })
  })
})
