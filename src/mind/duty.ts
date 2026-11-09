import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { DutyState, DutyStatusView } from '../contracts/protocol.ts'
import type { Item } from '../body/api.ts'
import { countItem } from './plan.ts'
import { materialDropNames } from './materials.ts'

export type DutySpec = {
  kind: 'gather'
  item: string
  quota: number
  radius: number
  maxJobs: number
  maxWallMs: number
}

export type DutyIdentity = { worldId: string; characterId: string }

export type DutyControllerOptions = {
  /** JSON sidecar next to the order journal; absent keeps the controller in memory. */
  statePath?: string
  identity?: DutyIdentity
}

type CurrentDuty = DutySpec & {
  id: string
  state: DutyState
  baseline: number
  collected: number
  jobs: number
  startedAt: number
  /** Active time already accumulated, excluding the current active interval. */
  activeMsBase: number
  activeSince: number | undefined
  pausedMsBase: number
  pausedSince: number | undefined
  lastError?: string
  terminalReported: boolean
}

type PersistedDutyV2 = {
  v: 2
  savedAt: number
  identity?: DutyIdentity
  duty: {
    id: string
    kind: 'gather'
    item: string
    quota: number
    radius: number
    maxJobs: number
    maxWallMs: number
    state: DutyState
    jobs: number
    startedAt: number
    baseline: number
    activeMs: number
    pausedMs: number
    lastError?: string
  }
}

type PersistedDutyV1 = {
  v: 1
  savedAt: number
  identity?: DutyIdentity
  duty?: {
    id: string
    kind: 'gather'
    item: string
    quota: number
    radius: number
    maxJobs: number
    maxWallMs: number
    state: DutyState
    jobs: number
    startedAt: number
    deadline?: number
    lastError?: string
  }
}

const DEFAULT_MAX_JOBS = 8
const DEFAULT_MAX_WALL_MS = 120_000
const DEFAULT_RADIUS = 16

/**
 * A standing duty is Agent-owned intent that survives individual jobs. It only
 * opens a narrow WORK gate when no explicit order and no plan are active.
 *
 * Persistence is v2: baseline inventory, accumulated active time and pause time
 * are stored so quota and deadline survive a restart. A v1 sidecar is accepted
 * once and migrated on the next write. Terminal states are never resurrected.
 */
export class DutyController {
  private readonly statePath: string | undefined
  private readonly identity: DutyIdentity | undefined
  private current: CurrentDuty | undefined
  private seq = 0

  constructor(options: DutyControllerOptions = {}) {
    this.statePath = options.statePath
    this.identity = options.identity
  }

  /** Validate before touching the current duty; a bad spec never cancels it. */
  prepare(input: unknown): DutySpec {
    return parseSpec(input)
  }

  start(input: unknown, now: number, inventory: Item[] = []): DutyStatusView {
    return this.begin(this.prepare(input), now, inventory)
  }

  begin(spec: DutySpec, now: number, inventory: Item[] = []): DutyStatusView {
    this.seq += 1
    const duty: CurrentDuty = {
      ...spec,
      id: `duty-${now.toString(36)}-${this.seq}`,
      state: 'active',
      baseline: countDutyItem(inventory, spec.item),
      collected: 0,
      jobs: 0,
      startedAt: now,
      activeMsBase: 0,
      activeSince: now,
      pausedMsBase: 0,
      pausedSince: undefined,
      terminalReported: false,
    }
    this.current = duty
    this.persist(now)
    return this.viewOf(duty, now)
  }

  /** Agent stop: terminal cancelled, never revived. */
  stop(now: number, reason = 'agent'): DutyStatusView | undefined {
    return this.cancel(now, reason)
  }

  cancel(now: number, reason: string): DutyStatusView | undefined {
    const duty = this.current
    if (duty === undefined) return undefined
    if (duty.state === 'active') {
      this.finishActiveTime(duty, now)
      duty.state = 'cancelled'
      duty.lastError = reason
      duty.terminalReported = false
      this.persist(now)
    }
    return this.viewOf(duty, now)
  }

  fail(now: number, reason: string): DutyStatusView | undefined {
    return this.terminate(now, 'failed', reason)
  }

  view(now = Date.now()): DutyStatusView | undefined {
    return this.current === undefined ? undefined : this.viewOf(this.current, now)
  }

  /** Reconcile quota/deadline against the current inventory. */
  refresh(inventory: Item[], now: number): DutyStatusView | undefined {
    const duty = this.current
    if (duty === undefined) return undefined
    if (duty.state !== 'active') return this.viewOf(duty, now)
    duty.collected = Math.max(0, countDutyItem(inventory, duty.item) - duty.baseline)
    if (duty.collected >= duty.quota) {
      this.terminate(now, 'completed', undefined)
    } else if (this.activeMs(duty, now) >= duty.maxWallMs) {
      this.terminate(now, 'blocked', 'DUTY_DEADLINE')
    }
    return this.viewOf(duty, now)
  }

