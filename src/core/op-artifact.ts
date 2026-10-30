import vm from 'node:vm'

import type { JsonValue, P2Error } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import type { ActHandle, QueryOutcome } from './node-runtime.ts'
import type { ControlIdentity, OpSource, ProviderControlState } from './op-broker.ts'
import type {
  OperationContract,
  OperationEffects,
  OperationKind,
  OperationStop,
} from '../operation/index.ts'

/** Checked op artifact as the body needs it; the code is re-loaded lazily. */
export type AuthoredOpArtifact = {
  artifactId: string
  name: string
  opKind: OperationKind
  effects: OperationEffects
  stop: OperationStop
  capabilities: string[]
  limits?: { totalMs?: number }
  code: string
}

/** The provider capability handed to an authored operation. */
export type OpProviderCapability = {
  /**
   * Query through the underlying provider. Resolves to the value; rejects with
   * a structured error. Async provider queries are awaited with a deadline.
   */
  query(name: string, args?: JsonValue): JsonValue | Promise<JsonValue>
  /**
   * Start a provider control operation directly. The returned handle is NOT
   * tracked by the broker unless it is also the handle the op hands back.
   */
  start?(name: string, args?: JsonValue): ActHandle
}

export type OpContext = {
  provider: OpProviderCapability
  now(): number
  log(message: string): void
}

export type AuthoredOpOptions = {
  now?: () => number
  log?: (message: string) => void
  /** Called once per execution that leaves a provider control effect untracked. */
  onUntracked?: (input: { artifactId: string; name: string; runId?: string }) => void
  loadTimeoutMs?: number
  /** Deadline for one provider query awaited by an op. */
  queryTimeoutMs?: number
}

const DEFAULT_LOAD_TIMEOUT_MS = 1000
const DEFAULT_QUERY_TIMEOUT_MS = 10_000
const MAX_OP_RESULT_BYTES = 64 * 1024

const OP_BOOTSTRAP = `
'use strict';
globalThis.__p2module = undefined;
globalThis.defineOp = function (m) {
  if (globalThis.__p2module !== undefined) throw new Error('defineOp called twice');
  globalThis.__p2module = m;
};
`

export type OpModule = {
  manifest?: unknown
  query?: unknown
  start?: unknown
}

export type LoadedOp = {
  module: OpModule
  /** Kept so the loaded functions stay tied to their own realm. */
  context: vm.Context
}

export class OpLoadError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'OpLoadError'
    this.code = code
  }
}

/**
 * Load a single-file op module in its own vm context.
 *
 * This is module assembly, not a security boundary: the development contract
 * says authored ops run in the body process and hold the provider capability
 * directly. The context still keeps `require`/`process` out of the module.
 */
export function loadOpModule(code: string, timeoutMs = DEFAULT_LOAD_TIMEOUT_MS): LoadedOp {
  const context = vm.createContext({}, {
    name: 'p2-op',
    codeGeneration: { strings: false, wasm: false },
  })
  try {
    runScript(context, OP_BOOTSTRAP, timeoutMs)
    runScript(context, code, timeoutMs)
    const module = vm.runInContext('globalThis.__p2module', context, { timeout: timeoutMs })
    if (typeof module !== 'object' || module === null || Array.isArray(module)) {
      throw new OpLoadError('INVALID_OP_MODULE', 'op must call defineOp({ manifest, query | start })')
    }
    return { module: module as OpModule, context }
  } catch (error) {
    if (error instanceof OpLoadError) throw error
    if (isTimeout(error)) {
      throw new OpLoadError('OP_LOAD_TIMEOUT', `op module exceeded ${timeoutMs}ms while loading`)
    }
    throw new OpLoadError('OP_LOAD_FAILED', errorMessage(error))
  }
}

/**
 * Wrap the provider source so broker submissions for an activated op name
 * reach the authored implementation. Names without an activated artifact fall
 * through to the base provider (including developer-mode operations).
 */
