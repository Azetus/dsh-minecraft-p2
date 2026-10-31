import type { JsonValue, P2Error, ValueMeta } from '../contracts/types.ts'

/**
 * Provider-facing outcome shapes. The mineflayer provider still speaks the
 * old query/act surface; M0 replaces the callers (body, controller) while the
 * provider keeps working, so these types stay next to it instead of in a
 * shared runtime layer.
 */

export type QueryOutcome =
  | { status: 'ok'; value: JsonValue; meta?: ValueMeta }
  | { status: 'failed'; error: P2Error }
  | { status: 'pending'; poll(): QueryOutcome }

export type QueryRef = {
  op: string
  args?: Record<string, JsonValue>
}

export type QueryPort = (ref: QueryRef, args: Record<string, JsonValue>) => QueryOutcome

export type ActPoll =
  | { status: 'running'; progress?: JsonValue }
  | { status: 'succeeded'; result?: JsonValue; meta?: ValueMeta }
  | { status: 'failed'; error: P2Error }
  | { status: 'cancelled'; error?: P2Error }

export type ActHandle = {
  poll(): ActPoll
  stop(): void
  controlState?(): 'idle' | 'active' | 'unknown'
  cleanup?(): ActPoll
}

export type ActPort = {
  start(name: string, args: Record<string, JsonValue>): ActHandle
}
