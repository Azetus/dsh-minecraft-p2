import type { QueryRef } from '../contracts/ir.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import type {
  ActHandle,
  ActPoll,
  ActPort,
  QueryOutcome,
  QueryPort,
} from './node-runtime.ts'

export type ActRunner = (args: Record<string, JsonValue>) => ActHandle

/** Owns the single active act operation and its runner lookup. */
export class ActBroker implements ActPort {
  private readonly runners = new Map<string, ActRunner>()
  private readonly cleanupTimeoutMs: number
  private active: {
    name: string
    handle: ActHandle
    done: boolean
    stopping: boolean
    cleanupAt: number | undefined
  } | undefined

  constructor(options: { cleanupTimeoutMs?: number } = {}) {
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 1000
  }

  register(name: string, runner: ActRunner): void {
    this.runners.set(name, runner)
  }

  get activeName(): string | undefined {
    return this.active?.done === false ? this.active.name : undefined
  }

  start(name: string, args: Record<string, JsonValue>): ActHandle {
    if (this.active !== undefined && !this.active.done) {
      throw p2Error(
        'ACT_BUSY',
        'runtime',
        `act ${this.active.name} is still active`,
        { module: 'core.broker' },
      )
    }
    const runner = this.runners.get(name)
    if (runner === undefined) {
      throw p2Error(
        'ACT_NOT_FOUND',
        'validation',
        `unknown act: ${name}`,
        { module: 'core.broker' },
      )
    }
    const handle = runner(args)
    const state = { name, handle, done: false, stopping: false, cleanupAt: undefined as number | undefined }
    this.active = state
    return {
      ...(handle.cleanup === undefined ? {} : { cleanup: () => handle.cleanup?.() ?? { status: 'running' as const } }),
      poll: (): ActPoll => {
        if (state.stopping) {
          if (state.handle.cleanup === undefined) {
            state.done = true
            return { status: 'cancelled' }
          }
          if (state.cleanupAt !== undefined && Date.now() > state.cleanupAt) {
            state.done = true
            return {
              status: 'failed',
              error: p2Error('STOP_TIMEOUT', 'timeout', 'act cleanup exceeded its deadline', { module: 'core.broker' }),
            }
          }
          const cleanup = state.handle.cleanup()
          if (cleanup.status === 'running') return cleanup
          state.done = true
          if (cleanup.status === 'failed') return cleanup
          return { status: 'cancelled' }
        }
        if (state.done) return { status: 'cancelled' }
        const result = state.handle.poll()
        if (result.status !== 'running') state.done = true
        return result
      },
      stop: (): void => {
        if (state.done || state.stopping) return
        state.stopping = true
        try {
          state.handle.stop()
        } catch (error) {
          state.done = true
          throw p2Error(
            'ACT_STOP_FAILED',
            'runtime',
            error instanceof Error ? error.message : String(error),
            { module: 'core.broker' },
          )
        }
        if (state.handle.cleanup === undefined) {
          state.done = true
        } else {
          state.cleanupAt = Date.now() + this.cleanupTimeoutMs
        }
      },
    }
  }

  stopActive(): void {
    if (this.active === undefined || this.active.done) return
    this.active.stopping = true
    this.active.handle.stop()
    if (this.active.handle.cleanup === undefined) this.active.done = true
    else this.active.cleanupAt = Date.now() + this.cleanupTimeoutMs
  }

  dispose(): void {
    try {
      this.stopActive()
    } catch {
      // Disposal is best effort; the process-level cleanup remains bounded.
    }
  }
}

export type QueryHandler = (args: Record<string, JsonValue>) => QueryOutcome

/** Query lookup with one call per request; failures are never retried here. */
export class QueryBroker {
  private readonly handlers = new Map<string, QueryHandler>()
  private callCount = 0

  register(name: string, handler: QueryHandler): void {
    this.handlers.set(name, handler)
  }

  get calls(): number {
    return this.callCount
  }

  asPort(): QueryPort {
    return (ref, args) => this.query(ref, args)
  }

  query(ref: QueryRef, args: Record<string, JsonValue>): QueryOutcome {
    this.callCount += 1
    const handler = this.handlers.get(ref.op)
    if (handler === undefined) {
      return {
        status: 'failed',
        error: p2Error(
          'QUERY_NOT_FOUND',
          'validation',
          `unknown query op: ${ref.op}`,
          { module: 'core.broker' },
        ),
      }
    }
    try {
      return handler(args)
    } catch (error) {
      return {
        status: 'failed',
        error: toQueryError(error, ref.op),
      }
    }
  }
}

function toQueryError(error: unknown, op: string): P2Error {
  if (isP2Error(error)) return error
  return p2Error(
    'QUERY_FAILED',
    'environment',
    error instanceof Error ? error.message : String(error),
    { module: 'core.broker', opId: op },
  )
}

function isP2Error(value: unknown): value is P2Error {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { code?: unknown }).code === 'string'
    && typeof (value as { message?: unknown }).message === 'string'
}
