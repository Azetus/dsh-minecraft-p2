import { p2Error } from '../contracts/protocol.ts'
import type { BehaviorArtifact } from '../contracts/ir.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import type { CurrentStep, RunObservation } from '../contracts/protocol.ts'
import type { ActHandle, ActPoll, ActPort, PolicyOutcome, PolicyPort, QueryOutcome, QueryPort } from './node-runtime.ts'
import type { RunStatus } from './run.ts'
import { StopControl, cleanupStateOf, controlHealthOf, stopUnconfirmedError, switchStateOf } from './stop-control.ts'
import type { StopState } from './stop-control.ts'
import { LocalBehaviorDriver } from './behavior-driver.ts'
import type { BehaviorDriver, DriverIdentity, DriverResume, DriverStep } from './behavior-driver.ts'

type JsCommand =
  | { type: 'query'; op: string; args: Record<string, JsonValue> }
  | { type: 'act'; ref: ArtifactRefLike; args: Record<string, JsonValue> }
  | { type: 'decide'; ref: ArtifactRefLike; inputs: Record<string, JsonValue> }
  | { type: 'wait'; durationMs: number }
  | { type: 'progress'; value: JsonValue }
  | { type: 'log'; message: string }

type ArtifactRefLike = { definitionId: string; artifactId?: string }

type ResumeSlot = { value: unknown; thrown: boolean }

type Pending =
  | { kind: 'query'; poll: () => QueryOutcome }
  | { kind: 'policy'; poll: () => PolicyOutcome }
  | { kind: 'act'; handle: ActHandle }

export type JsBehaviorRunOptions = {
  runId: string
  owner: string
  artifact: BehaviorArtifact
  params: Record<string, JsonValue>
  query: QueryPort
  act: ActPort
  policy?: PolicyPort
  /** Exact act/policy artifacts declared by the checked manifest; omitted means unrestricted. */
  allowedActs?: ReadonlySet<string>
  allowedPolicies?: ReadonlySet<string>
  resolveAct: (definitionId: string) => string | undefined
  resolvePolicy: (definitionId: string) => string | undefined
  /** Sandbox driver; omitted runs the generator in-process for tests. */
  driver?: BehaviorDriver
}

const STEP_BUDGET = 100
const MAX_PROGRESS_BYTES = 4 * 1024
const MAX_LOG_MESSAGE_BYTES = 4 * 1024
const MAX_EVIDENCE_BYTES = 16 * 1024
const LOG_BUFFER_BYTES = 256 * 1024

/**
 * JS behavior scheduler. The generator itself runs in a BehaviorDriver (the
 * sandbox runner in production); this class owns the tick budget, command
 * dispatch, observation, cancellation and release gating.
 */
export class JsBehaviorRun {
  readonly runId: string
  readonly owner: string
  readonly definition: BehaviorArtifact['definition']
  private readonly options: JsBehaviorRunOptions
  private readonly driver: BehaviorDriver
  private ready = false
  private stepInFlight = false
  private cleanupPending = false
  private budget = 0
  private resumeSlot: ResumeSlot | undefined
  private statusValue: RunStatus = 'running'
  private pending: Pending | undefined
  private waitUntil: number | undefined
  private clock = 0
  private currentError: P2Error | undefined
  private currentStep: CurrentStep | null = null
  private stepCount = 0
  private activeAct: string | null = null
  private activeTarget: { x: number; z: number } | null = null
  private progressValue: JsonValue | undefined
  private evidenceValue: JsonValue | undefined
  private readonly logEntries: string[] = []
  private logBytes = 0
  private logDropped = 0
  private readonly stopControl = new StopControl()
  private actSequence = 0

  constructor(options: JsBehaviorRunOptions) {
    this.runId = options.runId
    this.owner = options.owner
    this.definition = options.artifact.definition
    this.options = options
    this.driver = options.driver ?? new LocalBehaviorDriver(options.artifact.code ?? '', options.params, options.runId)
    this.begin()
  }

  get status(): RunStatus {
    return this.statusValue
  }

  get error(): P2Error | undefined {
    return this.currentError
  }

  get stopState(): StopState {
    return this.stopControl.state
  }

  get allowsTakeover(): boolean {
    return this.stopControl.allowsNewRun
  }

  get confirmation(): undefined {
    return undefined
  }

  describe(): { activeAct: string | null; activeNode: string | null; activeTarget: { x: number; z: number } | null; waiting: string | null; lastFailure: P2Error | undefined } {
    return {
      activeAct: this.activeAct,
      activeNode: this.currentStep?.summary ?? null,
      activeTarget: this.activeTarget,
      waiting: this.pending === undefined ? (this.waitUntil === undefined ? null : 'wait') : this.pending.kind,
      lastFailure: this.currentError,
    }
  }

