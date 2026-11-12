import { describe, expect, it } from 'vitest'

import { JobTracker } from '../src/mind/tracker.ts'
import type { TrackerEvent } from '../src/mind/tracker.ts'
import type { SchemaNode } from '../src/mind/schema.ts'
import type {
  Candidate,
  Driver,
  DriverCtx,
  DriverHandle,
  DriverResult,
  Job,
  WorldView,
} from '../src/mind/types.ts'
import type { BodyApi, WriteToken } from '../src/body/api.ts'

/**
 * Category: state safety (todo M1-03, RUNTIME §4/§5).
 * Protects: one writer, continuation without restart, stop confirmation and the
 * late-result fence. Failure modes: a switch starts two jobs, a stale result is
 * applied, an unconfirmed stop keeps dispatching, or a stuck job never faults.
 */

const SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
    range: { type: 'number' },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: true,
}

class FakeHandle implements DriverHandle {
  ticks = 0
  stopRequested = false
  stopState: 'stopping' | 'stopped' | 'unconfirmed' = 'stopping'
  value: DriverResult = { state: 'running' }

  constructor(private readonly key: string) {}

  tick(): void {
    this.ticks += 1
  }

  requestStop(): void {
    this.stopRequested = true
  }

  stopStatus(): 'stopping' | 'stopped' | 'unconfirmed' {
    return this.stopState
  }

  result(): DriverResult {
    return this.value
  }

  continuationKey(): string {
    return this.key
  }
}

class FakeDriver implements Driver {
  readonly id = 'move'
  readonly schema = SCHEMA
  readonly defaults: {
    budget: { maxTicks: number; maxWallMs: number }
    interrupt: 'constant-only' | 'never' | 'any'
    suspendable: boolean
  }

  readonly starts: Job[] = []
  readonly handles: FakeHandle[] = []
  /** Body view handed to each run; used to prove a preempted run cannot write. */
  readonly bodies: BodyApi[] = []
  startError: Error | undefined
  validation: { ok: true } | { ok: false; code: string } = { ok: true }

  constructor(interrupt: 'constant-only' | 'never' | 'any' = 'constant-only') {
    this.defaults = {
      budget: { maxTicks: 100, maxWallMs: 1_000 },
      interrupt,
      suspendable: true,
    }
  }

  validate(): { ok: true } | { ok: false; code: string } {
    return this.validation
  }

  start(job: Job, ctx: DriverCtx): DriverHandle {
    if (this.startError !== undefined) throw this.startError
    const handle = new FakeHandle(`key-${String(job.params.x)}`)
    this.starts.push(job)
    this.handles.push(handle)
    this.bodies.push(ctx.body)
    return handle
  }
}

type Harness = {
  tracker: JobTracker
  driver: FakeDriver
  events: TrackerEvent[]
  writes: Array<{ op: 'begin' | 'end'; token: WriteToken }>
  /** Writes that actually reached the shared body (must stay empty after revoke). */
  bodyCalls: string[]
  setNow(value: number): void
}

function harness(options: { interrupt?: 'constant-only' | 'never' | 'any'; stopTimeoutMs?: number } = {}): Harness {
  const driver = new FakeDriver(options.interrupt)
  const events: TrackerEvent[] = []
  const writes: Array<{ op: 'begin' | 'end'; token: WriteToken }> = []
  const bodyCalls: string[] = []
  let now = 0
  let run = 0
  const port = {
    beginWrite: (token: WriteToken) => { writes.push({ op: 'begin', token }) },
    endWrite: (token: WriteToken) => { writes.push({ op: 'end', token }) },
    dig: async () => {
      bodyCalls.push('dig')
      return { state: 'ok', elapsedMs: 1 }
    },
    moveTo: async () => {
      bodyCalls.push('moveTo')
      return { state: 'ok', elapsedMs: 1 }
    },
    blockAt: () => {
      bodyCalls.push('blockAt')
      return null
    },
  } as unknown as BodyApi
  const tracker = new JobTracker({
    body: port,
    driver: id => {
      if (id !== 'move') throw new Error(`unknown driver: ${id}`)
      return driver
    },
    world: () => ({} as WorldView),
    now: () => now,
    newRunId: () => `run-${++run}`,
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
    onEvent: event => events.push(event),
  })
  return { tracker, driver, events, writes, bodyCalls, setNow: value => { now = value } }
}

function candidate(x = 1): Candidate {
  return {
    driverId: 'move',
    target: { kind: 'point', pos: { x, y: 64, z: 0 } },
    params: { x, y: 64, z: 0, range: 1 },
    keys: `key-${x}`,
  }
}

