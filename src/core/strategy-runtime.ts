/**
 * In-body strategy module loader/evaluator.
 *
 * Strategy code is single-file and pure: it is loaded once per attempt in a vm
 * context, then evaluated per tick with a JSON input and a JSON verdict. No
 * host functions, handles or timers cross the boundary. This is the same
 * in-process isolation baseline as JS behaviors; it is not a security boundary
 * until the isolated runner migration.
 */

import vm from 'node:vm'

import type { StrategyArtifact } from '../contracts/ir.ts'
import { parseStrategyManifest } from '../contracts/strategy.ts'
import type { StrategyManifest } from '../contracts/strategy.ts'
import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue } from '../contracts/types.ts'

export const DEFAULT_STRATEGY_EVAL_TIMEOUT_MS = 20

export type LoadedStrategy = {
  artifact: StrategyArtifact
  manifest: StrategyManifest
  /** Evaluate one JSON input; returns a JSON verdict (throws on timeout/error). */
  evaluate: (input: JsonValue) => JsonValue
}

export type StrategyRuntimeOptions = {
  timeoutMs?: number
}

type StrategySandbox = {
  __evaluate?: (input: JsonValue) => unknown
  __input?: JsonValue
}

export class StrategyRuntime {
  private readonly timeoutMs: number

  constructor(options: StrategyRuntimeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_STRATEGY_EVAL_TIMEOUT_MS
  }

  get evaluationTimeoutMs(): number {
    return this.timeoutMs
  }

  load(artifact: StrategyArtifact): LoadedStrategy {
    let captured: unknown
    const moduleContext = vm.createContext({
      defineStrategy: (value: unknown) => { captured = value },
    })
    try {
      vm.runInContext(artifact.code, moduleContext, { timeout: this.timeoutMs, filename: `${artifact.definitionId}.strategy.js` })
    } catch (error) {
      throw p2Error('STRATEGY_LOAD_FAILED', 'validation', messageOf(error), { module: 'core.strategy-runtime' }, {
        definitionId: artifact.definitionId,
      })
    }
    if (typeof captured !== 'object' || captured === null) {
      throw p2Error('INVALID_STRATEGY_MANIFEST', 'validation', 'strategy must call defineStrategy', {
        module: 'core.strategy-runtime',
      })
    }
    const module = captured as { evaluate?: unknown }
    if (typeof module.evaluate !== 'function') {
      throw p2Error('INVALID_STRATEGY_MANIFEST', 'validation', 'strategy must export evaluate(ctx)', {
        module: 'core.strategy-runtime',
      })
    }
    const manifest = parseStrategyManifest((captured as { manifest?: unknown }).manifest)
    const evaluate = module.evaluate as (input: JsonValue) => unknown
    const sandbox = vm.createContext({ __evaluate: evaluate, __input: null }) as StrategySandbox
    return {
      artifact,
      manifest,
      evaluate: input => this.run(sandbox, input),
    }
  }

  private run(sandbox: StrategySandbox, input: JsonValue): JsonValue {
    // Structured clone through JSON: the strategy can mutate its copy only.
    sandbox.__input = JSON.parse(JSON.stringify(input)) as JsonValue
    let result: unknown
    try {
      result = vm.runInContext('__evaluate(__input)', sandbox, { timeout: this.timeoutMs })
    } catch (error) {
      const timeout = error instanceof Error && /timed out/u.test(error.message)
      throw p2Error(
        timeout ? 'STRATEGY_TIMEOUT' : 'STRATEGY_EVAL_FAILED',
        timeout ? 'timeout' : 'runtime',
        messageOf(error),
        { module: 'core.strategy-runtime' },
      )
    }
    if (typeof result === 'object' && result !== null && typeof (result as { then?: unknown }).then === 'function') {
      throw p2Error('STRATEGY_ASYNC', 'validation', 'strategy evaluate must be synchronous', {
        module: 'core.strategy-runtime',
      })
    }
    try {
      return JSON.parse(JSON.stringify(result ?? null)) as JsonValue
    } catch (error) {
      throw p2Error('INVALID_STRATEGY_VERDICT', 'validation', `strategy verdict is not JSON: ${messageOf(error)}`, {
        module: 'core.strategy-runtime',
      })
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
