import type { JsonValue } from '../contracts/types.ts'
import { p2Error } from '../contracts/protocol.ts'
import type { ActHandle, ActPoll, QueryOutcome, QueryPort, ReleaseStatus } from './node-runtime.ts'
import { requireCapability, requireOperation } from '../operation/index.ts'
import type { OperationContract } from '../operation/index.ts'
import type { TraceSink, TraceToken } from './trace.ts'

/** Identity stamped on a registered control intent; late messages carry it too. */
export type ControlIdentity = {
  runId: string
  actInstanceId: string
  /** Monotonic control-authority generation for the owning run. */
  generation: number
}

/** Provider-visible control state; `unknown` means "cannot confirm release". */
export type ProviderControlState = 'idle' | 'active' | 'unknown'

export type { ReleaseStatus }

/** A concrete operation implementation, normally the Minecraft provider. */
export type OpSource = {
  /** Capabilities the provider actually implements; omitted means "trust the declaration". */
  capabilities?: readonly string[] | undefined
  /**
   * Declaration of an activated authored op. When absent the broker falls back
   * to the static operation catalog (which includes developer-mode operations).
   */
  contract?(name: string): OperationContract | undefined
  start(name: string, args: Record<string, JsonValue>, identity?: ControlIdentity): ActHandle
  query(op: string, args: Record<string, JsonValue>): QueryOutcome
  /**
   * Reports whether the provider still holds any control effect. Omitted means
   * the broker can only trust its own handle ledger.
   */
  controlState?(): ProviderControlState
}

export type OpBrokerOptions = {
  /** Optional per-operation budget for one run; omitted means unlimited. */
  budgets?: Record<string, number>
  /** Quiet window between "handles idle + provider idle" and `released`. */
  settleMs?: number
  /** Total stop deadline measured from the first `stopRun`. */
  stopTimeoutMs?: number
  trace?: TraceSink
  now?: () => number
}

type EntryPhase = 'active' | 'stopping' | 'unknown'

type ControlEntry = {
  id: string
  name: string
  identity: ControlIdentity | undefined
  handle: ActHandle | undefined
  phase: EntryPhase
}

type ReleaseTracking = {
  deadline: number
  idleSince: number | undefined
  unconfirmed: boolean
  /** The run whose release this tracking covers; undefined means "any run". */
  runId: string | undefined
  /** An untracked control effect exists, so release can never be proven. */
  unconfirmable: boolean
}

const DEFAULT_SETTLE_MS = 300
const DEFAULT_STOP_TIMEOUT_MS = 2000

/**
 * Validates every operation against the core declaration, keeps at most one
 * active *exclusive* control effect and counts budgeted operations. The trusted
 * provider stays behind this seam; generated code never talks to it directly.
 *
 * Control bookkeeping is two-phase: the intent is registered before the
 * provider is asked to start, and the returned handle is attached afterwards.
 * A start that throws leaves an `unknown` intent behind, so release stays
 * unconfirmed instead of silently dropping a possibly-live effect. Stopping a
 * handle keeps its ledger entry until `pollRelease()` proves the effect is gone.
 *
 * Operations declared `concurrent` (for example `jump`) may run alongside one
 * exclusive control, which is what makes jump-then-place pillaring possible.
 */
export class DeclaredOpBroker {
  private readonly entries = new Set<ControlEntry>()
  private readonly used = new Map<string, number>()
  private readonly untrackedRuns = new Set<string>()
  private untrackedAnonymous = false
  private readonly budgets: Record<string, number>
  private readonly settleMs: number
  private readonly stopTimeoutMs: number
  private readonly trace: TraceSink | undefined
  private readonly now: () => number
  private sequence = 0
  private release: ReleaseTracking | undefined

  constructor(private readonly source: OpSource, options: OpBrokerOptions = {}) {
    this.budgets = options.budgets ?? {}
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
    this.trace = options.trace
    this.now = options.now ?? Date.now
  }

