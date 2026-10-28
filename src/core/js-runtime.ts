import vm from 'node:vm'

import { p2Error } from '../contracts/protocol.ts'
import type { BehaviorArtifact } from '../contracts/ir.ts'
import type { ArtifactRef } from '../contracts/ir.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import type { ActHandle, ActPoll, ActPort, PolicyOutcome, PolicyPort, QueryOutcome, QueryPort } from './node-runtime.ts'
import type { RunStatus } from './run.ts'

type JsCommand =
  | { type: 'query'; op: string; args: Record<string, JsonValue> }
  | { type: 'act'; ref: ArtifactRef | string; args: Record<string, JsonValue> }
  | { type: 'decide'; ref: ArtifactRef | string; inputs: Record<string, JsonValue> }
  | { type: 'wait'; durationMs: number }
  | { type: 'progress'; value: JsonValue }
  | { type: 'log'; message: string }
  | { type: 'succeed'; evidence?: JsonValue }
  | { type: 'fail'; code: string; message: string }

type GeneratorResult = { done?: boolean; value?: unknown }

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

/**
 * Experimental JS behavior driver. It evaluates a single generator step inside
 * a vm context and maps yielded commands to the existing query/act/policy ports.
 * It is intentionally small: the experiment compares this driver with IR.
 */
export class JsBehaviorRun {
  readonly runId: string
  readonly owner: string
  readonly definition: BehaviorArtifact['definition']
  private readonly options: JsBehaviorRunOptions
  private readonly context: vm.Context
  private generator: Generator<unknown, unknown, unknown> | undefined
  private stepState: { generator: Generator<unknown, unknown, unknown>; input?: unknown; thrown?: boolean } | undefined
  private statusValue: RunStatus = 'running'
  private pending: Pending | undefined
  private waitUntil: number | undefined
  private currentError: P2Error | undefined
  private stepLabel: string | null = null
  private activeAct: string | null = null
  private activeTarget: { x: number; z: number } | null = null
  private progressValue: JsonValue | undefined
  private stopped = false

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

  get confirmation(): undefined {
    return undefined
  }

  describe(): { activeAct: string | null; activeNode: string | null; activeTarget: { x: number; z: number } | null; waiting: string | null; lastFailure: P2Error | undefined } {
    return {
      activeAct: this.activeAct,
      activeNode: this.stepLabel,
      activeTarget: this.activeTarget,
      waiting: this.pending === undefined ? (this.waitUntil === undefined ? null : 'wait') : this.pending.kind,
      lastFailure: this.currentError,
    }
  }

  confirm(_input?: unknown): { outcome: 'rejected'; status: RunStatus; error?: P2Error } {
    return {
      outcome: 'rejected',
      status: this.statusValue,
      error: p2Error('CONFIRMATION_UNSUPPORTED', 'validation', 'JS behaviors do not use external confirmation', { module: 'core.js-run' }),
    }
  }

  stop(): void {
    if (this.isTerminal()) return
    this.stopped = true
    if (this.pending?.kind === 'act') {
      try { this.pending.handle.stop() } catch {}
    }
    this.pending = undefined
    try {
      if (this.generator !== undefined) this.generator.return(undefined)
    } catch {}
    this.statusValue = 'cancelled'
  }

  tick(now = Date.now()): RunStatus {
    if (this.isTerminal()) return this.statusValue
    if (this.stopped) {
      this.statusValue = 'cancelled'
      return this.statusValue
    }
    let budget = STEP_BUDGET
    while (budget > 0 && !this.isTerminal()) {
      budget -= 1
      if (this.pending !== undefined) {
        if (!this.pollPending(now)) return this.statusValue
        continue
      }
      if (this.waitUntil !== undefined) {
        if (now < this.waitUntil) return this.statusValue
        this.waitUntil = undefined
        this.resume(undefined)
        continue
      }
      this.resume(undefined)
      if (this.pending !== undefined || this.waitUntil !== undefined) return this.statusValue
      if (this.isTerminal()) return this.statusValue
    }
    return this.statusValue
  }