  observation(): RunObservation {
    const state = this.stopControl.state
    return {
      currentStep: this.currentStep,
      stepCount: this.stepCount,
      progress: this.progressValue ?? null,
      lastError: this.currentError ?? null,
      cleanupState: cleanupStateOf(state),
      controlHealth: controlHealthOf(state),
      switchState: switchStateOf(state),
      logCount: this.logEntries.length,
      logDropped: this.logDropped,
      ...(this.evidenceValue === undefined ? {} : { evidence: this.evidenceValue }),
    }
  }

  confirm(_input?: unknown): { outcome: 'rejected'; status: RunStatus; error?: P2Error } {
    return {
      outcome: 'rejected',
      status: this.statusValue,
      error: p2Error('CONFIRMATION_UNSUPPORTED', 'validation', 'JS behaviors do not use external confirmation', { module: 'core.js-run' }),
    }
  }

  /** The runner exited; a live run fails, a stopping run records the cleanup fault. */
  runnerExited(message: string): void {
    if (this.isTerminal()) return
    const error = p2Error('RUNNER_EXITED', 'runtime', message, { module: 'core.js-run' })
    if (this.stopControl.controlOpen) {
      this.fail(error)
      return
    }
    this.currentError = error
    this.advanceStop(this.clock)
  }

  stop(now = Date.now()): void {
    if (this.isTerminal()) return
    this.stopControl.requestStop()
    const tokens = this.stopControl.accept(now)
    if (tokens !== undefined) {
      if (this.pending?.kind === 'act') {
        try { this.pending.handle.stop() } catch {}
      }
      this.pending = undefined
      this.resumeSlot = undefined
      this.waitUntil = undefined
      this.options.act.stopRun?.(now, this.runId)
      this.beginCleanup()
    } else {
      this.options.act.stopRun?.(now, this.runId)
    }
    this.advanceStop(now)
  }

  tick(now = Date.now()): RunStatus {
    if (this.isTerminal()) return this.statusValue
    const control = this.stopControl.state
    if (control !== 'running' && control !== 'queued') {
      this.advanceStop(now)
      return this.statusValue
    }
    if (!this.ready) return this.statusValue
    this.clock = now
    this.budget = STEP_BUDGET
    this.pump()
    return this.statusValue
  }

  private begin(): void {
    let started: void | Promise<void>
    try {
      started = this.driver.start(this.options.params)
    } catch (error) {
      this.fail(toP2Error(error, 'init'))
      return
    }
    if (!isPromise(started)) {
      this.ready = true
      this.resumeSlot = { value: undefined, thrown: false }
      return
    }
    void started.then(() => {
      if (this.isTerminal()) return
      this.ready = true
      this.resumeSlot = { value: undefined, thrown: false }
    }).catch((error: unknown) => {
      if (this.isTerminal()) return
      this.fail(toP2Error(error, 'init'))
    })
  }

  private pump(): void {
    while (!this.isTerminal()) {
      if (this.stepInFlight) return
      if (this.pending !== undefined) {
        if (!this.pollPending()) return
      }
      if (this.waitUntil !== undefined) {
        if (this.clock < this.waitUntil) return
        this.waitUntil = undefined
        this.resumeSlot = { value: undefined, thrown: false }
      }
      const slot = this.resumeSlot
      if (slot === undefined) return
      if (this.budget <= 0) return
      this.budget -= 1
      this.resumeSlot = undefined
      this.stepCount += 1
      const identity: DriverIdentity = { runId: this.runId, generation: this.stopControl.generation }
      let result: DriverStep | Promise<DriverStep>
      try {
        result = this.driver.resume(slot, identity)
      } catch (error) {
        this.handleDriverError(error)
        return
      }
      if (isPromise(result)) {
        this.stepInFlight = true
        void result.then(step => {
          this.stepInFlight = false
          if (this.isTerminal()) return
          this.applyDriverStep(step)
          if (!this.isTerminal()) this.pump()
        }).catch((error: unknown) => {
          this.stepInFlight = false
          if (this.isTerminal()) return
          this.handleDriverError(error)
        })
        return
      }
      this.applyDriverStep(result)
      if (this.pending !== undefined || this.waitUntil !== undefined) return
    }
  }

  private applyDriverStep(step: DriverStep): void {
    if (step.kind === 'done') {
      this.finishRun(step.value)
      return
    }
    this.dispatch(step.command)
  }