  /** Pause/resume the active-time budget without changing the duty state. */
  setPaused(paused: boolean, now: number): void {
    const duty = this.current
    if (duty === undefined || duty.state !== 'active') return
    if (paused) {
      if (duty.pausedSince !== undefined) return
      if (duty.activeSince !== undefined) {
        duty.activeMsBase += Math.max(0, now - duty.activeSince)
        duty.activeSince = undefined
      }
      duty.pausedSince = now
      this.persist(now)
      return
    }
    if (duty.pausedSince === undefined) return
    duty.pausedMsBase += Math.max(0, now - duty.pausedSince)
    duty.pausedSince = undefined
    duty.activeSince = now
    this.persist(now)
  }

  recordJobStart(now: number): void {
    const duty = this.current
    if (duty === undefined || duty.state !== 'active') return
    duty.jobs += 1
    this.persist(now)
  }

  canStartJob(): boolean {
    const duty = this.current
    return duty !== undefined && duty.state === 'active' && duty.jobs < duty.maxJobs
  }

  block(reason: string, now = Date.now()): DutyStatusView | undefined {
    return this.terminate(now, 'blocked', reason)
  }

  /** Explicit orders and plans always preempt a standing duty. */
  canWork(orderActive: boolean, planActive: boolean): boolean {
    return this.current?.state === 'active' && !orderActive && !planActive
  }

  spec(): DutySpec | undefined {
    const duty = this.current
    if (duty === undefined) return undefined
    return {
      kind: duty.kind,
      item: duty.item,
      quota: duty.quota,
      radius: duty.radius,
      maxJobs: duty.maxJobs,
      maxWallMs: duty.maxWallMs,
    }
  }

  /** Return a terminal view once; the body turns it into a duty.terminal event. */
  takeTerminal(): DutyStatusView | undefined {
    const duty = this.current
    if (duty === undefined || duty.state === 'active' || duty.terminalReported) return undefined
    duty.terminalReported = true
    return this.viewOf(duty, Date.now())
  }

