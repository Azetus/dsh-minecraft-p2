import type { ClientPort, WriteToken } from '../port/index.ts'
import { validateParams } from './schema.ts'
import type {
  Candidate,
  Driver,
  DriverHandle,
  DriverResult,
  Job,
  WorldView,
} from './types.ts'

export type TrackerState = 'idle' | 'starting' | 'running' | 'stopping' | 'fault'

export type TrackerFault = {
  code: string
  since: number
  detail?: string
}

export type TrackerEvent =
  | { kind: 'job.started'; at: number; runId: string; driverId: string; keys: string; orderId?: string; workItemId?: string }
  | { kind: 'job.renewed'; at: number; runId: string; keys: string }
  | { kind: 'job.terminal'; at: number; runId: string; driverId: string; state: DriverResult['state']; code?: string; blocked: boolean; observed?: DriverResult['observed']; orderId?: string; keys: string; workItemId?: string }
  | { kind: 'job.preempted'; at: number; runId: string; keys: string }
  | { kind: 'job.stale-result'; at: number; runId: string; state: DriverResult['state'] }
  | { kind: 'tracker.fault'; at: number; code: string }

export type JobTrackerOptions = {
  port: ClientPort
  driver: (id: string) => Driver
  world: () => WorldView
  now?: () => number
  newRunId?: () => string
  /** How long a preemption may wait for `stopped` before faulting. */
  stopTimeoutMs?: number
  /** Failures of the same work key before it is considered blocked. */
  maxFailures?: number
  /** Write the pending intent before the driver performs its first action. */
  beforeStart?: (candidate: Candidate, job: Job) => void
  onEvent?: (event: TrackerEvent) => void
}

type Current = {
  job: Job
  driver: Driver
  handle: DriverHandle
  token: WriteToken
  /** Candidate continuation key; also the M1 failure/block identity. */
  keys: string
  /** First server age observed for this job, for the game-tick budget. */
  startAge?: number
}

type StopInfo = {
  since: number
  job: Job
  handle: DriverHandle
  keys: string
  /** Set when the stop was caused by a terminal condition (for example budget). */
  final?: DriverResult
  next?: Candidate
}

/**
 * Single-writer arbiter: continuation, switching, stop confirmation and the
 * late-result fence. It never selects targets and never executes.
 */
export class JobTracker {
  private readonly port: ClientPort
  private readonly driverLookup: (id: string) => Driver
  private readonly world: () => WorldView
  private readonly now: () => number
  private readonly newRunId: () => string
  private readonly stopTimeoutMs: number
  private readonly maxFailures: number
  private readonly beforeStart: ((candidate: Candidate, job: Job) => void) | undefined
  private readonly onEvent: ((event: TrackerEvent) => void) | undefined
  private stateValue: TrackerState = 'idle'
  private currentValue: Current | undefined
  private pending: Candidate | undefined
  private stopInfo: StopInfo | undefined
  private faultValue: TrackerFault | undefined
  private seq = 0
  private readonly failures = new Map<string, number>()
  private readonly blocked = new Set<string>()
  private lastRenewedKeys: string | undefined
  private rejectedSeq = 0
  private suspended = false
  private pausedAt = 0

  constructor(options: JobTrackerOptions) {
    this.port = options.port
    this.driverLookup = options.driver
    this.world = options.world
    this.now = options.now ?? (() => Date.now())
    this.newRunId = options.newRunId ?? (() => `run-${this.seq}`)
    this.stopTimeoutMs = options.stopTimeoutMs ?? 2_000
    this.maxFailures = options.maxFailures ?? 3
    this.beforeStart = options.beforeStart
    this.onEvent = options.onEvent
  }

  state(): TrackerState {
    return this.stateValue
  }

  current(): { job: Job; driverId: string } | null {
    const current = this.currentValue
    return current === undefined ? null : { job: current.job, driverId: current.job.driverId }
  }

  fault(): TrackerFault | null {
    return this.faultValue ?? null
  }

  isBlocked(key: string): boolean {
    return this.blocked.has(key)
  }

  failureCount(key: string): number {
    return this.failures.get(key) ?? 0
  }

  /** Offer the latest candidate. A null offer means "no work right now". */
  offer(candidate: Candidate | null): void {
    if (this.stateValue === 'fault' || this.suspended) return
    if (candidate === null) {
      this.pending = undefined
      return
    }
    // Work-item candidates are governed by the plan's item ledger: it can
    // re-evaluate a block after the world changes. A key blocked here would
    // otherwise swallow every offer and stall the plan without a job.
    if (candidate.workItemId === undefined && this.blocked.has(candidate.keys)) return
    if (this.stateValue === 'running' && this.currentValue !== undefined) {
      if (candidate.keys === this.currentValue.handle.continuationKey()) {
        this.renew(this.currentValue.job.runId, candidate.keys)
        return
      }
    }
    this.pending = candidate
  }

