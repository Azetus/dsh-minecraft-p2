import { isRecord } from '../contracts/index.ts'
import type { CompletionItem } from './completion-wake.ts'

type OrderEntry = { verb: string; key: string }

type SessionState = {
  failures: Map<string, number>
  orders: Map<string, OrderEntry>
}

/** Stable key for "the same target" across primitive order verbs. */
export function orderTargetKey(verb: string, params: unknown): string {
  const record = isRecord(params) ? params : {}
  switch (verb) {
    case 'go':
    case 'place':
    case 'use':
    case 'check':
    case 'container':
    case 'build':
    case 'traverse':
      return cellKey(record) ?? '-'
    case 'dig': {
      const from = isRecord(record.from) ? cellKey(record.from) : undefined
      if (from !== undefined) {
        const to = isRecord(record.to) ? cellKey(record.to) : '-'
        return `dig:${from}->${to}:${typeof record.height === 'number' ? record.height : 1}`
      }
      return cellKey(record) ?? '-'
    }
    case 'attack':
      return typeof record.entityId === 'string' ? `entity:${record.entityId}` : '-'
    case 'craft':
    case 'equip':
      return typeof record.item === 'string' ? `item:${record.item}` : '-'
    case 'hold':
      return 'hold'
    default:
      return '-'
  }
}

export function repeatHint(verb: string, failures: number): string {
  return `the same ${verb} target has failed ${failures} times; change the coordinate, verb, or region instead of resubmitting it unchanged`
}

/**
 * Counts failed terminals per (session, verb, target). The accepted result
 * warns before the next submission; the completion wake repeats the hint once
 * the failure count reaches two. It never blocks an order.
 */
export class RepeatTracker {
  private readonly sessions = new Map<string, SessionState>()

  noteAccepted(sessionId: string, orderId: string, verb: string, params: unknown): number {
    const state = this.session(sessionId)
    const key = orderTargetKey(verb, params)
    state.orders.set(orderId, { verb, key })
    return state.failures.get(key) ?? 0
  }

  noteTerminal(sessionId: string, orderId: string, state: string): { verb: string; key: string; failures: number } | undefined {
    const session = this.session(sessionId)
    const entry = session.orders.get(orderId)
    if (entry === undefined) return undefined
    session.orders.delete(orderId)
    if (state === 'succeeded' || state === 'cancelled' || state === 'abandoned') {
      session.failures.delete(entry.key)
      return { ...entry, failures: 0 }
    }
    const failures = (session.failures.get(entry.key) ?? 0) + 1
    session.failures.set(entry.key, failures)
    return { ...entry, failures }
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { failures: new Map(), orders: new Map() }
      this.sessions.set(sessionId, state)
    }
    return state
  }
}

/**
 * Annotate order-terminal wake payloads with a non-blocking repeat hint. The
 * payload is a plain record owned by the completion feed, so this is a
 * presentation-only mutation before formatting.
 */
export function annotateCompletion(items: CompletionItem[], tracker: RepeatTracker, sessionId: string): void {
  for (const item of items) {
    const payload = item.payload
    if (payload.kind !== 'order.terminal') continue
    if (typeof payload.orderId !== 'string' || typeof payload.state !== 'string') continue
    if (payload.repeatFailures !== undefined) continue
    const result = tracker.noteTerminal(sessionId, payload.orderId, payload.state)
    if (result === undefined || result.failures < 2) continue
    payload.repeatFailures = result.failures
    payload.repeatHint = repeatHint(result.verb, result.failures)
  }
}

function cellKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.x !== 'number' || typeof value.y !== 'number' || typeof value.z !== 'number') return undefined
  return `${Math.floor(value.x)},${Math.floor(value.y)},${Math.floor(value.z)}`
}
