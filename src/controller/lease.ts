/**
 * Action lease and handover state machine (P2CONTROLLER §3.1, C1).
 *
 * Invariants enforced here, not by convention:
 * - no action starts without a granted lease (`startAction` refuses otherwise);
 * - the slot is handed over in one order only: revoke → stop → confirm release
 *   → grant → start, and a timeout on any step becomes `control-fault`, never a
 *   silent wait;
 * - a late result keeps the generation it was produced under, so it can be
 *   accounted for but can never acquire new control.
 *
 * The machine owns no clock and no game access: `now` is injected and the
 * adapter implements the ActuatorPort.
 */

import { p2Error } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'
import type {
  ActionHandle,
  ActionOutcome,
  ActionRequest,
  ActuatorPort,
  ControlFault,
  ControlFaultCode,
  Generation,
  HandoverEvent,
  HandoverEventKind,
  HandoverPhase,
  LeaseGrant,
  LeaseState,
  ReleaseReport,
} from './types.ts'

export type LeaseMachineOptions = {
  actuator: ActuatorPort
  now?: () => number
  /** Total handover deadline measured from the revoke, not reset by retries. */
  stopTimeoutMs?: number
  /** Bounded event log; old entries are dropped, never used for control. */
  maxEvents?: number
  onEvent?: (event: HandoverEvent) => void
}

export type HandoverRequestResult = {
  outcome: 'started' | 'queued' | 'rejected'
  grant?: LeaseGrant
  fault?: ControlFault
}

export type HandoverTickResult = {
  phase: HandoverPhase
  leaseState: LeaseState
  started?: LeaseGrant
  completed?: { grant: LeaseGrant; outcome: ActionOutcome }
  fault?: ControlFault
  faultCleared: boolean
}

export type ResultClassification = 'current' | 'stale'

const DEFAULT_STOP_TIMEOUT_MS = 2000
const DEFAULT_MAX_EVENTS = 64

export class ActionLeaseMachine {
  private readonly actuator: ActuatorPort
  private readonly now: () => number
  private readonly stopTimeoutMs: number
  private readonly maxEvents: number
  private readonly onEvent: ((event: HandoverEvent) => void) | undefined
  private phaseValue: HandoverPhase = 'idle'
  private leaseStateValue: LeaseState = 'none'
  private generationValue: Generation = 0
  private leaseValue: LeaseGrant | undefined
  private handleValue: ActionHandle | undefined
  private requestValue: ActionRequest | undefined
  private pendingValue: ActionRequest | undefined
  private deadlineValue: number | undefined
  private faultValue: ControlFault | undefined
  private sequence = 0
  private readonly events: HandoverEvent[] = []

  constructor(options: LeaseMachineOptions) {
    this.actuator = options.actuator
    this.now = options.now ?? Date.now
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.onEvent = options.onEvent
  }

  get phase(): HandoverPhase {
    return this.phaseValue
  }

  get leaseState(): LeaseState {
    return this.leaseStateValue
  }

  get generation(): Generation {
    return this.generationValue
  }

  get grant(): LeaseGrant | undefined {
    return this.leaseValue
  }

  get currentRequest(): ActionRequest | undefined {
    return this.requestValue
  }

  get pendingRequest(): ActionRequest | undefined {
    return this.pendingValue
  }

  get controlFault(): ControlFault | undefined {
    return this.faultValue
  }

  /** True only while one granted action may legitimately receive control. */
  get controlOpen(): boolean {
    return this.phaseValue === 'active' && this.leaseStateValue === 'granted' && this.leaseValue !== undefined
  }

  get deadline(): number | undefined {
    return this.deadlineValue
  }

  /** Bounded diagnostic history; never a control input. */
  get eventLog(): readonly HandoverEvent[] {
    return this.events
  }

  /**
   * Ask for a new action. With no active action the lease is granted and the
   * action starts; with an active action the request is queued and the current
   * slot is revoked and stopped first.
   */
  request(request: ActionRequest, at = this.now()): HandoverRequestResult {
    if (this.faultValue !== undefined) {
      return { outcome: 'rejected', fault: this.faultValue }
    }
    if (this.phaseValue === 'idle') {
      // A fresh acquisition is a new authority generation.
      this.generationValue += 1
      return this.grantAndStart(request, at)
    }
    // Stopping or starting: keep only the newest wish, never reset the deadline.
    this.pendingValue = request
    this.record('queued', at, request, `queued while ${this.phaseValue}`)
    if (this.phaseValue === 'active') this.revoke(at, 'preempt')
    return { outcome: 'queued' }
  }

  /** Revoke the current action without starting another one. */
  cancel(at = this.now()): void {
    if (this.phaseValue !== 'active') return
    this.revoke(at, 'cancel')
  }