  private handleDriverError(error: unknown): void {
    if (!this.stopControl.controlOpen) {
      // A late step result after revocation cannot resume the generator.
      const converted = toP2Error(error, 'step')
      if (converted.code !== 'STALE_BEHAVIOR') this.currentError = converted
      return
    }
    this.fail(toP2Error(error, 'step'))
  }

  private beginCleanup(): void {
    const identity: DriverIdentity = { runId: this.runId, generation: this.stopControl.generation }
    let result: { yielded: boolean } | Promise<{ yielded: boolean }>
    try {
      result = this.driver.stop(identity)
    } catch (error) {
      this.currentError = toP2Error(error, 'cleanup')
      return
    }
    if (!isPromise(result)) {
      if (result.yielded) {
        this.currentError = p2Error('BEHAVIOR_CLEANUP_ERROR', 'runtime', 'behavior yielded while running finally after cancellation', { module: 'core.js-run' }, { phase: 'cleanup' })
      }
      return
    }
    this.cleanupPending = true
    void result.then(value => {
      this.cleanupPending = false
      if (value.yielded) {
        this.currentError = p2Error('BEHAVIOR_CLEANUP_ERROR', 'runtime', 'behavior yielded while running finally after cancellation', { module: 'core.js-run' }, { phase: 'cleanup' })
      }
      if (!this.isTerminal()) this.advanceStop(this.clock)
    }).catch((error: unknown) => {
      this.cleanupPending = false
      this.currentError = toP2Error(error, 'cleanup')
      if (!this.isTerminal()) this.advanceStop(this.clock)
    })
  }

  private advanceStop(now: number): void {
    const release = this.options.act.pollRelease?.(now) ?? 'released'
    const state = this.stopControl.observe(now, release)
    if (state === 'released') {
      if (this.cleanupPending) return
      this.statusValue = 'cancelled'
      this.currentStep = null
      return
    }
    const failure = stopUnconfirmedError(state)
    if (failure !== undefined) this.currentError = failure
  }

  private finishRun(value: unknown): void {
    if (!isRecord(value)) {
      this.fail(invalidReturn('run ended without return ctx.succeed/ctx.fail'))
      return
    }
    if (value.type === 'succeed') {
      const evidence = value.evidence
      if (evidence !== undefined) {
        const error = boundedJsonError(evidence, MAX_EVIDENCE_BYTES, 'evidence')
        if (error !== undefined) {
          this.fail(error)
          return
        }
        this.evidenceValue = evidence as JsonValue
      }
      this.currentStep = null
      this.statusValue = 'succeeded'
      return
    }
    if (value.type === 'fail') {
      const code = value.code
      const message = value.message
      if (typeof code !== 'string' || code.length === 0 || typeof message !== 'string') {
        this.fail(invalidReturn('return ctx.fail(code, message) requires a code and a message'))
        return
      }
      this.fail(p2Error(code, 'runtime', message, { module: 'core.js-run' }, { phase: 'return' }))
      return
    }
    this.fail(invalidReturn('run returned a value that is not ctx.succeed/ctx.fail'))
  }

