import type { JsonValue } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import type { ActHandle, ActPoll, QueryOutcome, QueryPort } from './node-runtime.ts'
import { requireCapability, requireOperation } from '../operation/index.ts'

/** A concrete operation implementation, normally the Minecraft provider. */
export type OpSource = {
  /** Capabilities the provider actually implements; omitted means "trust the declaration". */
  capabilities?: readonly string[]
  start(name: string, args: Record<string, JsonValue>): ActHandle
  query(op: string, args: Record<string, JsonValue>): QueryOutcome
}

export type OpBrokerOptions = {
  /** Optional per-operation budget for one run; omitted means unlimited. */
  budgets?: Record<string, number>
}

type ActiveControl = { name: string; handle: ActHandle }

/**
 * Validates every operation against the core declaration, keeps at most one
 * active *exclusive* control effect and counts budgeted operations. The trusted
 * provider stays behind this seam; generated code never talks to it directly.
 *
 * Operations declared `concurrent` (for example `jump`) may run alongside one
 * exclusive control, which is what makes jump-then-place pillaring possible.
 */
export class DeclaredOpBroker {
  private readonly active = new Set<ActiveControl>()
  private readonly used = new Map<string, number>()
  private readonly budgets: Record<string, number>

  constructor(private readonly source: OpSource, options: OpBrokerOptions = {}) {
    this.budgets = options.budgets ?? {}
  }

  get activeName(): string | undefined {
    for (const entry of this.active) {
      if (entry.handle.poll().status === 'running') return entry.name
    }
    return undefined
  }

  start(name: string, args: Record<string, JsonValue>): ActHandle {
    const contract = requireOperation(name, 'control', 'core.op-broker')
    if (this.source.capabilities !== undefined) {
      requireCapability(contract, this.source.capabilities, 'core.op-broker')
    }
    if (name === 'stop') {
      // `stop` releases every active control; it is still trackable itself.
      this.stopAll()
    } else if (contract.concurrent !== true) {
      const running = this.runningExclusive()
      if (running !== undefined) {
        throw p2Error('OP_BUSY', 'runtime', `control operation ${running} is still active`, {
          module: 'core.op-broker',
        }, { operation: running })
      }
    }
    this.consume(name)
    const handle = this.source.start(name, args)
    const state: ActiveControl = { name, handle }
    this.active.add(state)
    return {
      poll: (): ActPoll => {
        const result = handle.poll()
        if (result.status !== 'running') this.active.delete(state)
        return result
      },
      stop: (): void => {
        handle.stop()
        this.active.delete(state)
      },
      ...(handle.cleanup === undefined ? {} : {
        cleanup: (): ActPoll => {
          const result = handle.cleanup?.() ?? { status: 'running' as const }
          if (result.status !== 'running') this.active.delete(state)
          return result
        },
      }),
    }
  }

  queryPort(): QueryPort {
    return (ref, args) => this.query(ref.op, args)
  }

  query(op: string, args: Record<string, JsonValue>): QueryOutcome {
    const contract = requireOperation(op, 'query', 'core.op-broker')
    if (this.source.capabilities !== undefined) {
      requireCapability(contract, this.source.capabilities, 'core.op-broker')
    }
    return this.source.query(op, args)
  }

  /** Stop every active control effect during shutdown; never throws. */
  dispose(): void {
    this.stopAll()
  }

  private stopAll(): void {
    for (const entry of this.active) {
      try {
        entry.handle.stop()
      } catch {
        // Shutdown is best effort; the provider still clears control states.
      }
    }
    this.active.clear()
  }

  /** First running control that is not declared concurrent, if any. */
  private runningExclusive(): string | undefined {
    for (const entry of this.active) {
      if (entry.handle.poll().status !== 'running') continue
      if (requireOperation(entry.name, 'control', 'core.op-broker').concurrent !== true) return entry.name
    }
    return undefined
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