  /**
   * Advance release/start progress. A terminal action outcome is returned once
   * for the generation that owned it; a late result is only classified.
   */
  tick(at = this.now()): HandoverTickResult {
    if (this.phaseValue === 'active') return this.tickActive(at)
    if (this.phaseValue === 'revoking' || this.phaseValue === 'stopping' || this.phaseValue === 'confirming') {
      return this.advanceHandover(at)
    }
    if (this.phaseValue === 'control-fault') return this.pollFault(at)
    return this.result({ faultCleared: false })
  }

  /**
   * Start (or fail) the single action under an explicit grant. The controller
   * always goes through this method, so "no lease, no dispatch" is structural.
   */
  startAction(grant: LeaseGrant, request: ActionRequest): ActionHandle {
    if (this.leaseValue === undefined || this.leaseStateValue !== 'granted' || this.phaseValue !== 'active') {
      throw p2Error(
        'LEASE_REQUIRED',
        'control',
        'action dispatch requires a granted lease',
        { module: 'controller.lease' },
        { intent: request.intent, holder: request.holder },
      )
    }
    if (grant.generation !== this.leaseValue.generation || grant.leaseId !== this.leaseValue.leaseId) {
      throw p2Error(
        'STALE_CONTROLLER',
        'control',
        'lease grant does not match the current control generation',
        { module: 'controller.lease' },
        { generation: grant.generation, current: this.generationValue },
      )
    }
    if (this.handleValue !== undefined) {
      throw p2Error(
        'STALE_CONTROLLER',
        'control',
        'the single action slot already has a handle',
        { module: 'controller.lease' },
        { intent: request.intent },
      )
    }
    const handle = this.actuator.start(request, grant)
    this.handleValue = handle
    return handle
  }

  /**
   * Classify a result that arrived from a possibly old generation. A stale
   * result is recorded for accounting and can never acquire control.
   */
  classifyResult(generation: Generation, at = this.now()): ResultClassification {
    if (this.leaseValue !== undefined && generation === this.leaseValue.generation && this.phaseValue === 'active') {
      return 'current'
    }
    this.record('stale-result', at, undefined, `result from generation ${generation} fenced at ${this.generationValue}`)
    return 'stale'
  }

  /** True when the grant still names the current authority generation. */
  isCurrentGrant(grant: LeaseGrant | undefined): boolean {
    return grant !== undefined
      && this.leaseValue !== undefined
      && grant.generation === this.generationValue
      && grant.leaseId === this.leaseValue.leaseId
  }

  /** True when a dispatch right now would be legal under the current lease. */
  canStart(grant: LeaseGrant | undefined): boolean {
    return this.isCurrentGrant(grant) && this.handleValue === undefined && this.controlOpen
  }

  /** Best-effort release for shutdown; never throws and never reports success. */
  dispose(at = this.now()): void {
    if (this.handleValue !== undefined) {
      try { this.handleValue.stop() } catch { /* release stays unconfirmed */ }
      this.handleValue = undefined
    }
    try { this.actuator.stop(at) } catch { /* best effort */ }
    this.leaseValue = undefined
    this.pendingValue = undefined
    this.requestValue = undefined
    this.phaseValue = 'idle'
    this.leaseStateValue = 'unknown'
  }

  private tickActive(at: number): HandoverTickResult {
    const handle = this.handleValue
    const grant = this.leaseValue
    if (handle === undefined || grant === undefined) {
      return this.result({ faultCleared: false })
    }
    let outcome: ActionOutcome
    try {
      outcome = handle.poll()
    } catch (error) {
      this.enterFault('CONTROL_OUTCOME_UNKNOWN', at, `polling the action failed: ${messageOf(error)}`)
      return this.result({ faultCleared: false })
    }
    if (outcome.status === 'running') return this.result({ faultCleared: false })

    // Terminal: the slot is released only after the action stopped itself.
    this.handleValue = undefined
    this.leaseValue = undefined
    this.requestValue = undefined
    this.leaseStateValue = 'released'
    this.phaseValue = 'idle'
    this.deadlineValue = undefined
    this.record('completed', at, undefined, `action ended ${outcome.status} under generation ${grant.generation}`)
    return this.result({ completed: { grant, outcome }, faultCleared: false })
  }

  private advanceHandover(at: number): HandoverTickResult {
    const report = this.observeRelease(at)
    if (report.status === 'unconfirmed') {
      this.enterFault('CONTROL_OUTCOME_UNKNOWN', at, report.detail ?? 'actuator cannot confirm release')
      return this.result({ faultCleared: false })
    }
    if (report.status !== 'released') {
      this.phaseValue = 'confirming'
      if (this.deadlineValue !== undefined && at >= this.deadlineValue) {
        this.enterFault('STOP_TIMEOUT', at, `release was not confirmed within ${this.stopTimeoutMs}ms`)
        return this.result({ faultCleared: false })
      }
      this.record('release-pending', at, undefined, report.detail)
      return this.result({ faultCleared: false })
    }

    this.phaseValue = 'granting'
    this.leaseStateValue = 'released'
    this.record('release-confirmed', at, undefined)
    const next = this.pendingValue
    this.pendingValue = undefined
    this.deadlineValue = undefined
    if (next === undefined) {
      this.phaseValue = 'idle'
      return this.result({ faultCleared: false })
    }
    const started = this.grantAndStart(next, at)
    if (started.outcome !== 'started' || started.grant === undefined) {
      return this.result({ faultCleared: false })
    }
    return this.result({ started: started.grant, faultCleared: false })
  }

