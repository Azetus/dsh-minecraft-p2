import type { JsonValue } from '../contracts/types.ts'
import type { MindMetricsView } from '../contracts/protocol.ts'
import { classifyFailure } from './diagnostics.ts'
import type { FailureDiagnostic } from './diagnostics.ts'

/**
 * In-memory run metrics derived from the same events the Agent can replay.
 * Counts survive the bounded event ring; no world reads and no extra writes.
 */
export class MindMetrics {
  private readonly orders = { accepted: 0, succeeded: 0, failed: 0, blocked: 0, cancelled: 0 }
  private readonly jobs = { started: 0, succeeded: 0, failed: 0, interrupted: 0, retried: 0, preempted: 0 }
  private readonly failureCodes: Record<string, number> = {}
  private readonly holdReasons: Record<string, number> = {}
  private holds = 0
  private lastFailure: FailureDiagnostic | null = null
  private updatedAt = 0

  record(kind: string, data: JsonValue, now = Date.now()): void {
    this.updatedAt = now
    const value = isRecord(data) ? data : {}
    if (kind === 'order.accepted') {
      this.orders.accepted += 1
    } else if (kind === 'order.terminal') {
      const state = value.state
      if (state === 'succeeded') this.orders.succeeded += 1
      else if (state === 'failed') this.orders.failed += 1
      else if (state === 'blocked') this.orders.blocked += 1
      else if (state === 'cancelled') this.orders.cancelled += 1
    } else if (kind === 'job.started') {
      this.jobs.started += 1
    } else if (kind === 'job.terminal') {
      const state = value.state
      if (state === 'succeeded') this.jobs.succeeded += 1
      else if (state === 'interrupted') this.jobs.interrupted += 1
      else if (state === 'failed') this.jobs.failed += 1
      if (value.retry === true) this.jobs.retried += 1
      const code = typeof value.code === 'string' ? value.code : undefined
      // A successful job may carry an informational terminal code (for
      // example ATTACK_TARGETS_RESOLVED). It is not a failure and must not
      // poison lastFailure or the failure-code table.
      if (state !== 'succeeded' && code !== undefined) {
        this.failureCodes[code] = (this.failureCodes[code] ?? 0) + 1
        this.lastFailure = classifyFailure(code)
      }
    } else if (kind === 'job.preempted') {
      this.jobs.preempted += 1
    } else if (kind === 'mind.hold') {
      this.holds += 1
      const reason = typeof value.reason === 'string' ? value.reason : 'UNKNOWN'
      this.holdReasons[reason] = (this.holdReasons[reason] ?? 0) + 1
    }
  }

  view(): MindMetricsView {
    const terminal = this.orders.succeeded + this.orders.failed + this.orders.blocked
    return {
      orders: { ...this.orders },
      jobs: { ...this.jobs },
      holds: this.holds,
      holdReasons: { ...this.holdReasons },
      failureCodes: { ...this.failureCodes },
      completionRate: terminal === 0 ? null : this.orders.succeeded / terminal,
      lastFailure: this.lastFailure,
      updatedAt: this.updatedAt,
    }
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