  private load(code: string): void {
    let captured: unknown
    this.context.defineBehavior = (value: unknown) => { captured = value }
    try {
      vm.runInContext(code, this.context, { timeout: 1000 })
    } catch (error) {
      this.fail(p2Error('JS_LOAD_FAILED', 'runtime', error instanceof Error ? error.message : String(error), { module: 'core.js-run' }))
      return
    }
    if (typeof captured !== 'object' || captured === null) {
      this.fail(p2Error('INVALID_MANIFEST', 'validation', 'JS behavior must call defineBehavior', { module: 'core.js-run' }))
      return
    }
    const module = captured as { run?: (ctx: unknown) => unknown }
    if (typeof module.run !== 'function') {
      this.fail(p2Error('INVALID_MANIFEST', 'validation', 'JS behavior must provide run(ctx)', { module: 'core.js-run' }))
      return
    }
    const params = JSON.parse(JSON.stringify(this.options.params)) as Record<string, JsonValue>
    const ctx = Object.freeze({
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
    try {
      const generator = module.run(ctx) as Generator<unknown, unknown, unknown>
      if (typeof generator?.next !== 'function') {
        this.fail(p2Error('INVALID_MANIFEST', 'validation', 'run(ctx) must return a generator', { module: 'core.js-run' }))
        return
      }
      this.generator = generator
      const state = { generator, input: undefined as unknown, thrown: false }
      this.stepState = state
      this.context.__p2_step = function (): GeneratorResult {
        return state.thrown ? state.generator.throw(state.input) : state.generator.next(state.input)
      }
    } catch (error) {
      this.fail(p2Error('JS_START_FAILED', 'runtime', error instanceof Error ? error.message : String(error), { module: 'core.js-run' }))
    }
  }

  private resume(value: unknown, thrown = false): void {
    if (this.generator === undefined || this.isTerminal()) return
    if (this.stepState === undefined) return
    this.stepState.input = value
    this.stepState.thrown = thrown
    let result: GeneratorResult
    try {
      result = vm.runInContext('__p2_step()', this.context, { timeout: STEP_TIMEOUT_MS }) as GeneratorResult
    } catch (error) {
      if (typeof error === 'object' && error !== null && typeof (error as P2Error).code === 'string' && typeof (error as P2Error).message === 'string') {
        this.fail(error as P2Error)
        return
      }
      this.fail(p2Error(
        error instanceof Error && /timed out/u.test(error.message) ? 'JS_STEP_TIMEOUT' : 'JS_BEHAVIOR_ERROR',
        'runtime',
        error instanceof Error ? error.message : String(error),
        { module: 'core.js-run' },
      ))
      return
    }
    const command = result.value as JsCommand | undefined
    if (command !== undefined) {
      this.handle(command)
      return
    }
    if (result.done === true) {
      this.fail(p2Error('JS_BEHAVIOR_ENDED', 'runtime', 'JS behavior ended without succeed/fail', { module: 'core.js-run' }))
    }
  }

  private handle(command: JsCommand): void {
    switch (command.type) {
      case 'query': {
        this.stepLabel = `query:${command.op}`
        const outcome = this.options.query({ op: command.op, args: {} }, command.args)
        if (outcome.status === 'pending') {
          this.pending = { kind: 'query', poll: outcome.poll }
          return
        }
        this.finishQuery(outcome)
        return
      }
      case 'act': {
        const definitionId = typeof command.ref === 'string' ? command.ref : command.ref.definitionId
        const artifactId = typeof command.ref === 'object' && command.ref.artifactId !== undefined
          ? command.ref.artifactId
          : this.options.resolveAct(definitionId)
        if (artifactId === undefined) {
          this.resume(p2Error('ACT_REF_UNRESOLVED', 'validation', `act ${definitionId} is not active`, { module: 'core.js-run' }), true)
          return
        }
        this.stepLabel = `act:${definitionId}`
        this.activeAct = definitionId
        const x = command.args.x
        const z = command.args.z
        this.activeTarget = typeof x === 'number' && typeof z === 'number' ? { x, z } : null
        try {
          this.pending = { kind: 'act', handle: this.options.act.start({ definitionId, artifactId }, command.args) }
        } catch (error) {
          this.resume(error, true)
        }
        return
      }
      case 'decide': {
        if (this.options.policy === undefined) {
          this.resume(p2Error('POLICY_UNAVAILABLE', 'runtime', 'no policy port is connected', { module: 'core.js-run' }), true)
          return
        }
        const definitionId = typeof command.ref === 'string' ? command.ref : command.ref.definitionId
        const artifactId = typeof command.ref === 'object' && command.ref.artifactId !== undefined
          ? command.ref.artifactId
          : this.options.resolvePolicy(definitionId)
        if (artifactId === undefined) {
          this.resume(p2Error('POLICY_REF_UNRESOLVED', 'validation', `policy ${definitionId} is not checked`, { module: 'core.js-run' }), true)
          return
        }
        this.stepLabel = `decide:${definitionId}`
        const outcome = this.options.policy.call({ definitionId, artifactId }, command.inputs)
        if (outcome.status === 'pending') {
          this.pending = { kind: 'policy', poll: outcome.poll }
          return
        }
        this.finishPolicy(outcome)
        return
      }
      case 'wait': {
        this.stepLabel = `wait ${Math.max(0, command.durationMs)}`
        this.waitUntil = Date.now() + Math.max(0, command.durationMs)
        return
      }
      case 'progress': {
        this.progressValue = command.value
        this.resume(undefined)
        return
      }
      case 'log': {
        this.resume(undefined)
        return
      }
      case 'succeed': {
        this.statusValue = 'succeeded'
        return
      }
      case 'fail': {
        this.fail(p2Error(command.code, 'runtime', command.message, { module: 'core.js-run' }))
        return
      }
    }
  }

  private finishQuery(outcome: QueryOutcome): void {
    if (outcome.status === 'ok') {
      this.resume({ value: outcome.value, meta: outcome.meta })
    } else if (outcome.status === 'failed') {
      this.resume(outcome.error, true)
    }
  }

  private finishPolicy(outcome: PolicyOutcome): void {
    if (outcome.status === 'ok') {
      this.resume(outcome.value)
    } else if (outcome.status === 'failed') {
      this.resume(outcome.error, true)
    }
  }

  private pollPending(now: number): boolean {
    const pending = this.pending
    if (pending === undefined) return true
    if (pending.kind === 'query') {
      const outcome = pending.poll()
      if (outcome.status === 'pending') return false
      this.pending = undefined
      this.finishQuery(outcome)
      return true
    }
    if (pending.kind === 'policy') {
      const outcome = pending.poll()
      if (outcome.status === 'pending') return false
      this.pending = undefined
      this.finishPolicy(outcome)
      return true
    }
    const outcome: ActPoll = pending.handle.poll()
    if (outcome.status === 'running') return false
    this.pending = undefined
    this.activeAct = null
    this.activeTarget = null
    if (outcome.status === 'succeeded') {
      this.resume({ value: outcome.result, meta: outcome.meta })
    } else if (outcome.status === 'failed') {
      this.resume(outcome.error, true)
    } else {
      this.resume(p2Error('ACT_CANCELLED', 'runtime', 'act was cancelled', { module: 'core.js-run' }), true)
    }
    void now
    return true
  }

  private fail(error: P2Error): void {
    if (this.isTerminal()) return
    this.currentError = error
    this.statusValue = 'failed'
    this.pending = undefined
    this.waitUntil = undefined
  }

  private isTerminal(): boolean {
    return this.statusValue === 'succeeded' || this.statusValue === 'failed' || this.statusValue === 'cancelled'
  }
}
