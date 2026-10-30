import type { JsonValue, P2Error, ValueMeta } from '../contracts/types.ts'
import type { ArtifactRef } from '../contracts/artifacts.ts'

export type QueryOutcome =
  | { status: 'ok'; value: JsonValue; meta?: ValueMeta }
  | { status: 'failed'; error: P2Error }
  | { status: 'pending'; poll(): QueryOutcome }

/** A bare observation request plus host-side freshness/deadline hints. */
export type QueryRef = {
  op: string
  args?: Record<string, JsonValue>
  freshnessMs?: number
  timeoutMs?: number
}

export type QueryPort = (ref: QueryRef, args: Record<string, JsonValue>) => QueryOutcome

export type PolicyOutcome =
  | { status: 'ok'; value: JsonValue; meta?: ValueMeta }
  | { status: 'failed'; error: P2Error }
  | { status: 'pending'; poll(): PolicyOutcome }

export type PolicyPort = {
  call(ref: ArtifactRef, inputs: Record<string, JsonValue>): PolicyOutcome
}

export type ActPoll =
  | { status: 'running' }
  | { status: 'succeeded'; result?: JsonValue; meta?: ValueMeta }
  | { status: 'failed'; error: P2Error }
  | { status: 'cancelled'; error?: P2Error }

export type ActHandle = {
  poll(): ActPoll
  stop(): void
  cleanup?(): ActPoll
}

/** Act references are exact artifacts (the string form is a test convenience). */
export type ActRefLike = ArtifactRef | string

/** Identity the controller stamps on every control operation it starts. */
export type ActIdentity = {
  runId: string
  actInstanceId: string
  /** Control-authority generation; incremented when a stop accepts. */
  generation: number
}

/** Result of polling a pending release; `unconfirmed` is sticky until confirmed. */
export type ReleaseStatus = 'idle' | 'stopping' | 'released' | 'unconfirmed'

export type ActPort = {
  start(ref: ActRefLike, args: Record<string, JsonValue>, identity?: ActIdentity): ActHandle
  /** Begin releasing this owner's control ledger; returns before release is proven. */
  stopRun?(now: number, runId?: string): void
  /** Poll release proof; omitted means the port cannot prove release. */
  pollRelease?(now: number): ReleaseStatus
}
