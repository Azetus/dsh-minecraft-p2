import { isRecord } from '../contracts/index.ts'
import type { JsonValue, MindEventsResult } from '../contracts/index.ts'

export type MindEventView = MindEventsResult['events'][number]

export type CompletionSeverity = 'normal' | 'critical'

/** One machine-readable line in a completion wake. */
export type CompletionItem = {
  severity: CompletionSeverity
  payload: Record<string, JsonValue>
}

type PendingItem = {
  item: CompletionItem
  /** A failure cause can be folded into the order terminal that follows it. */
  cause: boolean
  folded?: boolean
}

/**
 * Cursor over one body epoch's `mind.events`.
 *
 * A body restart starts a new event ring, so the cursor is meaningless across
 * epochs: `attach` resets it. Within one epoch the cursor is the seq of the last
 * accepted event, which makes duplicate polls harmless without a second dedupe
 * table. `p2_events` stays the full audit trail; this feed only decides which
 * transitions are worth an asynchronous wake.
 */
export class CompletionFeed {
  private epoch: string | undefined
  private cursorValue = 0
  private readonly orderQueue: string[] = []

  get currentEpoch(): string | undefined {
    return this.epoch
  }

  get cursor(): number {
    return this.cursorValue
  }

  get activeOrderId(): string | undefined {
    return this.orderQueue[0]
  }

  /** Returns true when the body epoch changed; the event cursor starts over. */
  attach(epoch: string | undefined): boolean {
    if (epoch === this.epoch) return false
    this.epoch = epoch
    this.cursorValue = 0
    this.orderQueue.length = 0
    return true
  }

  reset(): void {
    this.epoch = undefined
    this.cursorValue = 0
    this.orderQueue.length = 0
  }

  /**
   * Consume events in seq order and return only the completion items.
   * Order/job successes are merged: `job.terminal` success never wakes on its
   * own, while `order.terminal` success is one normal item.
   */
  accept(events: MindEventView[]): CompletionItem[] {
    const fresh = events
      .filter(event => Number.isFinite(event.seq) && event.seq > this.cursorValue)
      .sort((left, right) => left.seq - right.seq)
    const pending: PendingItem[] = []

    for (const event of fresh) {
      if (event.seq <= this.cursorValue) continue
      this.cursorValue = event.seq
      const data = isRecord(event.data) ? event.data : {}
      switch (event.kind) {
        case 'order.accepted': {
          const orderId = text(data.orderId)
          if (orderId !== undefined) this.orderQueue.push(orderId)
          break
        }
        case 'job.terminal': {
          // An intermediate retry is visible in p2_events but is not a wake;
          // only the terminal attempt or the order-blocked result wakes.
          if (data.retry === true) break
          const state = text(data.state)
          const blocked = data.blocked === true
          // A check job reports execution success and carries the three-state
          // observation in `observed.state`; a definitive failed/unknown
          // observation must still surface as the order's cause.
          const observed = isRecord(data.observed) ? text(data.observed.state) : undefined
          const checkFailure = data.driverId === 'check' && observed !== undefined && observed !== 'ok'
          if (state !== 'failed' && !blocked && !checkFailure) break
          const orderId = text(data.orderId) ?? this.activeOrderId
          pending.push({ item: jobFailureItem(data, orderId, blocked), cause: true })
          break
        }
        case 'plan.blocked': {
          pending.push({
            item: {
              severity: 'critical',
              payload: {
                kind: 'plan.blocked',
                planId: text(data.planId) ?? null,
                blocked: Array.isArray(data.blocked) ? data.blocked as JsonValue : [],
                ...(data.basis === undefined ? {} : { basis: data.basis }),
              },
            },
            cause: false,
          })
          break
        }
        case 'plan.material-short': {
          pending.push({ item: causeItem(event.kind, 'NO_MATERIAL', data), cause: true })
          break
        }
        case 'plan.abort': {
          pending.push({ item: causeItem(event.kind, 'CONFLICT', data), cause: true })
          break
        }
        case 'plan.verify': {
          if (text(data.state) === 'refuted') {
            pending.push({ item: causeItem(event.kind, 'BLUEPRINT_REFUTED', data), cause: true })
          }
          break
        }
        case 'plan.definition-error': {
          pending.push({ item: causeItem(event.kind, 'DEFINITION_ERROR', data), cause: true })
          break
        }
        case 'action.unreconciled': {
          pending.push({ item: causeItem(event.kind, 'UNRECONCILED', data), cause: true })
          break
        }
        case 'tracker.fault': {
          pending.push({ item: causeItem(event.kind, 'TRACKER_FAULT', data), cause: false })
          break
        }
        case 'mind.hold': {
          if (data.notify === false) break
          pending.push({
            item: {
              severity: 'critical',
              payload: compact({
                kind: 'mind.hold',
                tree: text(data.tree) ?? null,
                reason: text(data.reason) ?? 'HOLD',
              }),
            },
            cause: false,
          })
          break
        }
        case 'order.terminal': {
          const orderId = text(data.orderId)
          const state = text(data.state) ?? 'unknown'
          const last = pending[pending.length - 1]
          // A driver terminal is emitted immediately before the order terminal
          // it caused (go/dig/place/...). Fold it into the order line so
          // one wake carries orderId, state, observed and the reason.
          const folded = last !== undefined && last.cause ? last : undefined
          if (folded !== undefined) folded.folded = true
          const severity: CompletionSeverity = state === 'succeeded' || state === 'cancelled'
            ? 'normal'
            : 'critical'
          pending.push({
            item: {
              severity,
              payload: orderPayload(orderId, state, folded?.item.payload, data.observed),
            },
            cause: false,
          })
          if (orderId !== undefined) {
            const index = this.orderQueue.indexOf(orderId)
            if (index >= 0) this.orderQueue.splice(index, 1)
          }
          break
        }
        default:
          break
      }
    }

    return pending.filter(entry => entry.folded !== true).map(entry => entry.item)
  }
}

