/**
 * Strategy port and versioned registry (P2CONTROLLER §5, M2).
 *
 * Strategies are replaceable content: they propose actions and verdicts but
 * never dispatch, never hold the lease and never start a run. The registry
 * separates "installed" from "taken over": a newly installed version is
 * pending until the controller gives it the slot at a boundary or after an
 * interrupt, and it gets a fresh attempt id, so results from the old attempt
 * are fenced off.
 */

import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import type { ActionOutcome, ActionRequest, HazardClass, SlotId } from './types.ts'
import type { Diagnostic, EvidenceRef } from './commitment.ts'
import type { FactSet } from './observation.ts'
import type { ActionMemory } from './memory.ts'
import type { CommitmentView } from './commitment.ts'

export type Progress = {
  step?: string
  fraction?: number
  detail?: JsonValue
}

export type StrategyVerdict =
  | { kind: 'idle' }
  | { kind: 'unknown'; missing: string[] }
  | { kind: 'propose'; intent: string; action: ActionRequest }
  | { kind: 'running'; intent: string; progress?: Progress }
  | { kind: 'wait'; until: string; deadlineMs: number }
  | {
    kind: 'recover'
    reason: string
    leasePriority: 'interrupt' | 'boundary'
    /** Optional recovery action; without one the commitment only re-verifies. */
    action?: ActionRequest
    hazardClass?: HazardClass
  }
  | { kind: 'candidate-complete'; evidence: EvidenceRef[] }
  | { kind: 'blocked'; missing: string[]; since: number; diagnostics: Diagnostic[] }

export type StrategyPhase = 'normal' | 'verifying' | 'recovering'

export type StrategyLastOutcome = {
  intent: string
  status: ActionOutcome['status']
  at: number
  attemptId?: string
  result?: JsonValue
  error?: P2Error
}

export type StrategyContext = {
  now: number
  slot: SlotId
  phase: StrategyPhase
  attemptId: string
  /** Reads only coherent, usable facts; unknown keys come back with reasons. */
  facts(keys: readonly string[], options?: { freshSince?: number }): FactSet
  memory: ActionMemory
  commitment?: CommitmentView
  activeAction?: { intent: string; act: string; holder: string; attemptId?: string }
  lastOutcome?: StrategyLastOutcome
  request(intent: string, act: string, args?: Record<string, JsonValue>): ActionRequest
  propose(intent: string, act: string, args?: Record<string, JsonValue>): StrategyVerdict
  diagnostic(code: string, message: string, detail?: JsonValue): Diagnostic
  /** Persist cross-tick progress into the owning commitment's checkpoint. */
  saveCheckpoint(patch: JsonValue): void
  /** Evidence reference for a fact this strategy actually read. */
  evidence(factKey: string): EvidenceRef
}

export interface Strategy {
  readonly key: string
  readonly version: string
  readonly slot: SlotId
  readonly hazardClass?: HazardClass
  evaluate(context: StrategyContext): StrategyVerdict
  /** Versions whose saved state this version may adopt explicitly. */
  readonly compatibleWith?: readonly string[]
  migrate?(state: JsonValue, fromVersion: string): JsonValue | undefined
}

export type InstallMode = 'boundary' | 'interrupt'

export type StrategyBindingState = 'active' | 'pending-takeover' | 'pending-interrupt'

export type StrategyBinding = {
  key: string
  slot: SlotId
  registration: number
  /** The version that was installed, whether or not it has taken over. */
  installedVersion: string
  /** The version currently allowed to propose actions. */
  activeVersion: string
  attemptId: string
  installedAt: number
  activatedAt: number
  state: StrategyBindingState
  hazardClass?: HazardClass
  /** Evaluated for diagnosis only; never allowed to take the lease. */
  shadow?: boolean
  pending?: { strategy: Strategy; mode: InstallMode; installedAt: number } | undefined
}

export type InstallResult = {
  status: 'installed' | 'unchanged' | 'pending-boundary' | 'pending-interrupt'
  key: string
  attemptId: string
}

export type StrategyRegistryOptions = {
  now?: () => number
  maxStrategies?: number
}

const DEFAULT_MAX_STRATEGIES = 16

export class StrategyRegistry {
  private readonly bindings = new Map<string, StrategyBinding>()
  private readonly activeStrategies = new Map<string, Strategy>()
  private readonly now: () => number
  private readonly maxStrategies: number
  private sequence = 0
  private attemptSequence = 0

  constructor(options: StrategyRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxStrategies = options.maxStrategies ?? DEFAULT_MAX_STRATEGIES
  }