  private dispatch(value: unknown): void {
    if (!isRecord(value)) {
      this.fail(invalidCommand('yielded value must be a ctx command object'))
      return
    }
    switch (value.type) {
      case 'query': {
        const op = value.op
        if (typeof op !== 'string' || op.length === 0) {
          this.fail(invalidCommand('query command requires a non-empty op'))
          return
        }
        if (!isRecord(value.args)) {
          this.fail(invalidCommand('query command requires an args object'))
          return
        }
        this.setStep('query', `query:${op}`, null, op)
        const outcome = this.options.query({ op, args: {} }, value.args as Record<string, JsonValue>)
        this.completeQuery(outcome)
        return
      }
      case 'act': {
        const ref = parseRef(value.ref)
        if (ref === undefined) {
          this.fail(invalidCommand('act command requires a ref string or { definitionId, artifactId }'))
          return
        }
        if (!isRecord(value.args)) {
          this.fail(invalidCommand('act command requires an args object'))
          return
        }
        const artifactId = ref.artifactId ?? this.options.resolveAct(ref.definitionId)
        if (artifactId === undefined) {
          this.resumeSlot = {
            value: p2Error('ACT_REF_UNRESOLVED', 'validation', `act ${ref.definitionId} is not active`, { module: 'core.js-run' }),
            thrown: true,
          }
          return
        }
        if (this.options.allowedActs !== undefined && !this.options.allowedActs.has(artifactId)) {
          this.resumeSlot = {
            value: p2Error(
              'DEPENDENCY_NOT_DECLARED',
              'validation',
              `act ${ref.definitionId} is not in the behavior's declared dependencies`,
              { module: 'core.js-run' },
            ),
            thrown: true,
          }
          return
        }
        this.setStep('act', `act:${ref.definitionId}`, ref.definitionId, null)
        this.activeAct = ref.definitionId
        const x = value.args.x
        const z = value.args.z
        this.activeTarget = typeof x === 'number' && typeof z === 'number' ? { x, z } : null
        const actInstanceId = `${this.runId}:act:${this.stopControl.generation}:${++this.actSequence}`
        this.stopControl.beginAct(actInstanceId)
        try {
          this.pending = {
            kind: 'act',
            handle: this.options.act.start(
              { definitionId: ref.definitionId, artifactId },
              value.args as Record<string, JsonValue>,
              { runId: this.runId, actInstanceId, generation: this.stopControl.generation },
            ),
          }
        } catch (error) {
          this.resumeSlot = { value: error, thrown: true }
        }
        return
      }
      case 'decide': {
        const ref = parseRef(value.ref)
        if (ref === undefined) {
          this.fail(invalidCommand('decide command requires a ref string or { definitionId, artifactId }'))
          return
        }
        if (!isRecord(value.inputs)) {
          this.fail(invalidCommand('decide command requires an inputs object'))
          return
        }
        if (this.options.policy === undefined) {
          this.resumeSlot = {
            value: p2Error('POLICY_UNAVAILABLE', 'runtime', 'no policy port is connected', { module: 'core.js-run' }),
            thrown: true,
          }
          return
        }
        const artifactId = ref.artifactId ?? this.options.resolvePolicy(ref.definitionId)
        if (artifactId === undefined) {
          this.resumeSlot = {
            value: p2Error('POLICY_REF_UNRESOLVED', 'validation', `policy ${ref.definitionId} is not checked`, { module: 'core.js-run' }),
            thrown: true,
          }
          return
        }
        if (this.options.allowedPolicies !== undefined && !this.options.allowedPolicies.has(artifactId)) {
          this.resumeSlot = {
            value: p2Error(
              'DEPENDENCY_NOT_DECLARED',
              'validation',
              `policy ${ref.definitionId} is not in the behavior's declared dependencies`,
              { module: 'core.js-run' },
            ),
            thrown: true,
          }
          return
        }
        this.setStep('decide', `decide:${ref.definitionId}`, ref.definitionId, null)
        const outcome = this.options.policy.call({ definitionId: ref.definitionId, artifactId }, value.inputs as Record<string, JsonValue>)
        this.completePolicy(outcome)
        return
      }
      case 'wait': {
        const durationMs = value.durationMs
        if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
          this.fail(invalidCommand('wait command requires a finite durationMs'))
          return
        }
        this.setStep('wait', `wait ${Math.max(0, durationMs)}`)
        this.waitUntil = this.clock + Math.max(0, durationMs)
        return
      }
      case 'progress': {
        if (!('value' in value)) {
          this.fail(invalidCommand('progress command requires a value'))
          return
        }
        const error = boundedJsonError(value.value, MAX_PROGRESS_BYTES, 'progress')
        if (error !== undefined) {
          this.fail(error)
          return
        }
        this.progressValue = value.value as JsonValue
        this.setStep('progress', 'progress')
        this.resumeSlot = { value: undefined, thrown: false }
        return
      }
      case 'log': {
        if (typeof value.message !== 'string') {
          this.fail(invalidCommand('log command requires a message string'))
          return
        }
        const error = boundedJsonError(value.message, MAX_LOG_MESSAGE_BYTES, 'log message')
        if (error !== undefined) {
          this.fail(error)
          return
        }
        this.appendLog(value.message)
        this.setStep('log', 'log')
        this.resumeSlot = { value: undefined, thrown: false }
        return
      }
      case 'succeed':
      case 'fail':
        this.fail(invalidCommand(`${String(value.type)} must be returned, not yielded`))
        return
      default:
        this.fail(invalidCommand('yielded value has an unknown command type'))
    }
  }

  private setStep(kind: CurrentStep['kind'], summary: string, ref: string | null = null, op: string | null = null): void {
    this.currentStep = { kind, ref, op, summary }
  }

  private appendLog(message: string): void {
    const bytes = Buffer.byteLength(message, 'utf8')
    if (bytes > LOG_BUFFER_BYTES) {
      this.logDropped += 1
      return
    }
    while (this.logBytes + bytes > LOG_BUFFER_BYTES && this.logEntries.length > 0) {
      const removed = this.logEntries.shift()
      if (removed === undefined) break
      this.logBytes -= Buffer.byteLength(removed, 'utf8')
      this.logDropped += 1
    }
    this.logEntries.push(message)
    this.logBytes += bytes
  }

  private completeQuery(outcome: QueryOutcome): void {
    if (outcome.status === 'pending') {
      this.pending = { kind: 'query', poll: outcome.poll }
    } else if (outcome.status === 'ok') {
      this.resumeSlot = { value: { value: outcome.value, meta: outcome.meta }, thrown: false }
    } else {
      this.resumeSlot = { value: outcome.error, thrown: true }
    }
  }

  private completePolicy(outcome: PolicyOutcome): void {
    if (outcome.status === 'pending') {
      this.pending = { kind: 'policy', poll: outcome.poll }
    } else if (outcome.status === 'ok') {
      this.resumeSlot = { value: outcome.value, thrown: false }
    } else {
      this.resumeSlot = { value: outcome.error, thrown: true }
    }
  }

  private pollPending(): boolean {
    const pending = this.pending
    if (pending === undefined) return true
    if (pending.kind === 'query') {
      const outcome = pending.poll()
      if (outcome.status === 'pending') return false
      this.pending = undefined
      this.completeQuery(outcome)
      return true
    }
    if (pending.kind === 'policy') {
      const outcome = pending.poll()
      if (outcome.status === 'pending') return false
      this.pending = undefined
      this.completePolicy(outcome)
      return true
    }
    const outcome: ActPoll = pending.handle.poll()
    if (outcome.status === 'running') return false
    this.pending = undefined
    this.activeAct = null
    this.activeTarget = null
    if (outcome.status === 'succeeded') {
      this.resumeSlot = { value: { value: outcome.result, meta: outcome.meta }, thrown: false }
    } else if (outcome.status === 'failed') {
      this.resumeSlot = { value: outcome.error, thrown: true }
    } else {
      this.resumeSlot = {
        value: p2Error('ACT_CANCELLED', 'runtime', 'act was cancelled', { module: 'core.js-run' }),
        thrown: true,
      }
    }
    return true
  }

  private fail(error: P2Error): void {
    if (this.isTerminal()) return
    this.currentError = error
    this.statusValue = 'failed'
    this.pending = undefined
    this.waitUntil = undefined
    this.resumeSlot = undefined
  }

  private isTerminal(): boolean {
    return this.statusValue === 'succeeded' || this.statusValue === 'failed' || this.statusValue === 'cancelled'
  }
}