export function createAuthoredOpSource(
  base: OpSource,
  resolve: (name: string) => AuthoredOpArtifact | undefined,
  options: AuthoredOpOptions = {},
): OpSource {
  const loaded = new Map<string, LoadedOp>()
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? ((message: string) => { process.stderr.write(`[op] ${message}\n`) })
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS

  const load = (artifact: AuthoredOpArtifact): LoadedOp => {
    const cached = loaded.get(artifact.artifactId)
    if (cached !== undefined) return cached
    const value = loadOpModule(artifact.code, loadTimeoutMs)
    loaded.set(artifact.artifactId, value)
    return value
  }

  const contractOf = (artifact: AuthoredOpArtifact): OperationContract => ({
    id: artifact.name,
    kind: artifact.opKind,
    effects: artifact.effects,
    stop: artifact.stop,
    capabilities: [...artifact.capabilities],
    ...(artifact.limits === undefined ? {} : { limits: artifact.limits }),
  })

  const markUntracked = (artifact: AuthoredOpArtifact, identity: ControlIdentity | undefined): void => {
    options.onUntracked?.({
      artifactId: artifact.artifactId,
      name: artifact.name,
      ...(identity === undefined ? {} : { runId: identity.runId }),
    })
  }

  const providerQuery = (name: string, args?: JsonValue): JsonValue | Promise<JsonValue> => {
    const outcome = base.query(name, opArgs(args))
    if (outcome.status === 'ok') return outcome.value
    if (outcome.status === 'failed') throw outcome.error
    return awaitQuery(outcome, now() + queryTimeoutMs)
  }

  const makeContext = (
    artifact: AuthoredOpArtifact,
    identity: ControlIdentity | undefined,
    direct: ActHandle[],
  ): OpContext => {
    const provider: OpProviderCapability = {
      query: providerQuery,
      ...(artifact.opKind !== 'control' ? {} : {
        start: (name: string, args?: JsonValue): ActHandle => {
          const handle = base.start(name, opArgs(args), identity)
          direct.push(handle)
          return handle
        },
      }),
    }
    return {
      provider,
      now,
      log: (message: string) => { log(String(message)) },
    }
  }

  const runQuery = (artifact: AuthoredOpArtifact, args: Record<string, JsonValue>): QueryOutcome => {
    if (artifact.opKind !== 'query') {
      return { status: 'failed', error: p2Error('OP_KIND_MISMATCH', 'validation', `operation ${artifact.name} is control, not query`, { module: 'core.op-artifact', opId: artifact.name }) }
    }
    let module: OpModule
    try {
      module = load(artifact).module
    } catch (error) {
      return { status: 'failed', error: opError(error, artifact) }
    }
    if (typeof module.query !== 'function') {
      return { status: 'failed', error: p2Error('OP_IMPLEMENTATION_MISSING', 'capability', `query op ${artifact.name} has no query function`, { module: 'core.op-artifact', opId: artifact.name }) }
    }
    const direct: ActHandle[] = []
    let value: unknown
    try {
      value = (module.query as (ctx: OpContext, args: JsonValue) => unknown).call(module, makeContext(artifact, undefined, direct), args)
    } catch (error) {
      return { status: 'failed', error: opError(error, artifact) }
    }
    if (direct.length > 0) markUntracked(artifact, undefined)
    if (isPromise(value)) return pendingQuery(value, artifact, now() + (artifact.limits?.totalMs ?? queryTimeoutMs), now)
    try {
      return { status: 'ok', value: toJsonValue(value, artifact) }
    } catch (error) {
      return { status: 'failed', error: opError(error, artifact) }
    }
  }

  const runControl = (
    artifact: AuthoredOpArtifact,
    args: Record<string, JsonValue>,
    identity: ControlIdentity | undefined,
  ): ActHandle => {
    if (artifact.opKind !== 'control') {
      throw p2Error('OP_KIND_MISMATCH', 'validation', `operation ${artifact.name} is query, not control`, { module: 'core.op-artifact', opId: artifact.name })
    }
    const module = load(artifact).module
    if (typeof module.start !== 'function') {
      throw p2Error('OP_IMPLEMENTATION_MISSING', 'capability', `control op ${artifact.name} has no start function`, { module: 'core.op-artifact', opId: artifact.name })
    }
    const direct: ActHandle[] = []
    let handle: unknown
    try {
      handle = (module.start as (ctx: OpContext, args: JsonValue) => unknown).call(module, makeContext(artifact, identity, direct), args)
    } catch (error) {
      if (direct.length > 0) markUntracked(artifact, identity)
      throw opError(error, artifact)
    }
    if (!isActHandle(handle)) {
      if (direct.length > 0) markUntracked(artifact, identity)
      throw p2Error('OP_HANDLE_INVALID', 'runtime', `control op ${artifact.name} did not return a handle`, { module: 'core.op-artifact', opId: artifact.name })
    }
    // Only the handle returned to the broker is tracked; anything else the op
    // started through the provider is unaccounted for.
    if (direct.some(candidate => candidate !== handle)) markUntracked(artifact, identity)
    return handle
  }

  return {
    get capabilities(): readonly string[] | undefined {
      return base.capabilities
    },
    contract: (name: string): OperationContract | undefined => {
      const artifact = resolve(name)
      return artifact === undefined ? base.contract?.(name) : contractOf(artifact)
    },
    query: (name: string, args: Record<string, JsonValue>): QueryOutcome => {
      const artifact = resolve(name)
      if (artifact === undefined) return base.query(name, args)
      return runQuery(artifact, args)
    },
    start: (name: string, args: Record<string, JsonValue>, identity?: ControlIdentity): ActHandle => {
      const artifact = resolve(name)
      if (artifact === undefined) return base.start(name, args, identity)
      return runControl(artifact, args, identity)
    },
    ...(base.controlState === undefined
      ? {}
      : { controlState: (): ProviderControlState => base.controlState?.() ?? 'unknown' }),
  }
}

