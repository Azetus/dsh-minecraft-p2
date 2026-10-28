import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import type { ActHandle, ActPoll, ActPort, ActRefLike, QueryOutcome } from './node-runtime.ts'
import type { DeclaredOpBroker } from './op-broker.ts'
import type { RunnerClient, RunnerOpEvent } from './runner-client.ts'
import { RunnerError } from './runner-client.ts'

export type ActSource = {
  artifactId: string
  definitionId: string
  code: string
  ops: { query: string[]; control: string[] }
  limits?: { totalMs?: number }
}

type OpState =
  | { callId: number; kind: 'query'; poll: () => QueryOutcome }
  | { callId: number; kind: 'control'; handle: ActHandle }
  | { callId: number; kind: 'done'; ok: boolean; value?: JsonValue; error?: P2Error }

type ActState = {
  source: ActSource
  phase: 'starting' | 'running' | 'stopping' | 'terminal'
  final: ActPoll | undefined
  inFlight: boolean
  stopRequested: boolean
  business: { ok: boolean; value?: JsonValue; error?: P2Error } | undefined
  ops: Map<number, OpState>
  results: Array<{ id: number; status: 'ok' | 'failed'; value?: JsonValue; error?: P2Error }>
  startedAt: number
  cleanupUntil: number | undefined
  lastUpdateAt: number
}

const DEFAULT_ACT_LIMIT_MS = 30_000
const CLEANUP_TIMEOUT_MS = 1000

/**
 * Act port backed by the isolated runner. Hooks never block the body tick:
 * operation requests are tracked here and delivered on the next update.
 */
export class RunnerActPort implements ActPort {
  private current: ActState | undefined
  private readonly loaded = new Map<string, Promise<void>>()

  constructor(
    private readonly client: RunnerClient,
    private readonly broker: DeclaredOpBroker,
    private readonly resolveArtifact: (artifactId: string) => ActSource | undefined,
  ) {}

  /** Route an operation request emitted by the runner. */
  handleOp(event: RunnerOpEvent): void {
    const state = this.current
    if (state === undefined || state.phase === 'terminal') return
    const declared = event.kind === 'query' ? state.source.ops.query : state.source.ops.control
    if (!declared.includes(event.name)) {
      this.finishOp(state, event.callId, false, undefined, p2Error(
        'OP_NOT_DECLARED',
        'validation',
        `act ${state.source.definitionId} did not declare ${event.kind} op ${event.name}`,
        { module: 'core.act-port', opId: event.name },
      ))
      return
    }
    try {
      const opArgs = asOpArgs(event.args)
      if (event.kind === 'query') {
        const outcome = this.broker.query(event.name, opArgs)
        if (outcome.status === 'pending') {
          state.ops.set(event.callId, { callId: event.callId, kind: 'query', poll: outcome.poll })
          return
        }
        if (outcome.status === 'failed') {
          this.finishOp(state, event.callId, false, undefined, outcome.error)
          return
        }
        this.finishOp(state, event.callId, true, outcome.value)
        return
      }
      const handle = this.broker.start(event.name, opArgs)
      state.ops.set(event.callId, { callId: event.callId, kind: 'control', handle })
    } catch (error) {
      this.finishOp(state, event.callId, false, undefined, asP2Error(error, 'core.act-port'))
    }
  }

  start(ref: ActRefLike, args: Record<string, JsonValue>): ActHandle {
    if (typeof ref === 'string') {
      throw p2Error('ACT_REF_UNRESOLVED', 'validation', `act reference must be an artifact reference, got ${ref}`, {
        module: 'core.act-port',
      })
    }
    const artifactId = ref.artifactId
    if (artifactId === undefined) {
      throw p2Error('ACT_REF_UNRESOLVED', 'validation', `act reference ${ref.definitionId} has no artifactId`, {
        module: 'core.act-port',
      })
    }
    const source = this.resolveArtifact(artifactId)
    if (source === undefined) {
      throw p2Error('ACT_NOT_FOUND', 'validation', `act artifact is not registered: ${artifactId}`, {
        module: 'core.act-port',
      })
    }
    const state: ActState = {
      source,
      phase: 'starting',
      final: undefined,
      inFlight: false,
      stopRequested: false,
      business: undefined,
      ops: new Map(),
      results: [],
      startedAt: Date.now(),
      cleanupUntil: undefined,
      lastUpdateAt: 0,
    }
    this.current = state
    void this.begin(state, args)
    return {
      poll: () => this.poll(state),
      stop: () => this.requestStop(state),
      cleanup: () => this.drive(state),
    }
  }

