import vm from 'node:vm'

import { p2Error } from '../contracts/protocol.ts'
import type { BehaviorArtifact } from '../contracts/ir.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import type { RunnerBehaviorResult } from '../runner/protocol.ts'
import type { RunnerClient } from './runner-client.ts'
import { RunnerError } from './runner-client.ts'

export type DriverResume = { value: unknown; thrown: boolean }

export type DriverStep =
  | { kind: 'yield'; command: unknown }
  | { kind: 'done'; value: unknown }

export type DriverIdentity = {
  runId: string
  generation: number
}

export type DriverStop = { yielded: boolean }

/**
 * Executes one author generator. Implementations either run it locally (test
 * fallback) or in the sandbox runner; the scheduler owns all commands.
 */
export interface BehaviorDriver {
  readonly asynchronous: boolean
  start(params: Record<string, JsonValue>): void | Promise<void>
  resume(input: DriverResume, identity: DriverIdentity): DriverStep | Promise<DriverStep>
  stop(identity: DriverIdentity): DriverStop | Promise<DriverStop>
}

export const DRIVER_STEP_TIMEOUT_MS = 50
const DRIVER_LOAD_TIMEOUT_MS = 1000

type JsCommand =
  | { type: 'query'; op: string; args: Record<string, JsonValue> }
  | { type: 'act'; ref: unknown; args: Record<string, JsonValue> }
  | { type: 'decide'; ref: unknown; inputs: Record<string, JsonValue> }
  | { type: 'wait'; durationMs: number }
  | { type: 'progress'; value: JsonValue }
  | { type: 'log'; message: string }
  | { type: 'succeed'; evidence?: JsonValue }
  | { type: 'fail'; code: string; message: string }

/** In-process node:vm driver used when no runner is configured (tests, fallback). */
export class LocalBehaviorDriver implements BehaviorDriver {
  readonly asynchronous = false
  private readonly context: vm.Context
  private readonly code: string
  private readonly params: Record<string, JsonValue>
  private readonly runId: string
  private generator: Generator<unknown, unknown, unknown> | undefined

  constructor(code: string, params: Record<string, JsonValue>, runId: string) {
    this.code = code
    this.params = params
    this.runId = runId
    this.context = vm.createContext({})
  }

  start(_params: Record<string, JsonValue>): void {
    let captured: unknown
    this.context.defineBehavior = (value: unknown) => { captured = value }
    try {
      vm.runInContext(this.code, this.context, { timeout: DRIVER_LOAD_TIMEOUT_MS })
    } catch (error) {
      throw p2Error('JS_LOAD_FAILED', 'runtime', messageOf(error), { module: 'core.js-run' })
    }
    if (!isRecord(captured)) {
      throw p2Error('INVALID_MANIFEST', 'validation', 'JS behavior must call defineBehavior', { module: 'core.js-run' })
    }
    const module = captured as { run?: unknown }
    if (typeof module.run !== 'function') {
      throw p2Error('INVALID_MANIFEST', 'validation', 'JS behavior must provide run(ctx)', { module: 'core.js-run' })
    }
    const ctx = this.createContext()
    this.context.__p2_init = () => (module.run as (context: unknown) => unknown)(ctx)
    let generator: unknown
    try {
      generator = vm.runInContext('__p2_init()', this.context, { timeout: DRIVER_STEP_TIMEOUT_MS })
    } catch (error) {
      throw authorError(error, 'init')
    }
    if (!isGenerator(generator)) {
      throw p2Error('INVALID_MANIFEST', 'validation', 'run(ctx) must return a synchronous generator', { module: 'core.js-run' })
    }
    this.generator = generator
  }

  resume(input: DriverResume): DriverStep {
    const generator = this.generator
    if (generator === undefined) throw p2Error('BEHAVIOR_SCRIPT_ERROR', 'runtime', 'behavior has not started', { module: 'core.js-run' })
    const state = { input: input.value, thrown: input.thrown }
    this.context.__p2_step = () => (state.thrown ? generator.throw(state.input) : generator.next(state.input))
    let result: unknown
    try {
      result = vm.runInContext('__p2_step()', this.context, { timeout: DRIVER_STEP_TIMEOUT_MS })
    } catch (error) {
      throw authorError(error, 'step')
    }
    if (!isRecord(result) || typeof result.done !== 'boolean') {
      throw p2Error('BEHAVIOR_SCRIPT_ERROR', 'runtime', 'generator step returned an invalid result', { module: 'core.js-run' }, { phase: 'step' })
    }
    if (result.done) return { kind: 'done', value: result.value }
    return { kind: 'yield', command: result.value }
  }

  stop(): DriverStop {
    const generator = this.generator
    if (generator === undefined) return { yielded: false }
    this.generator = undefined
    this.context.__p2_return = () => generator.return(undefined)
    try {
      const result = vm.runInContext('__p2_return()', this.context, { timeout: DRIVER_STEP_TIMEOUT_MS })
      return { yielded: isRecord(result) && result.done === false }
    } catch (error) {
      throw authorError(error, 'cleanup')
    }
  }

