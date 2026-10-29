import type { BehaviorDefinition } from '../contracts/ir.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import { BehaviorExecutor } from './executor.ts'
import type { ExecutorStatus } from './executor.ts'
import type { IngressEvent } from './ingress.ts'
import type { ActPort, PolicyPort, QueryPort } from './node-runtime.ts'
import { StopControl, stopUnconfirmedError } from './stop-control.ts'
import type { StopState } from './stop-control.ts'

export type RunStatus = 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled'

export type ConfirmationRequest = {
  id: string
  runId: string
  owner: string
  question: string
  status: 'pending' | 'confirmed' | 'denied' | 'cancelled'
}

export type ConfirmInput = {
  runId: string
  confirmationId: string
  owner: string
  source: string
  decision: 'confirm' | 'deny'
  commandId: string
}

export type ConfirmResult = {
  outcome: 'confirmed' | 'denied' | 'alreadyDecided' | 'rejected'
  status: RunStatus
  error?: P2Error
}

export class RunError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RunError'
    this.code = code
  }
}

export type BehaviorRunOptions = {
  runId: string
  owner: string
  definition: BehaviorDefinition
  params: Record<string, JsonValue>
  query: QueryPort
  act: ActPort
  policy?: PolicyPort
}

/**
 * A behavior instance plus its external-confirmation gate. The executor owns
 * the tree; this wrapper owns the run identity and terminal decision.
 */
export class BehaviorRun {
  readonly runId: string
  readonly owner: string
  readonly definition: BehaviorDefinition
  private readonly executor: BehaviorExecutor
  private statusValue: RunStatus = 'running'
  private confirmationValue: ConfirmationRequest | undefined
  private decision: 'confirm' | 'deny' | undefined
  private readonly outcomes = new Map<string, ConfirmResult>()
  private stopRequested = false
  private readonly act: ActPort
  private readonly stopControl = new StopControl()
  private stopFailure: P2Error | undefined

  constructor(options: BehaviorRunOptions) {
    this.runId = options.runId
    this.owner = options.owner
    this.definition = options.definition
    this.act = options.act
    this.executor = new BehaviorExecutor({
      definition: options.definition,
      params: options.params,
      query: options.query,
      act: options.act,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    })
  }

  get status(): RunStatus {
    return this.statusValue
  }

  get error(): P2Error | undefined {
    return this.stopFailure ?? this.executor.currentError
  }

  get stopState(): StopState {
    return this.stopControl.state
  }

  get allowsTakeover(): boolean {
    return this.stopControl.allowsNewRun
  }

  get confirmation(): ConfirmationRequest | undefined {
    return this.confirmationValue
  }

  /** Diagnostic view: only the active act, the wait reason and the last failure. */
  describe(): { activeAct: string | null; activeNode: string | null; activeTarget: { x: number; z: number } | null; waiting: string | null; lastFailure: P2Error | undefined } {
    const report = this.executor.runtimeReport
    return {
      activeAct: report.act,
      activeNode: report.node,
      activeTarget: report.target,
      waiting: report.waiting,
      lastFailure: this.executor.lastFailure,
    }
  }

  tick(now = Date.now()): RunStatus {
    if (this.statusValue !== 'running' && this.statusValue !== 'blocked') return this.statusValue
    const control = this.stopControl.state
    if (control !== 'running' && control !== 'queued') {
      this.executor.tick(now)
      this.advanceStop(now)
      return this.statusValue
    }

    const status = this.executor.tick(now)
    if (status === 'blocked') {
      this.confirmationValue ??= {
        id: `confirm-${this.runId}`,
        runId: this.runId,
        owner: this.owner,
        question: this.definition.completion?.kind === 'externalConfirmation'
          ? this.definition.completion.description
          : 'confirm completion',
        status: 'pending',
      }
      this.statusValue = 'blocked'
      return this.statusValue
    }
    this.statusValue = status
    return this.statusValue
  }

  /** Stop intent is applied before the next tick; pending confirmation ends immediately. */
  stop(now = Date.now()): void {
    if (this.statusValue === 'succeeded' || this.statusValue === 'failed' || this.statusValue === 'cancelled') return
    if (this.confirmationValue?.status === 'pending') this.confirmationValue.status = 'cancelled'
    this.stopControl.requestStop()
    this.stopControl.accept(now)
    this.act.stopRun?.(now, this.runId)
    if (!this.stopRequested) {
      this.stopRequested = true
      this.executor.stop()
      // Run one cancellation pass now so a synchronous act stop happens before
      // the run is reported as stopped; asynchronous cleanup continues in tick.
      this.executor.tick(now)
    }
    this.advanceStop(now)
  }