/** Text pushed to the owner; JSON lines keep the result machine-readable. */
export function formatCompletionWake(items: CompletionItem[], epoch?: string): string {
  const critical = items.some(item => item.severity === 'critical')
  const header = critical ? '[p2 completion][CRITICAL]' : '[p2 completion][DIGEST]'
  const lines = items.map(item => `- ${truncate(JSON.stringify(item.payload))}`)
  return [
    `${header}${epoch === undefined ? '' : ` body epoch=${epoch}`}`,
    ...lines,
    critical
      ? 'This is a terminal or blocked result. Read p2_report/p2_status only if you need context, then decide the next order. Do not Start-Sleep and do not poll p2_events; completion is pushed as this wake.'
      : 'No immediate action required unless your next step depends on this result.',
  ].join('\n')
}

const MAX_PAYLOAD_CHARS = 2_000

function truncate(json: string): string {
  if (json.length <= MAX_PAYLOAD_CHARS) return json
  return `${json.slice(0, MAX_PAYLOAD_CHARS)}… (truncated; p2_report has the full record)`
}

function jobFailureItem(
  data: Record<string, JsonValue>,
  orderId: string | undefined,
  blocked: boolean,
): CompletionItem {
  const code = text(data.code)
  const observedState = isRecord(data.observed) ? text(data.observed.state) : undefined
  const failure = isRecord(data.observed) ? data.observed.failure : undefined
  return {
    severity: 'critical',
    payload: compact({
      kind: 'job.terminal',
      ...(orderId === undefined ? {} : { orderId }),
      runId: text(data.runId) ?? null,
      driverId: text(data.driverId) ?? null,
      state: text(data.state) ?? 'failed',
      ...(code === undefined ? {} : { code }),
      blocked,
      reason: code ?? (blocked
        ? 'BLOCKED'
        : observedState !== undefined && observedState !== 'ok'
          ? observedState.toUpperCase()
          : 'FAILED'),
      ...(failure === undefined ? {} : { failure }),
      ...(data.observed === undefined ? {} : { observed: data.observed }),
    }),
  }
}

function causeItem(
  kind: string,
  reason: string,
  data: Record<string, JsonValue>,
): CompletionItem {
  const payload: Record<string, JsonValue> = { kind, reason }
  for (const key of ['orderId', 'planId', 'missing', 'unsupported', 'blocked', 'basis', 'errors', 'state', 'actions'] as const) {
    if (data[key] !== undefined) payload[key] = data[key]
  }
  return { severity: 'critical', payload }
}

function orderPayload(
  orderId: string | undefined,
  state: string,
  cause: Record<string, JsonValue> | undefined,
  directObserved: JsonValue | undefined,
): Record<string, JsonValue> {
  const reason = cause === undefined ? undefined : text(cause.reason)
  const observed = cause?.observed ?? directObserved
  const failure = isRecord(observed) ? observed.failure : undefined
  return compact({
    kind: 'order.terminal',
    ...(orderId === undefined ? {} : { orderId }),
    state,
    ...(reason === undefined ? {} : { reason }),
    ...(failure === undefined ? {} : { failure }),
    ...(observed === undefined ? {} : { observed }),
    ...(cause === undefined ? {} : { cause: without(cause, 'observed') }),
  })
}

function without(record: Record<string, JsonValue>, dropped: string): Record<string, JsonValue> {
  const copy: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key !== dropped) copy[key] = value
  }
  return copy
}

function compact(input: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
