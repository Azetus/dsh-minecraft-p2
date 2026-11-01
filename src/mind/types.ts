import type { JsonValue } from '../contracts/types.ts'
import type { HazardPolicy } from '../port/terrain.ts'
import type {
  BlockInfo,
  Box,
  ClientPort,
  EntityInfo,
  Item,
  SelfInfo,
  Vec3,
} from '../port/index.ts'
import type { SchemaNode } from './schema.ts'
import type { PlanInstance } from './plan.ts'
import type { ConflictPolicy, MaterialPolicy } from './policy.ts'

/** A selected target. M1 only needs points; more kinds arrive with plans. */
export type Target = { kind: 'point'; pos: Vec3 }

export type Candidate = {
  driverId: string
  target: Target
  params: Record<string, JsonValue>
  /** Continuation key: the same key means "continue", not "restart". */
  keys: string
  /** Owning order, when the candidate serves a task; absent for reflexes. */
  orderId?: string
}

/** Prerequisite work a giver asks for; the caller re-runs `find` afterwards. */
export type Handoff = {
  driverId: string
  target: Target
  params: Record<string, JsonValue>
  reason: string
  orderId?: string
}

/**
 * Retain the current intent without producing a job. `notify: false` is for a
 * deliberate wait (a `hold` order) whose caller already knows; everything else
 * is a blocked report worth surfacing.
 */
export type Hold = {
  kind: 'hold'
  reason: string
  notify?: boolean
  /** Structured diagnostics for the Agent; absent for a plain wait. */
  data?: JsonValue
}

export type WorkGiverResult = Candidate | Handoff | Hold | null

export function isHold(value: WorkGiverResult): value is Hold {
  return value !== null && 'kind' in value && value.kind === 'hold'
}

/**
 * One consistent observation snapshot. Predicates and givers read only this;
 * they never query the game themselves.
 */
export type WorldView = {
  self: SelfInfo
  time: { timeOfDay: number; worldAge: number }
  /** True when the sensor snapshot is older than its budget. */
  stale?: boolean
  inventory: Item[]
  blockAt(p: Vec3): BlockInfo | null
  blocksIn(box: Box, filter?: string[]): BlockInfo[]
  entitiesIn(box: Box): EntityInfo[]
}

export type EvalCtx = {
  now: number
  /** Where "home" is for this body; absent until the body records its start. */
  home?: Vec3
  /** Active plan for this order, if any. */
  plan?: PlanInstance
  /** Active order verb; lets safety reflex know when combat was authorized. */
  orderVerb?: string
  /** Active order params; gives the reflex the explicitly named target. */
  orderParams?: Record<string, JsonValue>
  /** Explicit hazard permission from the active order. */
  hazards?: HazardPolicy
  /** Agent-authored conflict policy for the active order. */
  conflictPolicy?: ConflictPolicy
  /** Material policy for the active order; default is require-all. */
  materialPolicy?: MaterialPolicy
  /** Gather jobs started for this plan (auto-gather budget accounting). */
  gatherCount?: number
  /** Work keys the tracker has blocked after repeated failures. */
  isBlocked?: (key: string) => boolean
}

export interface WorkGiver {
  id: string
  score?(ctx: EvalCtx, world: WorldView): number
  find(ctx: EvalCtx, world: WorldView): WorkGiverResult
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