  /** Process one fixed ingress batch: any accepted stop wins before decisions. */
  applyIngress(events: IngressEvent[]): { status: RunStatus; decisions: ConfirmResult[] } {
    const ordered = [...events].sort((left, right) => left.seq - right.seq)
    if (ordered.some(event => event.kind === 'stop')) this.stop()
    const decisions: ConfirmResult[] = []
    for (const event of ordered) {
      if (event.kind === 'confirm') decisions.push(this.confirm(event.input))
    }
    if (ordered.some(event => event.kind === 'stop')) this.tick()
    return { status: this.statusValue, decisions }
  }

  confirm(input: ConfirmInput): ConfirmResult {    const duplicate = this.outcomes.get(input.commandId)
    if (duplicate !== undefined) return duplicate

    const rejected = this.validateConfirmation(input)
    if (rejected !== undefined) {
      const result: ConfirmResult = { outcome: 'rejected', status: this.statusValue, error: rejected }
      this.outcomes.set(input.commandId, result)
      return result
    }

    if (this.statusValue === 'cancelled' || this.statusValue === 'succeeded' || this.statusValue === 'failed') {
      const result: ConfirmResult = {
        outcome: 'rejected',
        status: this.statusValue,
        error: p2Error('ALREADY_TERMINAL', 'validation', 'run is already terminal', { module: 'core.run' }),
      }
      this.outcomes.set(input.commandId, result)
      return result
    }

    if (this.stopRequested) {
      if (this.confirmationValue?.status === 'pending') this.confirmationValue.status = 'cancelled'
      const result: ConfirmResult = {
        outcome: 'rejected',
        status: this.statusValue,
        error: p2Error('RUN_CANCELLED', 'control', 'run is being cancelled', { module: 'core.run' }),
      }
      this.outcomes.set(input.commandId, result)
      return result
    }

    if (this.confirmationValue?.status !== 'pending') {
      const result: ConfirmResult = {
        outcome: 'rejected',
        status: this.statusValue,
        error: p2Error('NOT_AWAITING_CONFIRMATION', 'validation', 'run is not awaiting confirmation', { module: 'core.run' }),
      }
      this.outcomes.set(input.commandId, result)
      return result
    }
    if (this.decision !== undefined) {
      const result: ConfirmResult = {
        outcome: 'alreadyDecided',
        status: this.statusValue,
        error: p2Error('ALREADY_DECIDED', 'validation', 'confirmation was already decided', { module: 'core.run' }),
      }
      this.outcomes.set(input.commandId, result)
      return result
    }

    this.decision = input.decision
    this.outcomes.set(input.commandId, {
      outcome: input.decision === 'confirm' ? 'confirmed' : 'denied',
      status: input.decision === 'confirm' ? 'succeeded' : 'failed',
    })
    if (input.decision === 'confirm') {
      this.confirmationValue.status = 'confirmed'
      this.statusValue = 'succeeded'
      return this.outcomes.get(input.commandId) as ConfirmResult
    }
    this.confirmationValue.status = 'denied'
    this.statusValue = 'failed'
    return this.outcomes.get(input.commandId) as ConfirmResult
  }

  private advanceStop(now: number): void {
    const release = this.act.pollRelease?.(now) ?? 'released'
    const state = this.stopControl.observe(now, release)
    if (state === 'released') {
      // Release proof alone is not terminal: executor cleanup must finish too.
      if (this.stopRequested && this.executor.currentStatus === 'running') return
      const failure = this.executor.currentError
      if (failure !== undefined) {
        this.stopFailure = failure
        this.statusValue = 'failed'
      } else {
        this.statusValue = 'cancelled'
      }
      return
    }
    const failure = this.executor.currentError ?? stopUnconfirmedError(state)
    if (failure !== undefined) this.stopFailure = failure
  }

  private validateConfirmation(input: ConfirmInput): P2Error | undefined {
    if (input.runId !== this.runId) {
      return p2Error('RUN_NOT_FOUND', 'validation', 'confirmation targets a different run', { module: 'core.run' })
    }
    if (input.owner !== this.owner) {
      return p2Error('OWNER_MISMATCH', 'validation', 'confirmation owner does not match', { module: 'core.run' })
    }
    if (input.confirmationId !== this.confirmationValue?.id) {
      return p2Error('CONFIRMATION_MISMATCH', 'validation', 'confirmation id does not match', { module: 'core.run' })
    }
    if (typeof input.source !== 'string' || input.source.length === 0) {
      return p2Error('CONFIRMATION_SOURCE_REQUIRED', 'validation', 'confirmation source is required', { module: 'core.run' })
    }
    if (input.decision !== 'confirm' && input.decision !== 'deny') {
      return p2Error('INVALID_DECISION', 'validation', 'decision must be confirm or deny', { module: 'core.run' })
    }
    return undefined
  }
}

export type { ExecutorStatus }