  isSuspended(): boolean {
    return this.suspended
  }

  /**
   * Game/server suspension is not failure: stop the current act so no control
   * stays pressed, but never count it as a retry. The order/plan stays active.
   */
  suspend(code = 'SUSPENDED', now = this.now()): void {
    if (this.suspended || this.stateValue === 'fault') return
    this.suspended = true
    this.pausedAt = now
    this.pending = undefined
    if (this.stateValue === 'running' && this.currentValue !== undefined) {
      this.beginStop(now, { state: 'interrupted', code })
    }
  }

  /** Resume after the server ticks again; the giver recomputes the next step. */
  resume(now = this.now()): void {
    if (!this.suspended) return
    this.suspended = false
    // Paused wall time is not budget: shift a pending stop confirmation.
    if (this.stopInfo !== undefined && this.pausedAt > 0) {
      this.stopInfo.since += now - this.pausedAt
    }
    this.pausedAt = 0
  }

  /**
   * End the current job without a replacement (order cancelled). The stop is
   * confirmed like any preemption; failure to confirm still faults.
   */
  abort(code = 'CANCELLED'): void {
    if (this.stateValue !== 'running' || this.currentValue === undefined) return
    this.beginStop(this.now(), { state: 'interrupted', code })
  }

  /**
   * Report a result a driver produced after its run was dropped. Anything that
   * is not the current run is recorded and never applied.
   */
  deliverResult(runId: string, result: DriverResult): void {
    const current = this.currentValue
    if (current !== undefined && current.job.runId === runId) return
    this.emit({ kind: 'job.stale-result', at: this.now(), runId, state: result.state })
  }

  tick(now = this.now(), gameAge?: number): void {
    if (this.stateValue === 'fault') return
    if (this.suspended) {
      // A stop already requested still needs its confirmation; nothing new is
      // dispatched and no wall-clock budget is consumed while paused.
      if (this.stateValue === 'stopping') this.tickStopping(now)
      return
    }
    if (this.stateValue === 'idle' && this.pending !== undefined) {
      const candidate = this.pending
      this.pending = undefined
      this.start(candidate, now, gameAge)
      return
    }
    if (this.stateValue === 'running') {
      this.tickRunning(now, gameAge)
      return
    }
    if (this.stateValue === 'stopping') {
      this.tickStopping(now)
    }
  }

  private tickRunning(now: number, gameAge: number | undefined): void {
    const current = this.currentValue
    if (current === undefined) {
      this.stateValue = 'idle'
      return
    }
    if (now - current.job.issuedAt > current.job.budget.maxWallMs) {
      this.beginStop(now, { state: 'failed', code: 'BUDGET_EXCEEDED' })
      return
    }
    if (gameAge !== undefined) {
      if (current.startAge === undefined) current.startAge = gameAge
      else if (gameAge - current.startAge > current.job.budget.maxTicks) {
        this.beginStop(now, { state: 'failed', code: 'BUDGET_EXCEEDED' })
        return
      }
    }

    current.handle.tick()
    const result = current.handle.result()
    if (result.state !== 'running') {
      this.finish(result, now)
      return
    }

    const candidate = this.pending
    if (candidate !== undefined
      && candidate.keys !== current.handle.continuationKey()
      && current.driver.defaults.interrupt !== 'never') {
      this.beginStop(now, undefined)
    }
  }

  private tickStopping(now: number): void {
    const info = this.stopInfo
    if (info === undefined) {
      this.stateValue = 'idle'
      return
    }
    info.handle.tick()
    const status = info.handle.stopStatus()
    if (status === 'unconfirmed' || (!this.suspended && now - info.since > this.stopTimeoutMs)) {
      this.faultValue = { code: 'STOP_UNCONFIRMED', since: now }
      this.stateValue = 'fault'
      this.pending = undefined
      this.emit({ kind: 'tracker.fault', at: now, code: 'STOP_UNCONFIRMED' })
      return
    }
    if (status !== 'stopped') return

    if (info.final !== undefined) {
      this.recordTerminal(info.keys, info.job, info.final, now)
    } else {
      this.emit({ kind: 'job.preempted', at: now, runId: info.job.runId, keys: info.keys })
    }
    this.currentValue = undefined
    this.stopInfo = undefined
    this.stateValue = 'idle'
    this.pending = info.next
    this.lastRenewedKeys = undefined
  }

