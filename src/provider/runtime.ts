import type { JsonValue, P2Error, ValueMeta } from '../contracts/types.ts'

/**
 * Provider-facing outcome shapes for the current adapter surface.
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
  /** How the last stop was proven; `null` until a stop was requested. */
  controlRelease?(): 'confirmed' | 'best-effort' | null
  cleanup?(): ActPoll
}

export type ActPort = {
  start(name: string, args: Record<string, JsonValue>): ActHandle
}