  get activeName(): string | undefined {
    for (const entry of this.entries) {
      if (entry.phase !== 'active' || entry.handle === undefined) continue
      if (entry.handle.poll().status === 'running') return entry.name
    }
    return undefined
  }

  start(name: string, args: Record<string, JsonValue>, identity?: ControlIdentity): ActHandle {
    const contract = this.contractOf(name, 'control')
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
    const entry: ControlEntry = {
      id: `op-${++this.sequence}`,
      name,
      identity,
      handle: undefined,
      phase: 'active',
    }
    // Intent is visible before the provider can act; a throw still leaves a
    // record that release must account for.
    this.entries.add(entry)
    const startedAt = this.now()
    const token = this.trace?.begin('op', name, {
      ...(identity === undefined ? {} : { runId: identity.runId }),
      opId: name,
      detail: { opKind: 'control' },
    })
    let handle: ActHandle
    try {
      handle = this.source.start(name, args, identity)
    } catch (error) {
      this.trace?.finish(token, 'error')
      entry.phase = 'unknown'
      throw error
    }
    this.trace?.finish(token, 'end')
    entry.handle = handle
    const limitMs = contract.limits?.totalMs
    let terminalReported = false
    const reportTerminal = (result: ActPoll): void => {
      if (terminalReported || result.status === 'running') return
      terminalReported = true
      this.trace?.record('op', 'end', name, {
        ...(identity === undefined ? {} : { runId: identity.runId }),
        opId: entry.id,
        durationMs: this.now() - startedAt,
        detail: { opKind: 'control', status: result.status },
      })
    }
    return {
      ...(handle.cleanup === undefined ? {} : {
        cleanup: (): ActPoll => {
          const result = handle.cleanup?.() ?? { status: 'running' as const }
          reportTerminal(result)
          if (result.status !== 'running') this.entries.delete(entry)
          return result
        },
      }),
      poll: (): ActPoll => {
        // Declared budget: fail the operation and request release, but keep the
        // ledger entry until the provider proves the effect is gone.
        if (limitMs !== undefined && !terminalReported && this.now() - startedAt > limitMs) {
          // Keep the entry in the ledger: it still polls running until the
          // provider proves the effect is gone, so a new control stays blocked.
          if (entry.phase !== 'stopping' && entry.phase !== 'unknown') {
            try {
              handle.stop()
            } catch {
              entry.phase = 'unknown'
            }
          }
          terminalReported = true
          const error = p2Error(
            'OP_TIMEOUT',
            'timeout',
            `control operation ${name} exceeded ${limitMs}ms`,
            { module: 'core.op-broker', opId: name },
            { operation: name, limitMs },
          )
          this.trace?.record('op', 'error', name, {
            ...(identity === undefined ? {} : { runId: identity.runId }),
            opId: entry.id,
            durationMs: this.now() - startedAt,
            detail: { opKind: 'control', code: 'OP_TIMEOUT' },
          })
          return { status: 'failed', error }
        }
        const result = handle.poll()
        reportTerminal(result)
        if (result.status !== 'running') this.entries.delete(entry)
        return result
      },
      stop: (): void => {
        if (entry.phase === 'unknown') return
        // Keep the ledger entry: only pollRelease() may conclude it is gone.
        entry.phase = 'stopping'
        try {
          handle.stop()
        } catch (error) {
          entry.phase = 'unknown'
          throw error
        }
      },
    }
  }

  queryPort(): QueryPort {
    return (ref, args) => this.query(ref.op, args)
  }