  private pollFault(at: number): HandoverTickResult {
    const report = this.observeRelease(at)
    if (report.status !== 'released') {
      return this.result({ faultCleared: false })
    }
    // Confirmed release clears the fault, but a queued wish is discarded: the
    // owner has to request again with a fresh observation, never auto-restart.
    this.faultValue = undefined
    this.pendingValue = undefined
    this.deadlineValue = undefined
    this.leaseStateValue = 'released'
    this.phaseValue = 'idle'
    this.record('fault-cleared', at, undefined)
    return this.result({ faultCleared: true })
  }

  private grantAndStart(request: ActionRequest, at: number): HandoverRequestResult {
    const grant: LeaseGrant = {
      leaseId: `lease-${++this.sequence}`,
      generation: this.generationValue,
      holder: request.holder,
    }
    this.leaseValue = grant
    this.requestValue = request
    this.leaseStateValue = 'granted'
    this.phaseValue = 'active'
    this.handleValue = undefined
    this.deadlineValue = undefined
    this.record('granted', at, request, `granted generation ${grant.generation}`)
    try {
      this.startAction(grant, request)
    } catch (error) {
      // A start that threw may still have reached the game: treat control as
      // unknown, stop the slot and require release proof before anything else.
      this.enterFault('CONTROL_OUTCOME_UNKNOWN', at, `start failed: ${messageOf(error)}`)
      return {
        outcome: 'rejected',
        ...(this.faultValue === undefined ? {} : { fault: this.faultValue }),
      }
    }
    this.record('started', at, request)
    return { outcome: 'started', grant }
  }

  private revoke(at: number, reason: string): void {
    const request = this.requestValue
    // The authority generation changes here, so results stamped with the old
    // generation are strictly older than the current value from now on.
    this.generationValue += 1
    this.leaseStateValue = 'revoking'
    this.phaseValue = 'revoking'
    this.record('revoked', at, request, reason)
    const handle = this.handleValue
    this.handleValue = undefined
    this.leaseValue = undefined
    this.requestValue = undefined
    if (handle !== undefined) {
      try { handle.stop() } catch (error) {
        this.enterFault('CONTROL_OUTCOME_UNKNOWN', at, `action stop failed: ${messageOf(error)}`)
        return
      }
    }
    this.phaseValue = 'stopping'
    this.deadlineValue ??= at + this.stopTimeoutMs
    try {
      this.actuator.stop(at)
    } catch (error) {
      this.enterFault('CONTROL_OUTCOME_UNKNOWN', at, `actuator stop failed: ${messageOf(error)}`)
      return
    }
    this.record('stop-requested', at, undefined)
  }

  private observeRelease(at: number): ReleaseReport {
    try {
      return this.actuator.release(at)
    } catch (error) {
      return { status: 'unconfirmed', detail: `release observation failed: ${messageOf(error)}` }
    }
  }

  private enterFault(code: ControlFaultCode, at: number, detail: string): void {
    const fault: ControlFault = { code, phase: this.phaseValue, at, detail }
    this.faultValue = fault
    this.phaseValue = 'control-fault'
    this.leaseStateValue = 'unknown'
    this.leaseValue = undefined
    this.handleValue = undefined
    this.requestValue = undefined
    this.pendingValue = undefined
    this.record('fault', at, undefined, `${code}: ${detail}`)
  }

  private result(extra: {
    started?: LeaseGrant
    completed?: { grant: LeaseGrant; outcome: ActionOutcome }
    faultCleared: boolean
  }): HandoverTickResult {
    return {
      phase: this.phaseValue,
      leaseState: this.leaseStateValue,
      faultCleared: extra.faultCleared,
      ...(extra.started === undefined ? {} : { started: extra.started }),
      ...(extra.completed === undefined ? {} : { completed: extra.completed }),
      ...(this.faultValue === undefined ? {} : { fault: this.faultValue }),
    }
  }

  private record(
    kind: HandoverEventKind,
    at: number,
    request?: ActionRequest,
    detail?: string,
  ): void {
    const event: HandoverEvent = {
      at,
      kind,
      generation: this.generationValue,
      ...(request === undefined ? {} : { holder: request.holder, intent: request.intent }),
      ...(detail === undefined ? {} : { detail }),
    }
    this.events.push(event)
    if (this.events.length > this.maxEvents) this.events.shift()
    this.onEvent?.(event)
  }
}

/** Stable error surface for a sticky control fault. */
export function controlFaultError(fault: ControlFault): P2Error {
  return p2Error(
    fault.code,
    'control',
    fault.detail,
    { module: 'controller.lease' },
    { phase: fault.phase, since: fault.at },
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
