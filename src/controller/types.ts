/**
 * P2Controller domain types (docs/runtime/P2CONTROLLER.md v2).
 *
 * This layer only depends on the provider-independent contracts: no provider,
 * no Mineflayer, no game types. A binding supplies a SensePort and an
 * ActuatorPort; everything below decides, but never touches the game directly.
 */

import type { JsonValue, P2Error } from '../contracts/types.ts'

export type SlotId = 'S0' | 'S1' | 'S2' | 'S3'

/** Monotonic control-authority generation. Never reused, never rewound. */
export type Generation = number

/** Observation scope (for example `world:<dimension>` or `mineflayer.position`). */
export type Scope = string

export type EvidenceId = string

/**
 * Conflict classes for the fixed matrix in §6. They are ordered: a lethal
 * hazard outranks bleeding/fire, which outranks being trapped. No weights.
 */
export type HazardClass = 'lethal' | 'bleeding-fire' | 'trapped'

export const HAZARD_RANK: Readonly<Record<HazardClass, number>> = Object.freeze({
  lethal: 0,
  'bleeding-fire': 1,
  trapped: 2,
})

export type LeaseState = 'none' | 'granted' | 'revoking' | 'released' | 'unknown'

/** The only token that authorises one action in the single control slot. */
export type LeaseGrant = {
  leaseId: string
  generation: Generation
  holder: string
}

export type ActionRequest = {
  /** Exact act artifact; the adapter resolves it, the controller never does. */
  act: string
  args: Record<string, JsonValue>
  /** Human-readable intent recorded in events and diagnostics. */
  intent: string
  slot: SlotId
  /** Stable strategy identity that owns the request (for example `S2:harvest`). */
  holder: string
  /** Strategy attempt that produced the request; results are matched by it. */
  attemptId?: string
}

export type ActionProgress = {
  step?: string
  fraction?: number
  detail?: JsonValue
}

export type ActionOutcome =
  | { status: 'running'; progress?: ActionProgress }
  | { status: 'succeeded'; result?: JsonValue }
  | { status: 'failed'; error: P2Error }
  | { status: 'cancelled'; reason?: string }

export type ActionHandle = {
  poll(): ActionOutcome
  stop(): void
}

/**
 * Release conclusion reported by the actuator. `released` is a proof, not a
 * request acknowledgement: the adapter must observe the control slot idle
 * before saying so.
 */
export type ReleaseReport =
  | { status: 'released' }
  | { status: 'stopping'; detail?: string }
  | { status: 'unconfirmed'; detail?: string }

/**
 * The single actuator seam. A fake implements it in tests; a binding adapts
 * the existing ActPort/op broker without the controller learning about it.
 */
export type ActuatorPort = {
  start(request: ActionRequest, grant: LeaseGrant): ActionHandle
  /** Ask the slot to stop; returns before release is proven. */
  stop(now: number): void
  /** Observe release proof for the slot. */
  release(now: number): ReleaseReport
}

export type HandoverPhase =
  | 'idle'
  | 'revoking'
  | 'stopping'
  | 'confirming'
  | 'granting'
  | 'starting'
  | 'active'
  | 'control-fault'

export type ControlFaultCode = 'STOP_TIMEOUT' | 'CONTROL_OUTCOME_UNKNOWN'

export type ControlFault = {
  code: ControlFaultCode
  phase: HandoverPhase
  at: number
  detail: string
}

export type HandoverEventKind =
  | 'requested'
  | 'queued'
  | 'revoked'
  | 'stop-requested'
  | 'release-pending'
  | 'release-confirmed'
  | 'granted'
  | 'started'
  | 'completed'
  | 'stale-result'
  | 'fault'
  | 'fault-cleared'

export type HandoverEvent = {
  at: number
  kind: HandoverEventKind
  generation: Generation
  holder?: string
  intent?: string
  detail?: string
}