  private createContext(): Readonly<Record<string, unknown>> {
    const params = JSON.parse(JSON.stringify(this.params)) as Record<string, JsonValue>
    const command = (type: string, payload: Record<string, unknown>): JsCommand => ({ type, ...payload } as JsCommand)
    return Object.freeze({
      params,
      runId: this.runId,
      now: () => Date.now(),
      query: (op: string, args: Record<string, JsonValue> = {}) => command('query', { op, args }),
      act: (ref: unknown, args: Record<string, JsonValue> = {}) => command('act', { ref, args }),
      decide: (ref: unknown, inputs: Record<string, JsonValue> = {}) => command('decide', { ref, inputs }),
      wait: (durationMs: number) => command('wait', { durationMs }),
      progress: (value: JsonValue) => command('progress', { value }),
      log: (message: unknown) => command('log', { message: String(message) }),
      succeed: (evidence?: JsonValue) => command('succeed', { evidence }),
      fail: (code: string, message: string) => command('fail', { code, message }),
      fresh: (snapshot: { value?: JsonValue; meta?: { validUntil?: number } }) => {
        const validUntil = snapshot?.meta?.validUntil
        if (typeof validUntil !== 'number' || Date.now() > validUntil) {
          throw p2Error('STALE_OBSERVATION', 'runtime', 'observation is stale', { module: 'core.js-run' })
        }
        return snapshot.value
      },
    })
  }
}

/** Driver backed by the sandbox runner; one request per generator step. */
export class RunnerBehaviorDriver implements BehaviorDriver {
  readonly asynchronous = true
  private readonly getClient: () => RunnerClient

  constructor(
    client: RunnerClient | (() => RunnerClient),
    private readonly artifact: BehaviorArtifact,
    private readonly runId: string,
  ) {
    this.getClient = typeof client === 'function' ? client : () => client
  }

  async start(params: Record<string, JsonValue>): Promise<void> {
    await this.getClient().load('behavior', this.artifact.artifactId, this.artifact.code ?? '')
    await this.getClient().behaviorStart(
      this.artifact.artifactId,
      this.runId,
      `${this.runId}:behavior`,
      0,
      params as unknown as JsonValue,
    )
  }

  async resume(input: DriverResume, identity: DriverIdentity): Promise<DriverStep> {
    let result: RunnerBehaviorResult
    try {
      result = await this.getClient().behaviorResume(identity.runId, identity.generation, {
        ...(input.thrown ? { thrown: true } : { thrown: false }),
        ...(input.value === undefined ? {} : { value: input.value as JsonValue }),
      })
    } catch (error) {
      throw runnerError(error, 'step')
    }
    if (result.kind === 'yield') return { kind: 'yield', command: result.command }
    if (result.kind === 'done') return { kind: 'done', value: result.value }
    if (result.kind === 'threw') throw errorFromJson(result.error)
    throw p2Error('BEHAVIOR_SCRIPT_ERROR', 'runtime', 'runner returned an unexpected behavior step', { module: 'core.js-run' })
  }

  async stop(identity: DriverIdentity): Promise<DriverStop> {
    try {
      const result = await this.getClient().behaviorStop(identity.runId, identity.generation)
      return { yielded: result.kind === 'stopped' && result.yielded === true }
    } catch (error) {
      throw runnerError(error, 'cleanup')
    }
  }
}

function runnerError(error: unknown, phase: 'step' | 'cleanup'): P2Error {
  if (error instanceof RunnerError) {
    const category = error.code === 'RUNNER_TIMEOUT' || error.code === 'BEHAVIOR_STEP_TIMEOUT'
      ? 'timeout'
      : error.code === 'RUNNER_EXITED'
        ? 'runtime'
        : 'runtime'
    return p2Error(error.code, category, error.message, { module: 'core.js-run' }, { phase })
  }
  return p2Error('BEHAVIOR_SCRIPT_ERROR', 'runtime', messageOf(error), { module: 'core.js-run' }, { phase })
}

function errorFromJson(value: JsonValue): P2Error {
  if (isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string') {
    const category = typeof value.category === 'string' ? value.category : 'runtime'
    const source = isRecord(value.source) && typeof value.source.module === 'string'
      ? { module: value.source.module }
      : { module: 'runner.behavior' }
    return p2Error(value.code, categoryOf(category), value.message, source)
  }
  return p2Error('BEHAVIOR_SCRIPT_ERROR', 'runtime', 'behavior threw a non-JSON error', { module: 'core.js-run' })
}

function categoryOf(category: string): P2Error['category'] {
  switch (category) {
    case 'validation':
    case 'capability':
    case 'environment':
    case 'timeout':
    case 'transport':
    case 'runtime':
    case 'control':
      return category
    default:
      return 'runtime'
  }
}

function authorError(error: unknown, phase: 'init' | 'step' | 'cleanup'): P2Error {
  if (isTimeoutError(error)) {
    return p2Error(
      'BEHAVIOR_STEP_TIMEOUT',
      'timeout',
      `behavior ${phase} timed out after ${DRIVER_STEP_TIMEOUT_MS}ms`,
      { module: 'core.js-run' },
      { phase },
    )
  }
  if (isP2Error(error)) return error
  return p2Error('BEHAVIOR_SCRIPT_ERROR', 'runtime', messageOf(error), { module: 'core.js-run' }, { phase })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTimeoutError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
}

function isP2Error(value: unknown): value is P2Error {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.category === 'string'
    && typeof value.message === 'string'
}

function isGenerator(value: unknown): value is Generator<unknown, unknown, unknown> {
  return typeof value === 'object'
    && value !== null
    && Object.prototype.toString.call(value) === '[object Generator]'
    && typeof (value as { next?: unknown }).next === 'function'
    && typeof (value as { return?: unknown }).return === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