  query(op: string, args: Record<string, JsonValue>): QueryOutcome {
    const contract = this.contractOf(op, 'query')
    if (this.source.capabilities !== undefined) {
      requireCapability(contract, this.source.capabilities, 'core.op-broker')
    }
    const token = this.trace?.begin('op', op, { opId: op, detail: { opKind: 'query' } })
    let outcome: QueryOutcome
    try {
      outcome = this.source.query(op, args)
    } catch (error) {
      this.trace?.finish(token, 'error')
      throw error
    }
    if (outcome.status === 'pending') return this.tracePendingQuery(token, outcome)
    this.trace?.finish(token, outcome.status === 'failed' ? 'error' : 'end')
    return outcome
  }

  /** Keep a query span open until the provider settles the pending request. */
  private tracePendingQuery(
    token: TraceToken | undefined,
    outcome: Extract<QueryOutcome, { status: 'pending' }>,
  ): QueryOutcome {
    if (token === undefined) return outcome
    const poll = (): QueryOutcome => {
      const next = outcome.poll()
      if (next.status === 'pending') return { status: 'pending', poll }
      this.trace?.finish(token, next.status === 'failed' ? 'error' : 'end')
      return next
    }
    return { status: 'pending', poll }
  }

  /** Aggregate control state from tracked handles and the provider. */
  controlState(): ProviderControlState {
    let unknownIntent = false
    for (const entry of this.entries) {
      if (entry.phase === 'unknown') {
        if (entry.handle === undefined) {
          unknownIntent = true
          continue
        }
        try {
          if (entry.handle.poll().status === 'running') return 'active'
          this.entries.delete(entry)
        } catch {
          unknownIntent = true
        }
        continue
      }
      if (entry.phase === 'active' && entry.handle === undefined) return 'active'
      if (entry.handle === undefined) continue
      if (entry.handle.poll().status === 'running') return 'active'
      this.entries.delete(entry)
    }
    const provider = this.source.controlState?.()
    if (unknownIntent) return 'unknown'
    return provider ?? 'idle'
  }

  /**
   * Record a control effect the ledger cannot track (an authored op called the
   * provider directly). The run's release conclusion becomes unconfirmable.
   */
  markUntracked(runId?: string): void {
    if (runId === undefined || runId.length === 0) this.untrackedAnonymous = true
    else this.untrackedRuns.add(runId)
    if (this.release === undefined) return
    if (runId === undefined || this.release.runId === undefined || this.release.runId === runId) {
      this.release.unconfirmable = true
    }
  }

  /** Runs that left at least one untracked control effect. */
  get untrackedControl(): readonly string[] {
    return [...this.untrackedRuns]
  }

  /** True when any untracked control effect exists (attributed or anonymous). */
  get hasUntrackedControl(): boolean {
    return this.untrackedAnonymous || this.untrackedRuns.size > 0
  }

  /**
   * Begin releasing a run's controls. The deadline is established once; later
   * calls do not reset it and only re-request stop for still-active entries.
   */
  stopRun(now = Date.now(), runId?: string): void {
    this.release ??= {
      deadline: now + this.stopTimeoutMs,
      idleSince: undefined,
      unconfirmed: false,
      runId,
      unconfirmable: this.untrackedApplies(runId),
    }
    if (this.untrackedApplies(runId)) this.release.unconfirmable = true
    for (const entry of this.entries) {
      if (runId !== undefined && entry.identity !== undefined && entry.identity.runId !== runId) continue
      if (entry.phase === 'unknown' || entry.phase === 'stopping') continue
      entry.phase = 'stopping'
      try {
        entry.handle?.stop()
      } catch {
        entry.phase = 'unknown'
      }
    }
  }