  private start(candidate: Candidate, now: number, gameAge?: number): void {
    let driver: Driver
    try {
      driver = this.driverLookup(candidate.driverId)
    } catch (error) {
      this.reject(candidate, { state: 'failed', code: errorCode(error, 'DEFINITION_ERROR') }, now)
      return
    }

    const issue = validateParams(driver.schema, candidate.params)
    if (issue !== undefined) {
      this.reject(candidate, { state: 'failed', code: 'BAD_ARGS' }, now)
      return
    }

    this.seq += 1
    const runId = this.newRunId()
    const job: Job = {
      driverId: candidate.driverId,
      target: candidate.target,
      params: candidate.params,
      ...(candidate.orderId === undefined ? {} : { orderId: candidate.orderId }),
      ...(candidate.workItemId === undefined ? {} : { workItemId: candidate.workItemId }),
      runId,
      issuedAt: now,
      budget: driver.defaults.budget,
    }
    const validation = driver.validate(job, this.world())
    if (!validation.ok) {
      this.reject(candidate, { state: 'failed', code: validation.code }, now)
      return
    }

    const token: WriteToken = { runId, jobId: `job-${this.seq}`, seq: this.seq }
    try {
      this.port.beginWrite(token)
    } catch (error) {
      this.reject(candidate, { state: 'failed', code: errorCode(error, 'STALE_WRITE') }, now)
      return
    }

    try {
      this.beforeStart?.(candidate, job)
    } catch (error) {
      try { this.port.endWrite(token) } catch { /* best effort */ }
      this.reject(candidate, { state: 'failed', code: errorCode(error, 'JOURNAL_FAULT') }, now)
      return
    }

    let handle: DriverHandle
    try {
      handle = driver.start(job, { port: this.port, now: this.now })
    } catch (error) {
      try { this.port.endWrite(token) } catch { /* best effort */ }
      this.reject(candidate, { state: 'failed', code: errorCode(error, 'DRIVER_FAULT') }, now)
      return
    }

    this.currentValue = {
      job,
      driver,
      handle,
      token,
      keys: candidate.keys,
      ...(gameAge === undefined ? {} : { startAge: gameAge }),
    }
    this.lastRenewedKeys = undefined
    this.stateValue = 'running'
    this.emit({ kind: 'job.started', at: now, runId, driverId: job.driverId, keys: candidate.keys,
      ...(candidate.orderId === undefined ? {} : { orderId: candidate.orderId }),
      ...(candidate.workItemId === undefined ? {} : { workItemId: candidate.workItemId }) })
  }

  private beginStop(now: number, final: DriverResult | undefined): void {
    const current = this.currentValue
    if (current === undefined) return
    this.stateValue = 'stopping'
    this.stopInfo = {
      since: now,
      job: current.job,
      handle: current.handle,
      keys: current.keys,
      ...(final === undefined ? {} : { final }),
      ...(this.pending === undefined ? {} : { next: this.pending }),
    }
    this.pending = undefined
    try {
      this.port.endWrite(current.token)
    } catch {
      // The token may already be invalid; stop confirmation still decides.
    }
    current.handle.requestStop()
  }

  private finish(result: DriverResult, now: number): void {
    // A terminal result does not prove that navigation released its controls.
    // Use the same confirmation as preemption before dispatching another job.
    this.beginStop(now, result)
    this.tickStopping(now)
  }

  private reject(candidate: Candidate, result: DriverResult, now: number): void {
    this.rejectedSeq += 1
    const job: Job = {
      driverId: candidate.driverId,
      target: candidate.target,
      params: candidate.params,
      ...(candidate.orderId === undefined ? {} : { orderId: candidate.orderId }),
      ...(candidate.workItemId === undefined ? {} : { workItemId: candidate.workItemId }),
      runId: `rejected-${this.rejectedSeq}`,
      issuedAt: now,
      budget: { maxTicks: 0, maxWallMs: 0 },
    }
    this.recordTerminal(candidate.keys, job, result, now)
  }

  private recordTerminal(keys: string, job: Job, result: DriverResult, now: number): void {
    let blocked = false
    if (result.state === 'failed') {
      const failures = (this.failures.get(keys) ?? 0) + 1
      this.failures.set(keys, failures)
      if (failures >= this.maxFailures) blocked = true
    }
    this.emit({
      kind: 'job.terminal',
      at: now,
      runId: job.runId,
      driverId: job.driverId,
      state: result.state,
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.observed === undefined ? {} : { observed: result.observed }),
      ...(job.orderId === undefined ? {} : { orderId: job.orderId }),
      ...(job.workItemId === undefined ? {} : { workItemId: job.workItemId }),
      keys,
      blocked,
    })
    if (blocked && job.workItemId === undefined) this.blocked.add(keys)
  }

  private renew(runId: string, keys: string): void {
    if (this.lastRenewedKeys === keys) return
    this.lastRenewedKeys = keys
    this.emit({ kind: 'job.renewed', at: this.now(), runId, keys })
  }

  private emit(event: TrackerEvent): void {
    this.onEvent?.(event)
  }
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : fallback
}