  /** Recover an active duty; terminal states are never returned as active. */
  restore(inventory: Item[], now: number): DutyStatusView | undefined {
    const path = this.statePath
    if (path === undefined) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return undefined
    }
    if (!isRecord(parsed) || (parsed.v !== 1 && parsed.v !== 2) || !isRecord(parsed.duty)) return undefined
    if (!this.identityMatches(parsed)) return undefined
    const record = parsed.duty
    if (record.state !== 'active') return undefined
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : undefined
    if (id === undefined) return undefined
    let spec: DutySpec
    try {
      spec = parseSpec(record)
    } catch {
      return undefined
    }
    const jobs = typeof record.jobs === 'number' && Number.isInteger(record.jobs) && record.jobs >= 0
      ? record.jobs
      : 0
    const startedAt = typeof record.startedAt === 'number' ? record.startedAt : now
    const baseline = parsed.v === 2 && typeof record.baseline === 'number' && record.baseline >= 0
      ? Math.floor(record.baseline)
      : 0
    let activeMsBase = 0
    let pausedMsBase = 0
    if (parsed.v === 2) {
      activeMsBase = typeof record.activeMs === 'number' && record.activeMs >= 0 ? record.activeMs : 0
      pausedMsBase = typeof record.pausedMs === 'number' && record.pausedMs >= 0 ? record.pausedMs : 0
    } else if (typeof record.deadline === 'number') {
      const remaining = Math.max(0, record.deadline - now)
      activeMsBase = Math.max(0, spec.maxWallMs - remaining)
    }
    const duty: CurrentDuty = {
      ...spec,
      id,
      state: 'active',
      baseline,
      collected: 0,
      jobs,
      startedAt,
      activeMsBase,
      activeSince: now,
      pausedMsBase,
      pausedSince: undefined,
      terminalReported: true,
    }
    this.current = duty
    if (duty.jobs >= duty.maxJobs) {
      const view = this.terminate(now, 'blocked', 'DUTY_JOB_BUDGET')
      if (view !== undefined) duty.terminalReported = false
      return view
    }
    const view = this.refresh(inventory, now)
    if (view !== undefined && view.state !== 'active') duty.terminalReported = false
    return view
  }

  private terminate(now: number, state: Exclude<DutyState, 'active'>, reason: string | undefined): DutyStatusView | undefined {
    const duty = this.current
    if (duty === undefined) return undefined
    if (duty.state !== 'active') return this.viewOf(duty, now)
    this.finishActiveTime(duty, now)
    duty.state = state
    if (reason !== undefined) duty.lastError = reason
    duty.terminalReported = false
    this.persist(now)
    return this.viewOf(duty, now)
  }

  private finishActiveTime(duty: CurrentDuty, now: number): void {
    if (duty.activeSince !== undefined) {
      duty.activeMsBase += Math.max(0, now - duty.activeSince)
      duty.activeSince = undefined
    }
    if (duty.pausedSince !== undefined) {
      duty.pausedMsBase += Math.max(0, now - duty.pausedSince)
      duty.pausedSince = undefined
    }
  }

  private activeMs(duty: CurrentDuty, now: number): number {
    return duty.activeMsBase + (duty.activeSince === undefined ? 0 : Math.max(0, now - duty.activeSince))
  }

  private pausedMs(duty: CurrentDuty, now: number): number {
    return duty.pausedMsBase + (duty.pausedSince === undefined ? 0 : Math.max(0, now - duty.pausedSince))
  }

  private viewOf(duty: CurrentDuty, now: number): DutyStatusView {
    const activeMs = this.activeMs(duty, now)
    const pausedMs = this.pausedMs(duty, now)
    const remainingMs = duty.state === 'active' ? Math.max(0, duty.maxWallMs - activeMs) : undefined
    const progress = duty.quota > 0 ? Math.min(1, duty.collected / duty.quota) : 0
    return {
      id: duty.id,
      kind: duty.kind,
      item: duty.item,
      quota: duty.quota,
      baseline: duty.baseline,
      collected: duty.collected,
      progress,
      jobs: duty.jobs,
      state: duty.state,
      startedAt: duty.startedAt,
      activeMs,
      pausedMs,
      ...(remainingMs === undefined ? {} : {
        remainingMs,
        deadline: now + remainingMs,
      }),
      ...(duty.state === 'active' && duty.pausedSince !== undefined ? { paused: true } : {}),
      ...(duty.lastError === undefined ? {} : { lastError: duty.lastError }),
    }
  }

  private identityMatches(parsed: Record<string, unknown>): boolean {
    const identity = parsed.identity
    if (identity !== undefined && this.identity !== undefined) {
      if (!isRecord(identity)
        || identity.worldId !== this.identity.worldId
        || identity.characterId !== this.identity.characterId) return false
    }
    if (this.identity !== undefined && identity === undefined) return false
    return true
  }

  private persist(now: number): void {
    const path = this.statePath
    const duty = this.current
    if (path === undefined || duty === undefined) return
    const payload: PersistedDutyV2 = {
      v: 2,
      savedAt: now,
      ...(this.identity === undefined ? {} : { identity: this.identity }),
      duty: {
        id: duty.id,
        kind: duty.kind,
        item: duty.item,
        quota: duty.quota,
        radius: duty.radius,
        maxJobs: duty.maxJobs,
        maxWallMs: duty.maxWallMs,
        state: duty.state,
        jobs: duty.jobs,
        startedAt: duty.startedAt,
        baseline: duty.baseline,
        activeMs: this.activeMs(duty, now),
        pausedMs: this.pausedMs(duty, now),
        ...(duty.lastError === undefined ? {} : { lastError: duty.lastError }),
      },
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(payload)}\n`, 'utf8')
    } catch {
      // Persistence must not crash the body; the next tick keeps working in memory.
    }
  }
}

function parseSpec(value: unknown): DutySpec {  if (!isRecord(value)) throw new Error('duty must be an object')
  if (value.kind !== undefined && value.kind !== 'gather') {
    throw new Error('only duty.kind=gather is supported in D1')
  }
  const item = typeof value.item === 'string' ? value.item.trim() : ''
  if (item.length === 0) throw new Error('duty.item is required')
  const quota = integer(value.quota, 1, 1024, 'duty.quota')
  const radius = value.radius === undefined ? DEFAULT_RADIUS : integer(value.radius, 1, 32, 'duty.radius')
  const maxJobs = value.maxJobs === undefined
    ? DEFAULT_MAX_JOBS
    : integer(value.maxJobs, 1, 64, 'duty.maxJobs')
  const maxWallMs = value.maxWallMs === undefined
    ? DEFAULT_MAX_WALL_MS
    : integer(value.maxWallMs, 1_000, 3_600_000, 'duty.maxWallMs')
  return { kind: 'gather', item, quota, radius, maxJobs, maxWallMs }
}

function countDutyItem(inventory: Item[], item: string): number {
  return materialDropNames(item).reduce((total, name) => total + countItem(inventory, name), 0)
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