function pendingQuery(
  promise: Promise<unknown>,
  artifact: AuthoredOpArtifact,
  deadline: number,
  now: () => number,
): QueryOutcome {
  let outcome: QueryOutcome | undefined
  void promise.then(
    value => {
      if (outcome !== undefined) return
      try {
        outcome = { status: 'ok', value: toJsonValue(value, artifact) }
      } catch (error) {
        outcome = { status: 'failed', error: opError(error, artifact) }
      }
    },
    (error: unknown) => {
      if (outcome !== undefined) return
      outcome = { status: 'failed', error: opError(error, artifact) }
    },
  )
  const poll = (): QueryOutcome => {
    if (outcome !== undefined) return outcome
    if (now() > deadline) {
      outcome = {
        status: 'failed',
        error: p2Error('OP_TIMEOUT', 'timeout', `query op ${artifact.name} exceeded its deadline`, { module: 'core.op-artifact', opId: artifact.name }),
      }
      return outcome
    }
    return { status: 'pending', poll }
  }
  return poll()
}

function awaitQuery(outcome: Extract<QueryOutcome, { status: 'pending' }>, deadline: number): Promise<JsonValue> {
  return new Promise<JsonValue>((resolve, reject) => {
    const tick = (): void => {
      const next = outcome.poll()
      if (next.status === 'pending') {
        const timer = setTimeout(tick, 25)
        timer.unref?.()
        return
      }
      if (next.status === 'ok') resolve(next.value)
      else reject(next.error)
    }
    const timer = setTimeout(() => {
      reject(p2Error('QUERY_TIMEOUT', 'timeout', 'provider query exceeded the op deadline', { module: 'core.op-artifact' }))
    }, Math.max(0, deadline - Date.now()))
    timer.unref?.()
    tick()
  })
}

function runScript(context: vm.Context, code: string, timeout: number): void {
  vm.runInContext(code, context, { timeout })
}

function isTimeout(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

function isActHandle(value: unknown): value is ActHandle {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { poll?: unknown }).poll === 'function'
    && typeof (value as { stop?: unknown }).stop === 'function'
}

function opArgs(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw p2Error('INVALID_OP_ARGS', 'validation', 'operation arguments must be a JSON object', { module: 'core.op-artifact' })
  }
  return value
}

function toJsonValue(value: unknown, artifact: AuthoredOpArtifact): JsonValue {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    throw p2Error('OP_RESULT_INVALID', 'runtime', `query op ${artifact.name} returned a non-JSON value`, { module: 'core.op-artifact', opId: artifact.name })
  }
  if (text === undefined) return null
  if (Buffer.byteLength(text, 'utf8') > MAX_OP_RESULT_BYTES) {
    throw p2Error('OP_RESULT_TOO_LARGE', 'runtime', `query op ${artifact.name} result exceeds ${MAX_OP_RESULT_BYTES} bytes`, { module: 'core.op-artifact', opId: artifact.name })
  }
  return JSON.parse(text) as JsonValue
}

function opError(error: unknown, artifact: AuthoredOpArtifact): P2Error {
  const record = typeof error === 'object' && error !== null ? error as Partial<P2Error> : undefined
  if (record !== undefined && typeof record.code === 'string' && typeof record.message === 'string') {
    const category = isCategory(record.category) ? record.category : 'runtime'
    const source = typeof record.source === 'object' && record.source !== null
      && typeof (record.source as { module?: unknown }).module === 'string'
      ? record.source as P2Error['source']
      : { module: 'core.op-artifact', opId: artifact.name }
    return {
      code: record.code,
      category,
      message: record.message,
      source,
      retry: record.retry === 'explicit-policy' || record.retry === 'cleanup-once' ? record.retry : 'never',
      ...(record.details === undefined ? {} : { details: record.details }),
    }
  }
  return p2Error('OP_FAILED', 'runtime', errorMessage(error), { module: 'core.op-artifact', opId: artifact.name })
}

function isCategory(value: unknown): value is P2Error['category'] {
  return value === 'validation'
    || value === 'capability'
    || value === 'environment'
    || value === 'timeout'
    || value === 'transport'
    || value === 'runtime'
    || value === 'control'
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}


