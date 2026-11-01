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

type CurrentDuty = DutySpec & {
  id: string
  state: DutyStatusView['state']
  collected: number
  jobs: number
  startedAt: number
  deadline?: number
  lastError?: string
}

const DEFAULT_MAX_JOBS = 8
const DEFAULT_MAX_WALL_MS = 120_000
const DEFAULT_RADIUS = 16

/**
 * A standing duty is Agent-owned intent that survives individual jobs. It only
 * opens a narrow WORK gate (gather one item to a quota) when no explicit order
 * and no plan are active.
 */
export class DutyController {
  private current: CurrentDuty | undefined
  private seq = 0

  start(input: unknown, now: number): DutyStatusView {
    if (!isRecord(input)) throw new Error('duty must be an object')
    if (input.kind !== undefined && input.kind !== 'gather') {
      throw new Error('only duty.kind=gather is supported in D1')
    }
    const item = typeof input.item === 'string' ? input.item.trim() : ''
    if (item.length === 0) throw new Error('duty.item is required')
    const quota = integer(input.quota, 1, 1024, 'duty.quota')
    const radius = input.radius === undefined ? DEFAULT_RADIUS : integer(input.radius, 1, 32, 'duty.radius')
    const maxJobs = input.maxJobs === undefined
      ? DEFAULT_MAX_JOBS
      : integer(input.maxJobs, 1, 64, 'duty.maxJobs')
    const maxWallMs = input.maxWallMs === undefined
      ? DEFAULT_MAX_WALL_MS
      : integer(input.maxWallMs, 1_000, 3_600_000, 'duty.maxWallMs')
    this.seq += 1
    const duty: CurrentDuty = {
      kind: 'gather',
      item,
      quota,
      radius,
      maxJobs,
      maxWallMs,
      id: `duty-${now.toString(36)}-${this.seq}`,
      state: 'active',
      collected: 0,
      jobs: 0,
      startedAt: now,
      deadline: now + maxWallMs,
    }
    this.current = duty
    return viewOf(duty)
  }

  stop(now: number, reason = 'agent'): DutyStatusView | undefined {
    const duty = this.current
    if (duty === undefined) return undefined
    if (duty.state === 'active') {
      duty.state = 'stopped'
      duty.lastError = reason
    }
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
    duty.collected = countItem(inventory, duty.item)
    if (duty.collected >= duty.quota) {
      duty.state = 'completed'
    } else if (duty.deadline !== undefined && now >= duty.deadline) {
      duty.state = 'blocked'
      duty.lastError = 'DUTY_DEADLINE'
    }
    return viewOf(duty)
  }

  recordJobStart(now: number): void {
    const duty = this.current
    if (duty === undefined || duty.state !== 'active') return
    duty.jobs += 1
    void now
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