describe('job tracker', () => {
  it('starts one job with the writer token', () => {
    const { tracker, driver, writes, events } = harness()
    tracker.offer(candidate(1))
    tracker.tick()

    expect(tracker.state()).toBe('running')
    expect(driver.starts).toHaveLength(1)
    expect(tracker.current()?.job.runId).toBe('run-1')
    expect(writes[0]).toMatchObject({ op: 'begin', token: { runId: 'run-1', seq: 1 } })
    expect(events[0]?.kind).toBe('job.started')
  })

  it('renews a continuing candidate instead of restarting it', () => {
    const { tracker, driver, events } = harness()
    tracker.offer(candidate(1))
    tracker.tick()
    for (let index = 0; index < 5; index += 1) {
      tracker.offer(candidate(1))
      tracker.tick()
    }
    expect(driver.starts).toHaveLength(1)
    expect(events.filter(event => event.kind === 'job.renewed')).toHaveLength(1)
    expect(driver.handles[0]?.ticks).toBe(5)
  })

  it('preempts: ends the old token, waits for stopped, then starts the next job', () => {
    const { tracker, driver, writes } = harness()
    tracker.offer(candidate(1))
    tracker.tick()
    const oldHandle = driver.handles[0] as FakeHandle

    tracker.offer(candidate(2))
    tracker.tick()
    expect(tracker.state()).toBe('stopping')
    expect(oldHandle.stopRequested).toBe(true)
    expect(writes.map(entry => entry.op)).toEqual(['begin', 'end'])

    oldHandle.stopState = 'stopped'
    tracker.tick()
    expect(tracker.state()).toBe('idle')
    tracker.tick()
    expect(tracker.state()).toBe('running')
    expect(driver.starts).toHaveLength(2)
    expect(tracker.current()?.job.runId).toBe('run-2')
  })

  it('drops a stale pending candidate when the owner changes', () => {
    const { tracker, driver } = harness()
    tracker.offer(candidate(1))
    tracker.tick()
    tracker.offer(candidate(2))
    tracker.tick()
    expect(tracker.state()).toBe('stopping')

    tracker.cancelPending()
    ;(driver.handles[0] as FakeHandle).stopState = 'stopped'
    tracker.tick()
    tracker.tick()
    expect(tracker.state()).toBe('idle')
    expect(driver.starts).toHaveLength(1)
  })

  it('keeps a candidate offered while stopping instead of the captured next', () => {
    const { tracker, driver } = harness()
    tracker.offer(candidate(1))
    tracker.tick()
    tracker.offer(candidate(2))
    tracker.tick()
    expect(tracker.state()).toBe('stopping')

    tracker.offer(candidate(3))
    ;(driver.handles[0] as FakeHandle).stopState = 'stopped'
    tracker.tick()
    tracker.tick()
    expect(tracker.state()).toBe('running')
    expect(driver.starts.at(-1)?.params.x).toBe(3)
  })

  it('never preempts a driver whose interrupt policy is never', () => {
    const { tracker, driver } = harness({ interrupt: 'never' })
    tracker.offer(candidate(1))
    tracker.tick()
    tracker.offer(candidate(2))
    tracker.tick()
    expect(tracker.state()).toBe('running')
    expect(driver.starts).toHaveLength(1)
  })

  it('faults when the stop is unconfirmed and freezes dispatch', () => {
    const { tracker, driver } = harness({ stopTimeoutMs: 1_000 })
    tracker.offer(candidate(1))
    tracker.tick()
    tracker.offer(candidate(2))
    tracker.tick()
    ;(driver.handles[0] as FakeHandle).stopState = 'unconfirmed'
    tracker.tick()

    expect(tracker.state()).toBe('fault')
    expect(tracker.fault()?.code).toBe('STOP_UNCONFIRMED')

    tracker.offer(candidate(3))
    tracker.tick()
    expect(driver.starts).toHaveLength(1)
  })

  it('faults when stopped never arrives before the timeout', () => {
    const { tracker, setNow } = harness({ stopTimeoutMs: 500 })
    tracker.offer(candidate(1))
    tracker.tick(0)
    tracker.offer(candidate(2))
    tracker.tick(10)
    setNow(600)
    tracker.tick(600)
    expect(tracker.state()).toBe('fault')
  })

  it('records a terminal result and releases the token', () => {
    const { tracker, driver, writes, events } = harness()
    tracker.offer(candidate(1))
    tracker.tick()
    ;(driver.handles[0] as FakeHandle).value = { state: 'succeeded' }
    ;(driver.handles[0] as FakeHandle).stopState = 'stopped'
    tracker.tick()

    expect(tracker.state()).toBe('idle')
    expect(tracker.current()).toBeNull()
    expect(writes.at(-1)?.op).toBe('end')
    expect(events.at(-1)).toMatchObject({ kind: 'job.terminal', state: 'succeeded', blocked: false })
  })

  it('carries the owning orderId from the candidate into job events', () => {
    const { tracker, driver, events } = harness()
    tracker.offer({ ...candidate(1), orderId: 'ord-1' })
    tracker.tick()
    const handle = driver.handles[0] as FakeHandle
    handle.value = { state: 'succeeded' }
    handle.stopState = 'stopped'
    tracker.tick()

    expect(driver.starts[0]?.orderId).toBe('ord-1')
    expect(events.find(event => event.kind === 'job.started')).toMatchObject({
      kind: 'job.started',
      orderId: 'ord-1',
    })
    expect(events.at(-1)).toMatchObject({
      kind: 'job.terminal',
      orderId: 'ord-1',
      state: 'succeeded',
    })
  })

  it('blocks a work key after three failures and ignores it afterwards', () => {
    const { tracker, driver } = harness()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      tracker.offer(candidate(1))
      tracker.tick()
      const handle = driver.handles.at(-1) as FakeHandle
      handle.value = { state: 'failed', code: 'GOTO_NO_PATH' }
      handle.stopState = 'stopped'
      tracker.tick()
    }
    expect(tracker.failureCount('key-1')).toBe(3)
    expect(tracker.isBlocked('key-1')).toBe(true)
    tracker.offer(candidate(1))
    tracker.tick()
    expect(driver.starts).toHaveLength(3)
  })

  it('does not treat a terminal result as proof of released controls', () => {
    const { tracker, driver } = harness()
    tracker.offer(candidate(1))
    tracker.tick()
    const handle = driver.handles[0] as FakeHandle
    handle.value = { state: 'failed', code: 'STOP_UNCONFIRMED' }
    handle.stopState = 'unconfirmed'
    tracker.tick()
    expect(tracker.state()).toBe('fault')
    tracker.offer(candidate(2))
    tracker.tick()
    expect(driver.starts).toHaveLength(1)
  })

  it('rejects an old run result instead of applying it to the new job', () => {
    const { tracker, driver, events } = harness()
    tracker.offer(candidate(1))
    tracker.tick()
    const oldRun = tracker.current()?.job.runId as string
    tracker.offer(candidate(2))
    tracker.tick()
    ;(driver.handles[0] as FakeHandle).stopState = 'stopped'
    tracker.tick()
    tracker.tick()
    const currentRun = tracker.current()?.job.runId

    tracker.deliverResult(oldRun, { state: 'succeeded' })
    expect(tracker.current()?.job.runId).toBe(currentRun)
    expect(events.some(event => event.kind === 'job.stale-result' && event.runId === oldRun)).toBe(true)
  })

  it('rejects invalid driver params without starting the driver', () => {
    const { tracker, driver, events } = harness()
    tracker.offer({
      driverId: 'move',
      target: { kind: 'point', pos: { x: 1, y: 64, z: 0 } },
      params: { x: 1 },
      keys: 'bad',
    })
    tracker.tick()
    expect(driver.starts).toHaveLength(0)
    expect(tracker.state()).toBe('idle')
    expect(events.at(-1)).toMatchObject({ kind: 'job.terminal', code: 'BAD_ARGS' })
  })

  it('fails a job that exceeds its wall-clock budget and waits for the stop', () => {
    const { tracker, driver, events } = harness()
    tracker.offer(candidate(1))
    tracker.tick(0)
    ;(driver.handles[0] as FakeHandle).stopState = 'stopped'
    tracker.tick(2_000)

    expect(tracker.state()).toBe('stopping')
    tracker.tick(2_001)
    expect(tracker.state()).toBe('idle')
    expect(events.at(-1)).toMatchObject({
      kind: 'job.terminal',
      code: 'BUDGET_EXCEEDED',
      observed: {
        budget: { maxTicks: 100, maxWallMs: 1_000 },
        elapsedMs: 2_000,
      },
    })
  })

  it('fails a job that exceeds its game-tick budget with the elapsed age', () => {
    const { tracker, driver, events } = harness()
    tracker.offer(candidate(1))
    tracker.tick(0, 0)
    ;(driver.handles[0] as FakeHandle).stopState = 'stopped'
    tracker.tick(10, 500)

    expect(tracker.state()).toBe('stopping')
    tracker.tick(11, 500)
    expect(tracker.state()).toBe('idle')
    expect(events.at(-1)).toMatchObject({
      kind: 'job.terminal',
      code: 'BUDGET_EXCEEDED',
      observed: {
        budget: { maxTicks: 100, maxWallMs: 1_000 },
        elapsedMs: 10,
        elapsedGameAge: 500,
      },
    })
  })

  it('suspends the running job without counting a failure or blocking the key', () => {
    const { tracker, driver, events } = harness()
    tracker.offer(candidate(1))
    tracker.tick(0)
    const handle = driver.handles[0] as FakeHandle

    tracker.suspend('SUSPENDED', 100)
    expect(tracker.isSuspended()).toBe(true)
    expect(handle.stopRequested).toBe(true)
    handle.stopState = 'stopped'
    tracker.tick(101)

    const terminal = events.find(event => event.kind === 'job.terminal')
    expect(terminal).toMatchObject({ state: 'interrupted', code: 'SUSPENDED', blocked: false })
    expect(tracker.isBlocked('key-1')).toBe(false)
    expect(tracker.failureCount('key-1')).toBe(0)
  })

  it('dispatches nothing while suspended and re-offers work after resume', () => {
    const { tracker, driver } = harness()
    tracker.suspend('SUSPENDED', 0)
    tracker.offer(candidate(1))
    tracker.tick(10)
    expect(driver.starts).toHaveLength(0)

    tracker.resume(20)
    tracker.offer(candidate(1))
    tracker.tick(21)
    expect(driver.starts).toHaveLength(1)
  })

  it('does not fault a stop confirmation that is waiting through a pause', () => {
    const { tracker, driver } = harness({ stopTimeoutMs: 5 })
    tracker.offer(candidate(1))
    tracker.tick(0)
    const handle = driver.handles[0] as FakeHandle
    handle.stopState = 'stopping'

    tracker.suspend('SUSPENDED', 10)
    for (let time = 11; time < 60; time += 1) tracker.tick(time)
    expect(tracker.state()).toBe('stopping')
    expect(tracker.fault()).toBeNull()

    handle.stopState = 'stopped'
    tracker.resume(60)
    tracker.tick(61)
    expect(tracker.state()).toBe('idle')
  })
})

