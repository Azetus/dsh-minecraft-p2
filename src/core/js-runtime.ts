import vm from 'node:vm'

import { p2Error } from '../contracts/protocol.ts'
import type { BehaviorArtifact } from '../contracts/ir.ts'
import type { ArtifactRef } from '../contracts/ir.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import type { CurrentStep, RunObservation } from '../contracts/protocol.ts'
import type { ActHandle, ActPoll, ActPort, PolicyOutcome, PolicyPort, QueryOutcome, QueryPort } from './node-runtime.ts'
import type { RunStatus } from './run.ts'
import { StopControl, cleanupStateOf, controlHealthOf, stopUnconfirmedError, switchStateOf } from './stop-control.ts'
import type { StopState } from './stop-control.ts'

type JsCommand =
  | { type: 'query'; op: string; args: Record<string, JsonValue> }
  | { type: 'act'; ref: ArtifactRef | string; args: Record<string, JsonValue> }
  | { type: 'decide'; ref: ArtifactRef | string; inputs: Record<string, JsonValue> }
  | { type: 'wait'; durationMs: number }
  | { type: 'progress'; value: JsonValue }
  | { type: 'log'; message: string }

type TerminalCommand =
  | { type: 'succeed'; evidence?: JsonValue }
  | { type: 'fail'; code: string; message: string }

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
  resolveAct: (definitionId: string) => string | undefined
  resolvePolicy: (definitionId: string) => string | undefined
}

const STEP_TIMEOUT_MS = 50
const STEP_BUDGET = 100
const LOAD_TIMEOUT_MS = 1000
const MAX_PROGRESS_BYTES = 4 * 1024
const MAX_LOG_MESSAGE_BYTES = 4 * 1024
const MAX_EVIDENCE_BYTES = 16 * 1024
const LOG_BUFFER_BYTES = 256 * 1024

/**
 * JS behavior driver. One tick advances at most one bounded scheduling pass over
 * the generator: all completions travel through a single resume slot, so no
 * callback or synchronous port reply can recurse into another step.
 *
 * Every author-code entry (run initialization, one step, generator.return()
 * cleanup) runs inside the vm with a CPU timeout; invalid yields/returns fail
 * the run immediately instead of being skipped or misread as terminal.
 */