  dispose(): void {
    const state = this.current
    if (state === undefined || state.phase === 'terminal') return
    this.stopOperations(state)
    state.phase = 'terminal'
    state.final = { status: 'cancelled' }
  }

  private async begin(state: ActState, args: Record<string, JsonValue>): Promise<void> {
    try {
      await this.load(state.source)
      if (state.phase !== 'starting') return
      const result = await this.client.actStart(state.source.artifactId, args)
      state.phase = 'running'
      this.applyHook(state, result)
    } catch (error) {
      this.fail(state, asP2Error(error, 'core.act-port'))
    }
  }

  private load(source: ActSource): Promise<void> {
    const existing = this.loaded.get(source.artifactId)
    if (existing !== undefined) return existing
    const promise = this.client.load('act', source.artifactId, source.code).then(() => undefined)
    this.loaded.set(source.artifactId, promise)
    promise.catch(() => this.loaded.delete(source.artifactId))
    return promise
  }

  private poll(state: ActState): ActPoll {
    if (state.final !== undefined) return state.final
    if (state.phase === 'terminal') return state.final ?? { status: 'cancelled' }
    this.advanceOps(state)
    if (state.phase === 'stopping') return this.drive(state)
    if (this.expired(state)) {
      this.fail(state, p2Error('ACT_TIMEOUT', 'timeout', `act ${state.source.definitionId} exceeded its limit`, {
        module: 'core.act-port',
      }))
      return this.drive(state)
    }
    if (state.phase !== 'running') return state.final ?? { status: 'running' }
    if (state.inFlight) return { status: 'running' }
    const now = Date.now()
    if (now - state.lastUpdateAt < 25) return { status: 'running' }
    state.lastUpdateAt = now
    state.inFlight = true
    const inputs = { handles: state.results.splice(0) }
    void this.client.actUpdate(inputs).then(result => {
      state.inFlight = false
      this.applyHook(state, result)
    }).catch(error => {
      state.inFlight = false
      this.fail(state, asP2Error(error, 'core.act-port'))
    })
    return { status: 'running' }
  }

  private applyHook(state: ActState, result: { kind: string; result?: JsonValue; error?: { code: string; message: string; category?: string } }): void {
    if (state.phase === 'terminal') return
    if (result.kind === 'running') return
    if (result.kind === 'complete') {
      state.business = { ok: true, ...(result.result === undefined ? {} : { value: result.result }) }
      this.beginStop(state, 'completed')
      return
    }
    if (result.kind === 'failed') {
      const error = result.error
      state.business = {
        ok: false,
        error: p2Error(
          error?.code ?? 'ACT_FAILED',
          categoryOf(error?.category),
          error?.message ?? 'act failed',
          { module: 'core.act-port', opId: state.source.definitionId },
        ),
      }
      this.beginStop(state, 'failed')
      return
    }
    this.fail(state, p2Error('ACT_HOOK_INVALID', 'runtime', 'act returned an invalid hook result', {
      module: 'core.act-port',
    }))
  }

  private requestStop(state: ActState): void {
    if (state.phase === 'terminal' || state.stopRequested) return
    state.stopRequested = true
    this.stopOperations(state)
    this.beginStop(state, 'cancelled')
  }

  private beginStop(state: ActState, reason: 'completed' | 'failed' | 'cancelled'): void {
    if (state.phase === 'terminal') return
    state.phase = 'stopping'
    state.cleanupUntil = Date.now() + CLEANUP_TIMEOUT_MS
    this.stopOperations(state)
    void this.runStop(state, reason)
  }

  private async runStop(state: ActState, reason: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    try {
      const stopResult = await this.client.actStop(reason)
      if (stopResult.kind === 'failed') {
        // A failed stop hook still requires broker cleanup; report it after cleanup.
        state.business = state.business ?? { ok: false, error: p2Error('ACT_STOP_FAILED', 'control', stopResult.error?.message ?? 'act stop failed', { module: 'core.act-port' }) }
      }
      await this.runCleanup(state)
    } catch (error) {
      this.fail(state, asP2Error(error, 'core.act-port'))
    }
  }

