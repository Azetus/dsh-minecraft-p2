import type { JsonValue } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import type { ActHandle, ActPoll, ActPort, QueryOutcome, QueryPort } from './node-runtime.ts'
import { requireOperation } from '../operation/index.ts'

/** A concrete operation implementation, normally the Minecraft provider. */
export type OpSource = {
  start(name: string, args: Record<string, JsonValue>): ActHandle
  query(op: string, args: Record<string, JsonValue>): QueryOutcome
}

export type OpBrokerOptions = {
  /** Optional per-operation budget for one run; omitted means unlimited. */
  budgets?: Record<string, number>
}

/**
 * Validates every operation against the core declaration, keeps at most one
 * active control effect and counts budgeted operations. The trusted provider
 * stays behind this seam; generated code never talks to it directly.
 */
export class DeclaredOpBroker implements ActPort {
  private active: { name: string; handle: ActHandle } | undefined
  private readonly used = new Map<string, number>()
  private readonly budgets: Record<string, number>

  constructor(private readonly source: OpSource, options: OpBrokerOptions = {}) {
    this.budgets = options.budgets ?? {}
  }

  get activeName(): string | undefined {
    return this.active?.handle.poll().status === 'running' ? this.active.name : undefined
  }

  start(name: string, args: Record<string, JsonValue>): ActHandle {
    requireOperation(name, 'control', 'core.op-broker')
    if (this.active !== undefined && this.active.handle.poll().status === 'running') {
      throw p2Error('OP_BUSY', 'runtime', `control operation ${this.active.name} is still active`, {
        module: 'core.op-broker',
      }, { operation: this.active.name })
    }
    this.consume(name)
    const handle = this.source.start(name, args)
    const state = { name, handle }
    this.active = state
    return {
      poll: (): ActPoll => {
        const result = handle.poll()
        if (result.status !== 'running' && this.active === state) this.active = undefined
        return result
      },
      stop: (): void => {
        handle.stop()
      },
      ...(handle.cleanup === undefined ? {} : {
        cleanup: (): ActPoll => {
          const result = handle.cleanup?.() ?? { status: 'running' as const }
          if (result.status !== 'running' && this.active === state) this.active = undefined
          return result
        },
      }),
    }
  }

  queryPort(): QueryPort {
    return (ref, args) => this.query(ref.op, args)
  }

  query(op: string, args: Record<string, JsonValue>): QueryOutcome {
    requireOperation(op, 'query', 'core.op-broker')
    return this.source.query(op, args)
  }

  /** Stop the active control effect during shutdown; never throws. */
  dispose(): void {
    try {
      this.active?.handle.stop()
    } catch {
      // Shutdown is best effort; the provider still clears control states.
    }
    this.active = undefined
  }

  private consume(name: string): void {
    const limit = this.budgets[name]
    if (limit === undefined) return
    const used = this.used.get(name) ?? 0
    if (used >= limit) {
      throw p2Error('BUDGET_EXCEEDED', 'runtime', `operation budget exhausted: ${name}`, {
        module: 'core.op-broker',
      }, { operation: name, limit, used })
    }
    this.used.set(name, used + 1)
  }
}
