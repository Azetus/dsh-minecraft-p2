import type { JsonValue } from '../contracts/types.ts'
import type {
  BlockInfo,
  Box,
  ClientPort,
  EntityInfo,
  SelfInfo,
  Vec3,
} from '../port/index.ts'
import type { SchemaNode } from './schema.ts'

/** A selected target. M1 only needs points; more kinds arrive with plans. */
export type Target = { kind: 'point'; pos: Vec3 }

export type Candidate = {
  driverId: string
  target: Target
  params: Record<string, JsonValue>
  /** Continuation key: the same key means "continue", not "restart". */
  keys: string
}

/** Prerequisite work a giver asks for; the caller re-runs `find` afterwards. */
export type Handoff = {
  driverId: string
  target: Target
  params: Record<string, JsonValue>
  reason: string
}

/**
 * One consistent observation snapshot. Predicates and givers read only this;
 * they never query the game themselves.
 */
export type WorldView = {
  self: SelfInfo
  time: { timeOfDay: number; worldAge: number }
  blockAt(p: Vec3): BlockInfo | null
  blocksIn(box: Box, filter?: string[]): BlockInfo[]
  entitiesIn(box: Box): EntityInfo[]
}

export type EvalCtx = {
  now: number
  /** Where "home" is for this body; absent until the body records its start. */
  home?: Vec3
}

export interface WorkGiver {
  id: string
  score?(ctx: EvalCtx, world: WorldView): number
  find(ctx: EvalCtx, world: WorldView): Candidate | Handoff | null
}

export type Budget = { maxTicks: number; maxWallMs: number }

export type Job = {
  driverId: string
  target?: Target
  params: Record<string, JsonValue>
  orderId?: string
  workItemId?: string
  runId: string
  issuedAt: number
  budget: Budget
}

export type DriverInterrupt = 'constant-only' | 'never' | 'any'

export type DriverDefaults = {
  budget: Budget
  interrupt: DriverInterrupt
  suspendable: boolean
}

export type DriverResult = {
  state: 'running' | 'succeeded' | 'failed' | 'interrupted'
  code?: string
  observed?: JsonValue
}

export interface DriverHandle {
  tick(): void
  requestStop(): void
  stopStatus(): 'stopping' | 'stopped' | 'unconfirmed'
  result(): DriverResult
  continuationKey(): string
}

export type DriverValidation = { ok: true } | { ok: false; code: string }

export type DriverCtx = {
  port: ClientPort
  now: () => number
}

export interface Driver {
  id: string
  schema: SchemaNode
  defaults: DriverDefaults
  validate(job: Job, world: WorldView): DriverValidation
  start(job: Job, ctx: DriverCtx): DriverHandle
}
