import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { DutyStatusView } from '../contracts/protocol.ts'
import type { Item } from '../port/index.ts'
import { countItem } from './plan.ts'

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
  state: DutyStatusView['state']
  collected: number
  jobs: number
  startedAt: number
  deadline?: number
  lastError?: string
}

type PersistedDuty = {
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
    state: DutyStatusView['state']
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
 * The sidecar is written on start, every job start, and every terminal state.
 * On body restart an active, unexpired duty is restored; collected is recomputed
 * from the current inventory, never trusted from the file.
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

  start(input: unknown, now: number): DutyStatusView {
    const spec = parseSpec(input)
    this.seq += 1
    const duty: CurrentDuty = {
      ...spec,
      id: `duty-${now.toString(36)}-${this.seq}`,
      state: 'active',
      collected: 0,
      jobs: 0,
      startedAt: now,
      deadline: now + spec.maxWallMs,
    }
    this.current = duty
    this.persist()
    return viewOf(duty)
  }

  stop(now: number, reason = 'agent'): DutyStatusView | undefined {
    const duty = this.current
    if (duty === undefined) return undefined
    if (duty.state === 'active') {
      duty.state = 'stopped'
      duty.lastError = reason
      this.persist()
    }
    void now
    return viewOf(duty)
  }

  view(): DutyStatusView | undefined {
    return this.current === undefined ? undefined : viewOf(this.current)
  }

  /** Reconcile quota/deadline against the current inventory. */
  refresh(inventory: Item[], now: number): DutyStatusView | undefined {
    const duty = this.current
    if (duty === undefined) return undefined
    if (duty.state !== 'active') return viewOf(duty)
    const previous = duty.state
    duty.collected = countItem(inventory, duty.item)
    if (duty.collected >= duty.quota) {
      duty.state = 'completed'
    } else if (duty.deadline !== undefined && now >= duty.deadline) {
      duty.state = 'blocked'
      duty.lastError = 'DUTY_DEADLINE'
    }
    if (duty.state !== previous) this.persist()
    return viewOf(duty)
  }

  recordJobStart(now: number): void {
    const duty = this.current
    if (duty === undefined || duty.state !== 'active') return
    duty.jobs += 1
    void now
    this.persist()
  }

  canStartJob(): boolean {
    const duty = this.current
    return duty !== undefined && duty.state === 'active' && duty.jobs < duty.maxJobs
  }

  block(reason: string): DutyStatusView | undefined {
    const duty = this.current
    if (duty === undefined) return undefined
    if (duty.state === 'active') {
      duty.state = 'blocked'
      duty.lastError = reason
      this.persist()
    }
    return viewOf(duty)
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

  /** Recover the last active duty; terminal states are never resurrected. */
  restore(inventory: Item[], now: number): DutyStatusView | undefined {
    const path = this.statePath
    if (path === undefined) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return undefined
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.duty)) return undefined
    const persisted = parsed as unknown as PersistedDuty
    if (persisted.identity !== undefined && this.identity !== undefined
      && (persisted.identity.worldId !== this.identity.worldId
        || persisted.identity.characterId !== this.identity.characterId)) return undefined
    if (this.identity !== undefined && persisted.identity === undefined) return undefined
    const record = persisted.duty
    if (record === undefined || record.state !== 'active') return undefined
    let spec: DutySpec
    try {
      spec = parseSpec(record)
    } catch {
      return undefined
    }
    const duty: CurrentDuty = {
      ...spec,
      id: record.id,
      state: 'active',
      collected: 0,
      jobs: typeof record.jobs === 'number' && Number.isInteger(record.jobs) && record.jobs >= 0
        ? record.jobs
        : 0,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : now,
      ...(typeof record.deadline === 'number' ? { deadline: record.deadline } : { deadline: now + spec.maxWallMs }),
    }
    this.current = duty
    if (duty.jobs >= duty.maxJobs) {
      return this.block('DUTY_JOB_BUDGET')
    }
    return this.refresh(inventory, now)
  }

  private persist(): void {
    const path = this.statePath
    const duty = this.current
    if (path === undefined || duty === undefined) return
    const payload: PersistedDuty = {
      v: 1,
      savedAt: Date.now(),
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
        ...(duty.deadline === undefined ? {} : { deadline: duty.deadline }),
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

function parseSpec(value: unknown): DutySpec {
  if (!isRecord(value)) throw new Error('duty must be an object')
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

function viewOf(duty: CurrentDuty): DutyStatusView {
  return {
    id: duty.id,
    kind: duty.kind,
    item: duty.item,
    quota: duty.quota,
    collected: duty.collected,
    jobs: duty.jobs,
    state: duty.state,
    startedAt: duty.startedAt,
    ...(duty.deadline === undefined ? {} : { deadline: duty.deadline }),
    ...(duty.lastError === undefined ? {} : { lastError: duty.lastError }),
  }
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