  install(strategy: Strategy, mode: InstallMode = 'boundary', at = this.now(), shadow = false): InstallResult {
    const existing = this.bindings.get(strategy.key)
    if (existing === undefined) {
      if (this.bindings.size >= this.maxStrategies) {
        throw p2Error('STRATEGY_LIMIT', 'control', `at most ${this.maxStrategies} strategies are supported`, {
          module: 'controller.strategy',
        })
      }
      const binding: StrategyBinding = {
        key: strategy.key,
        slot: strategy.slot,
        registration: ++this.sequence,
        installedVersion: strategy.version,
        activeVersion: strategy.version,
        attemptId: this.nextAttemptId(strategy),
        installedAt: at,
        activatedAt: at,
        state: 'active',
        ...(shadow ? { shadow: true } : {}),
        ...(strategy.hazardClass === undefined ? {} : { hazardClass: strategy.hazardClass }),
      }
      this.bindings.set(strategy.key, binding)
      this.activeStrategies.set(strategy.key, strategy)
      return { status: 'installed', key: strategy.key, attemptId: binding.attemptId }
    }
    if (existing.installedVersion === strategy.version && existing.pending === undefined) {
      return { status: 'unchanged', key: strategy.key, attemptId: existing.attemptId }
    }
    existing.installedVersion = strategy.version
    existing.pending = { strategy, mode, installedAt: at }
    existing.state = mode === 'interrupt' ? 'pending-interrupt' : 'pending-takeover'
    return {
      status: mode === 'interrupt' ? 'pending-interrupt' : 'pending-boundary',
      key: strategy.key,
      attemptId: existing.attemptId,
    }
  }

  /**
   * Give the pending version the slot. A new attempt id is minted, so late
   * results tagged with the previous attempt cannot move the new one.
   */
  takeOver(key: string, at = this.now()): { strategy: Strategy; attemptId: string; previousVersion: string; previousAttemptId: string } | undefined {
    const binding = this.bindings.get(key)
    if (binding === undefined || binding.pending === undefined) return undefined
    const pending = binding.pending
    const previousVersion = binding.activeVersion
    const previousAttemptId = binding.attemptId
    this.activeStrategies.set(key, pending.strategy)
    binding.activeVersion = pending.strategy.version
    binding.state = 'active'
    binding.activatedAt = at
    binding.pending = undefined
    binding.attemptId = this.nextAttemptId(pending.strategy)
    return {
      strategy: pending.strategy,
      attemptId: binding.attemptId,
      previousVersion,
      previousAttemptId,
    }
  }

  uninstall(key: string): boolean {
    const existed = this.bindings.delete(key)
    this.activeStrategies.delete(key)
    return existed
  }

  binding(key: string): StrategyBinding | undefined {
    return this.bindings.get(key)
  }

  /** Active strategies for one slot, in registration order. */
  active(slot: SlotId): Array<{ strategy: Strategy; binding: StrategyBinding }> {
    const result: Array<{ strategy: Strategy; binding: StrategyBinding }> = []
    for (const binding of this.bindings.values()) {
      if (binding.slot !== slot) continue
      const strategy = this.activeStrategies.get(binding.key)
      if (strategy === undefined) continue
      result.push({ strategy, binding })
    }
    return result.sort((left, right) => left.binding.registration - right.binding.registration)
  }

  pending(): StrategyBinding[] {
    return [...this.bindings.values()].filter(binding => binding.pending !== undefined)
  }

  summaries(): Array<{
    key: string
    slot: SlotId
    state: StrategyBindingState
    installedVersion: string
    activeVersion: string
    attemptId: string
    hazardClass?: HazardClass
    shadow?: boolean
  }> {
    return [...this.bindings.values()].map(binding => ({
      key: binding.key,
      slot: binding.slot,
      state: binding.state,
      installedVersion: binding.installedVersion,
      activeVersion: binding.activeVersion,
      attemptId: binding.attemptId,
      ...(binding.hazardClass === undefined ? {} : { hazardClass: binding.hazardClass }),
      ...(binding.shadow === true ? { shadow: true } : {}),
    }))
  }

  /** Whether a strategy version may adopt the saved state of `fromVersion`. */
  canMigrate(strategy: Strategy, fromVersion: string): boolean {
    return strategy.compatibleWith?.includes(fromVersion) === true
  }

  private nextAttemptId(strategy: Strategy): string {
    return `${strategy.key}@${strategy.version}#${++this.attemptSequence}`
  }
}