describe('job tracker write authority', () => {
  it('refuses the preempted run, even after the next job took over', async () => {
    const { tracker, driver, bodyCalls, events } = harness()
    tracker.offer(candidate(1))
    tracker.tick(0)
    const first = driver.bodies[0] as BodyApi
    expect(await first.dig({ x: 1, y: 64, z: 0 })).toMatchObject({ state: 'ok' })
    expect(bodyCalls).toEqual(['dig'])

    // Preempt: the old scope is revoked before the provider loses the token.
    tracker.offer(candidate(2))
    tracker.tick(1)
    expect(tracker.state()).toBe('stopping')
    const afterRevoke = await first.dig({ x: 1, y: 64, z: 0 })
    expect(afterRevoke).toMatchObject({ state: 'failed', code: 'STALE_WRITE' })
    expect(bodyCalls).toEqual(['dig'])

    // Confirm the stop and let the next run start, then retry from the old run.
    ;(driver.handles[0] as FakeHandle).stopState = 'stopped'
    tracker.tick(2)
    tracker.tick(3)
    expect(tracker.state()).toBe('running')
    expect(tracker.current()?.job.runId).toBe('run-2')

    const late = await first.dig({ x: 1, y: 64, z: 0 })
    expect(late).toMatchObject({ state: 'failed', code: 'STALE_WRITE' })
    expect(bodyCalls).toEqual(['dig'])

    // The new run keeps its authority.
    const second = driver.bodies[1] as BodyApi
    expect(await second.dig({ x: 2, y: 64, z: 0 })).toMatchObject({ state: 'ok' })
    expect(bodyCalls).toEqual(['dig', 'dig'])

    // The refusal is reported once, not silently swallowed.
    expect(events.filter(event => event.kind === 'job.write-after-stop')).toHaveLength(1)
  })

  it('keeps reads available to the preempted run', async () => {
    const { tracker, driver, bodyCalls } = harness()
    tracker.offer(candidate(1))
    tracker.tick(0)
    const first = driver.bodies[0] as BodyApi
    tracker.offer(candidate(2))
    tracker.tick(1)
    expect(first.blockAt({ x: 0, y: 64, z: 0 })).toBeNull()
    expect(bodyCalls).toEqual(['blockAt'])
  })

  it('gives each run its own scope and does not revoke a renewed run', async () => {
    const { tracker, driver } = harness()
    tracker.offer(candidate(1))
    tracker.tick(0)
    for (let index = 0; index < 3; index += 1) {
      tracker.offer(candidate(1))
      tracker.tick(index + 1)
    }
    expect(tracker.state()).toBe('running')
    const body = driver.bodies[0] as BodyApi
    expect(await body.dig({ x: 1, y: 64, z: 0 })).toMatchObject({ state: 'ok' })
  })
})