  /**
   * Poll release progress. `released` requires every tracked handle to be
   * non-running, provider state `idle`, and the settle window to elapse.
   * `unconfirmed` is sticky past the deadline but a later idle observation can
   * still release it.
   */
  pollRelease(now = Date.now()): ReleaseStatus {
    const tracking = this.release
    if (tracking === undefined) {
      return this.entries.size === 0 ? 'idle' : 'stopping'
    }
    // An untracked effect can end, but nothing proves it did: never report
    // `released` for this run.
    if (tracking.unconfirmable) return 'unconfirmed'
    const observed = this.observe()
    if (observed === 'idle') {
      tracking.idleSince ??= now
      if (now - tracking.idleSince >= this.settleMs) {
        this.release = undefined
        this.entries.clear()
        return 'released'
      }
      if (now >= tracking.deadline) tracking.unconfirmed = true
      return tracking.unconfirmed ? 'unconfirmed' : 'stopping'
    }
    tracking.idleSince = undefined
    if (now >= tracking.deadline) tracking.unconfirmed = true
    return tracking.unconfirmed ? 'unconfirmed' : 'stopping'
  }

  /** True while a release has been requested but not yet concluded. */
  get releasePending(): boolean {
    return this.release !== undefined
  }

  /** Stop every active control effect during shutdown; never throws. */
  dispose(): void {
    this.stopAll()
    this.entries.clear()
    this.release = undefined
    this.untrackedRuns.clear()
    this.untrackedAnonymous = false
  }

  private untrackedApplies(runId: string | undefined): boolean {
    if (this.untrackedAnonymous) return true
    return runId === undefined ? this.untrackedRuns.size > 0 : this.untrackedRuns.has(runId)
  }

  private contractOf(name: string, kind: 'query' | 'control'): OperationContract {
    const contract = this.source.contract?.(name)
    if (contract === undefined) return requireOperation(name, kind, 'core.op-broker')
    if (contract.kind !== kind) {
      throw p2Error(
        'OP_KIND_MISMATCH',
        'validation',
        `operation ${name} is ${contract.kind}, not ${kind}`,
        { module: 'core.op-broker', opId: name },
        { operation: name, expected: kind, actual: contract.kind },
      )
    }
    return contract
  }

  private observe(): ProviderControlState {
    let running = false
    let unknownIntent = false
    for (const entry of this.entries) {
      if (entry.phase === 'unknown') {
        if (entry.handle === undefined) {
          unknownIntent = true
          continue
        }
        // A handle whose stop threw may still be running; poll it instead of
        // trusting the cancel flag or an idle provider verdict.
        try {
          if (entry.handle.poll().status === 'running') {
            running = true
          } else {
            this.entries.delete(entry)
          }
        } catch {
          unknownIntent = true
        }
        continue
      }
      if (entry.handle === undefined) continue
      try {
        if (entry.handle.poll().status === 'running') {
          running = true
        } else {
          this.entries.delete(entry)
        }
      } catch {
        entry.phase = 'unknown'
        unknownIntent = true
      }
    }
    if (running) return 'active'
    const provider = this.source.controlState?.()
    if (provider === 'active' || provider === 'unknown') return provider
    // Without a provider verdict an unknown intent cannot be confirmed gone.
    if (unknownIntent && provider === undefined) return 'unknown'
    return provider ?? 'idle'
  }

  private stopAll(): void {
    for (const entry of this.entries) {
      if (entry.phase === 'unknown' || entry.phase === 'stopping') continue
      entry.phase = 'stopping'
      try {
        entry.handle?.stop()
      } catch {
        entry.phase = 'unknown'
        continue
      }
      if (entry.handle === undefined) continue
      try {
        // Drop the entry as soon as the provider proves the handle is idle;
        // a handle that still polls running stays for release accounting.
        if (entry.handle.poll().status !== 'running') this.entries.delete(entry)
      } catch {
        entry.phase = 'unknown'
      }
    }
  }

  /** First running control that is not declared concurrent, if any. */
  private runningExclusive(): string | undefined {
    for (const entry of this.entries) {
      if (entry.phase === 'unknown') return entry.name
      if (entry.phase !== 'active' || entry.handle === undefined) continue
      if (entry.handle.poll().status !== 'running') {
        this.entries.delete(entry)
        continue
      }
      if (this.contractOf(entry.name, 'control').concurrent !== true) return entry.name
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