function toP2Error(error: unknown, phase: 'init' | 'step' | 'cleanup'): P2Error {
  if (isP2Error(error)) return error
  return p2Error('BEHAVIOR_SCRIPT_ERROR', 'runtime', error instanceof Error ? error.message : String(error), { module: 'core.js-run' }, { phase })
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isP2Error(value: unknown): value is P2Error {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.category === 'string'
    && typeof value.message === 'string'
}

function parseRef(value: unknown): ArtifactRefLike | undefined {
  if (typeof value === 'string') return value.length > 0 ? { definitionId: value } : undefined
  if (!isRecord(value)) return undefined
  if (typeof value.definitionId !== 'string' || value.definitionId.length === 0) return undefined
  if (value.artifactId !== undefined && typeof value.artifactId !== 'string') return undefined
  return value.artifactId === undefined
    ? { definitionId: value.definitionId }
    : { definitionId: value.definitionId, artifactId: value.artifactId }
}

function invalidCommand(message: string): P2Error {
  return p2Error('BEHAVIOR_INVALID_COMMAND', 'runtime', message, { module: 'core.js-run' }, { phase: 'yield' })
}

function invalidReturn(message: string): P2Error {
  return p2Error('BEHAVIOR_INVALID_RETURN', 'runtime', message, { module: 'core.js-run' }, { phase: 'return' })
}

/** Bounds optional JSON payloads; business meaning is never inspected. */
function boundedJsonError(value: unknown, maxBytes: number, label: string): P2Error | undefined {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return p2Error('BEHAVIOR_VALUE_INVALID', 'runtime', `${label} must be JSON-serializable`, { module: 'core.js-run' }, { field: label })
  }
  if (text === undefined) {
    return p2Error('BEHAVIOR_VALUE_INVALID', 'runtime', `${label} must be JSON-serializable`, { module: 'core.js-run' }, { field: label })
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) {
    return p2Error(
      'BEHAVIOR_VALUE_TOO_LARGE',
      'runtime',
      `${label} exceeds ${maxBytes} bytes`,
      { module: 'core.js-run' },
      { field: label, bytes, limit: maxBytes },
    )
  }
  return undefined
}