  private async runCleanup(state: ActState): Promise<void> {
    const deadline = state.cleanupUntil ?? Date.now() + CLEANUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      const result = await this.client.actCleanup({ handles: [] })
      if (result.kind === 'running') {
        await new Promise(resolve => setTimeout(resolve, 20))
        continue
      }
      if (result.kind === 'failed') {
        this.fail(state, p2Error('ACT_STOP_FAILED', 'control', result.error?.message ?? 'act cleanup failed', {
          module: 'core.act-port',
        }))
        return
      }
      this.complete(state)
      return
    }
    this.fail(state, p2Error('ACT_STOP_FAILED', 'timeout', 'act cleanup exceeded its deadline', {
      module: 'core.act-port',
    }))
  }

  private complete(state: ActState): void {
    if (state.phase === 'terminal') return
    state.phase = 'terminal'
    const business = state.business
    if (state.stopRequested && business === undefined) {
      state.final = { status: 'cancelled' }
      return
    }
    if (business === undefined) {
      state.final = { status: 'cancelled' }
      return
    }
    state.final = business.ok
      ? { status: 'succeeded', ...(business.value === undefined ? {} : { result: business.value }) }
      : { status: 'failed', error: business.error ?? p2Error('ACT_FAILED', 'runtime', 'act failed', { module: 'core.act-port' }) }
  }

  private fail(state: ActState, error: P2Error): void {
    if (state.phase === 'terminal') return
    state.phase = 'terminal'
    this.stopOperations(state)
    state.final = { status: 'failed', error }
  }

  private drive(state: ActState): ActPoll {
    return state.final ?? { status: 'running' }
  }

  private expired(state: ActState): boolean {
    const limit = state.source.limits?.totalMs ?? DEFAULT_ACT_LIMIT_MS
    return Date.now() - state.startedAt > limit
  }

  private advanceOps(state: ActState): void {
    for (const [callId, op] of state.ops) {
      if (op.kind === 'done') {
        state.ops.delete(callId)
        continue
      }
      if (op.kind === 'query') {
        const outcome = op.poll()
        if (outcome.status === 'pending') {
          state.ops.set(callId, { callId, kind: 'query', poll: outcome.poll })
          continue
        }
        if (outcome.status === 'failed') this.finishOp(state, callId, false, undefined, outcome.error)
        else this.finishOp(state, callId, true, outcome.value)
        continue
      }
      const result = op.handle.poll()
      if (result.status === 'running') continue
      if (result.status === 'succeeded') this.finishOp(state, callId, true, result.result)
      else if (result.status === 'failed') this.finishOp(state, callId, false, undefined, result.error)
      else this.finishOp(state, callId, false, undefined, result.error ?? p2Error('OP_CANCELLED', 'control', 'operation was cancelled', { module: 'core.act-port' }))
    }
  }

  private finishOp(state: ActState, callId: number, ok: boolean, value?: JsonValue, error?: P2Error): void {
    state.ops.delete(callId)
    state.results.push({
      id: callId,
      status: ok ? 'ok' : 'failed',
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
    })
  }

  private stopOperations(state: ActState): void {
    for (const op of state.ops.values()) {
      if (op.kind !== 'control') continue
      try { op.handle.stop() } catch { /* best effort; broker still cleans up */ }
    }
    state.ops.clear()
  }
}

function asOpArgs(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw p2Error('INVALID_OP_ARGS', 'validation', 'operation arguments must be a JSON object', { module: 'core.act-port' })
  }
  return value as Record<string, JsonValue>
}

function asP2Error(error: unknown, module: string): P2Error {
  if (error instanceof RunnerError) {
    return p2Error(error.code, error.code === 'ACT_TIMEOUT' ? 'timeout' : 'runtime', error.message, { module })
  }
  if (typeof error === 'object' && error !== null && typeof (error as P2Error).code === 'string') {
    return error as P2Error
  }
  return p2Error('ACT_RUNTIME_ERROR', 'runtime', error instanceof Error ? error.message : String(error), { module })
}

function categoryOf(category: string | undefined): P2Error['category'] {
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