export class JsBehaviorRun {
  readonly runId: string
  readonly owner: string
  readonly definition: BehaviorArtifact['definition']
  private readonly options: JsBehaviorRunOptions
  private readonly context: vm.Context
  private generator: Generator<unknown, unknown, unknown> | undefined
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
    this.context = vm.createContext({})
    this.load(options.artifact.code ?? '')
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
      this.runCleanup()
    } else {
      // Repeated stop/switch: re-request ledger stopping without a new deadline.
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
    this.clock = now
    let budget = STEP_BUDGET
    while (!this.isTerminal()) {
      if (this.pending !== undefined) {
        if (!this.pollPending()) return this.statusValue
      }
      if (this.waitUntil !== undefined) {
        if (now < this.waitUntil) return this.statusValue
        this.waitUntil = undefined
        this.resumeSlot = { value: undefined, thrown: false }
      }
      const slot = this.resumeSlot
      if (slot === undefined) return this.statusValue
      if (budget <= 0) return this.statusValue
      budget -= 1
      this.resumeSlot = undefined
      this.step(slot)
      if (this.pending !== undefined || this.waitUntil !== undefined) return this.statusValue
    }
    return this.statusValue
  }

  private load(code: string): void {
    let captured: unknown
    this.context.defineBehavior = (value: unknown) => { captured = value }
    try {
      vm.runInContext(code, this.context, { timeout: LOAD_TIMEOUT_MS })
    } catch (error) {
      this.fail(p2Error('JS_LOAD_FAILED', 'runtime', error instanceof Error ? error.message : String(error), { module: 'core.js-run' }))
      return
    }
    if (!isRecord(captured)) {
      this.fail(p2Error('INVALID_MANIFEST', 'validation', 'JS behavior must call defineBehavior', { module: 'core.js-run' }))
      return
    }
    const module = captured as { run?: unknown }
    if (typeof module.run !== 'function') {
      this.fail(p2Error('INVALID_MANIFEST', 'validation', 'JS behavior must provide run(ctx)', { module: 'core.js-run' }))
      return
    }
    const params = JSON.parse(JSON.stringify(this.options.params)) as Record<string, JsonValue>
    const ctx = this.createContext(params)
    // The call is made from inside the vm so the step timeout also covers a
    // non-generator run() that would otherwise occupy the body process.
    this.context.__p2_init = () => (module.run as (context: unknown) => unknown)(ctx)
    let generator: unknown
    try {
      generator = vm.runInContext('__p2_init()', this.context, { timeout: STEP_TIMEOUT_MS })
    } catch (error) {
      this.fail(this.authorError(error, 'init'))
      return
    }
    if (!isGenerator(generator)) {
      this.fail(p2Error('INVALID_MANIFEST', 'validation', 'run(ctx) must return a synchronous generator', { module: 'core.js-run' }))
      return
    }
    this.generator = generator
    this.resumeSlot = { value: undefined, thrown: false }
  }

  private createContext(params: Record<string, JsonValue>): Readonly<Record<string, unknown>> {
    return Object.freeze({
      params,
      runId: this.runId,
      now: () => Date.now(),
      query: (op: string, args: Record<string, JsonValue> = {}) => ({ type: 'query', op, args }),
      act: (ref: ArtifactRef | string, args: Record<string, JsonValue> = {}) => ({ type: 'act', ref, args }),
      decide: (ref: ArtifactRef | string, inputs: Record<string, JsonValue> = {}) => ({ type: 'decide', ref, inputs }),
      wait: (durationMs: number) => ({ type: 'wait', durationMs }),
      progress: (value: JsonValue) => ({ type: 'progress', value }),
      log: (message: unknown) => ({ type: 'log', message: String(message) }),
      succeed: (evidence?: JsonValue) => ({ type: 'succeed', evidence }),
      fail: (code: string, message: string) => ({ type: 'fail', code, message }),
      fresh: (snapshot: { value?: JsonValue; meta?: { validUntil?: number } }) => {
        const validUntil = snapshot?.meta?.validUntil
        if (typeof validUntil !== 'number' || Date.now() > validUntil) {
          throw p2Error('STALE_OBSERVATION', 'runtime', 'observation is stale', { module: 'core.js-run' })
        }
        return snapshot.value
      },
    })
  }

  private step(slot: ResumeSlot): void {
    const generator = this.generator
    if (generator === undefined) return
    this.stepCount += 1
    const state = { input: slot.value, thrown: slot.thrown }
    this.context.__p2_step = () => (state.thrown ? generator.throw(state.input) : generator.next(state.input))
    let result: unknown
    try {
      result = vm.runInContext('__p2_step()', this.context, { timeout: STEP_TIMEOUT_MS })
    } catch (error) {
      this.fail(this.authorError(error, 'step'))
      return
    }
    if (!isRecord(result) || typeof result.done !== 'boolean') {
      this.fail(p2Error('BEHAVIOR_SCRIPT_ERROR', 'runtime', 'generator step returned an invalid result', { module: 'core.js-run' }, { phase: 'step' }))
      return
    }
    if (result.done) {
      this.finishRun(result.value)
      return
    }
    this.dispatch(result.value)
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

  private advanceStop(now: number): StopState {
    const release = this.options.act.pollRelease?.(now) ?? 'released'
    const state = this.stopControl.observe(now, release)
    if (state === 'released') {
      this.statusValue = 'cancelled'
    } else {
      const failure = stopUnconfirmedError(state)
      if (failure !== undefined) this.currentError = failure
    }
    return state
  }

  private runCleanup(): void {    const generator = this.generator
    if (generator === undefined) return
    this.generator = undefined
    this.context.__p2_return = () => generator.return(undefined)
    try {
      const result = vm.runInContext('__p2_return()', this.context, { timeout: STEP_TIMEOUT_MS })
      if (isRecord(result) && result.done === false) {
        this.currentError = p2Error(
          'BEHAVIOR_CLEANUP_ERROR',
          'runtime',
          'behavior yielded while running finally after cancellation',
          { module: 'core.js-run' },
          { phase: 'cleanup' },
        )
      }
    } catch (error) {
      this.currentError = this.authorError(error, 'cleanup')
    }
  }

  private authorError(error: unknown, phase: 'init' | 'step' | 'cleanup'): P2Error {
    if (isTimeoutError(error)) {
      return p2Error(
        'BEHAVIOR_STEP_TIMEOUT',
        'timeout',
        `behavior ${phase} timed out after ${STEP_TIMEOUT_MS}ms`,
        { module: 'core.js-run' },
        { phase },
      )
    }
    if (isP2Error(error)) return error
    return p2Error(
      'BEHAVIOR_SCRIPT_ERROR',
      'runtime',
      error instanceof Error ? error.message : String(error),
      { module: 'core.js-run' },
      { phase },
    )
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isP2Error(value: unknown): value is P2Error {
  if (!isRecord(value)) return false
  return typeof value.code === 'string'
    && typeof value.category === 'string'
    && typeof value.message === 'string'
}

function isTimeoutError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
}

function isGenerator(value: unknown): value is Generator<unknown, unknown, unknown> {
  return typeof value === 'object'
    && value !== null
    && Object.prototype.toString.call(value) === '[object Generator]'
    && typeof (value as { next?: unknown }).next === 'function'
    && typeof (value as { return?: unknown }).return === 'function'
}

function parseRef(value: unknown): ArtifactRef | undefined {
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
