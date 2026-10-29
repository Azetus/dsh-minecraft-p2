import { p2Error } from '../contracts/protocol.ts'
import type { CleanupState, ControlHealth, SwitchState } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'
import type { ReleaseStatus } from './node-runtime.ts'

export type StopState = 'running' | 'queued' | 'accepted' | 'stopping' | 'released' | 'stop-unconfirmed'

export type StopTokens = {
  generation: number
  acceptedAt: number
  deadline: number
}

/** Classification for messages that arrive after the owning run changed control. */
export type MessageClass = 'current' | 'stale-control' | 'stale-result' | 'release-ack'

export type StopControlOptions = {
  stopTimeoutMs?: number
}

const DEFAULT_STOP_TIMEOUT_MS = 2000

/**
 * Run-level stop and control-authority state machine:
 * `running → queued → accepted → stopping → released | stop-unconfirmed`.
 *
 * `accepted` and revocation are one synchronous transition: the control entry
 * closes, the authority generation increments and the previous act instance is
 * invalidated. The deadline is established at that transition and repeated
 * stop/switch requests do not reset it. `stop-unconfirmed` is sticky until a
 * valid release observation arrives.
 */
export class StopControl {
  private readonly stopTimeoutMs: number
  private stateValue: StopState = 'running'
  private generationValue = 0
  private actInstance = ''
  private deadlineValue: number | undefined

  constructor(options: StopControlOptions = {}) {
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  }

  get state(): StopState {
    return this.stateValue
  }

  get generation(): number {
    return this.generationValue
  }

  get activeActInstanceId(): string {
    return this.actInstance
  }

  get deadline(): number | undefined {
    return this.deadlineValue
  }

  /** Only a run that has not begun stopping may submit new control work. */
  get controlOpen(): boolean {
    return this.stateValue === 'running' || this.stateValue === 'queued'
  }

  get allowsNewRun(): boolean {
    return this.stateValue === 'released'
  }

  /** Track the current act instance; a stale act id can no longer submit. */
  beginAct(actInstanceId: string): void {
    if (this.controlOpen) this.actInstance = actInstanceId
  }

  requestStop(): void {
    if (this.stateValue === 'running') this.stateValue = 'queued'
  }

  /** Apply revocation. Returns tokens once; later calls are no-ops. */
  accept(now: number): StopTokens | undefined {
    if (this.stateValue === 'running') this.stateValue = 'queued'
    if (this.stateValue !== 'queued') return undefined
    this.generationValue += 1
    this.actInstance = ''
    this.stateValue = 'accepted'
    this.deadlineValue ??= now + this.stopTimeoutMs
    return { generation: this.generationValue, acceptedAt: now, deadline: this.deadlineValue }
  }

  /** Fold a release observation into the state machine. */
  observe(now: number, release: ReleaseStatus): StopState {
    if (this.stateValue === 'released') return this.stateValue
    if (release === 'released') {
      this.stateValue = 'released'
      return this.stateValue
    }
    if (this.stateValue === 'accepted') this.stateValue = 'stopping'
    if (release === 'unconfirmed' || (this.deadlineValue !== undefined && now >= this.deadlineValue)) {
      this.stateValue = 'stop-unconfirmed'
    }
    return this.stateValue
  }

  classifyControl(generation: number, actInstanceId: string): MessageClass {
    if (!this.controlOpen) return 'stale-control'
    if (generation !== this.generationValue) return 'stale-control'
    if (actInstanceId !== this.actInstance) return 'stale-control'
    return 'current'
  }

  classifyResult(generation: number, actInstanceId: string): MessageClass {
    if (!this.controlOpen) return 'stale-result'
    if (generation !== this.generationValue) return 'stale-result'
    if (actInstanceId !== this.actInstance) return 'stale-result'
    return 'current'
  }

  /** Ledger confirmations may settle accounting but never grant new control. */
  classifyReleaseAck(): MessageClass {
    return 'release-ack'
  }
}

/** Error recorded while a run waits for (or fails to obtain) release proof. */
export function stopUnconfirmedError(state: StopState): P2Error | undefined {
  if (state !== 'stop-unconfirmed') return undefined
  return p2Error(
    'STOP_UNCONFIRMED',
    'timeout',
    'control release was not confirmed; new control work is not allowed',
    { module: 'core.stop-control' },
  )
}

export function cleanupStateOf(state: StopState): CleanupState {
  switch (state) {
    case 'accepted':
    case 'stopping':
      return 'running'
    case 'released':
      return 'released'
    case 'stop-unconfirmed':
      return 'unconfirmed'
    default:
      return 'none'
  }
}

export function controlHealthOf(state: StopState): ControlHealth {
  return state === 'stop-unconfirmed' ? 'unknown' : 'ok'
}

export function switchStateOf(state: StopState): SwitchState {
  switch (state) {
    case 'queued':
      return 'queued'
    case 'accepted':
    case 'stopping':
      return 'stopping'
    case 'released':
      return 'released'
    case 'stop-unconfirmed':
      return 'unconfirmed'
    default:
      return 'none'
  }
}
