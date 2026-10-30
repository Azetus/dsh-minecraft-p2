/**
 * Adapter from a checked strategy artifact to the controller's Strategy port.
 *
 * The artifact sees only plain JSON (facts, commitment view, memory, last
 * outcome) and returns a plain JSON verdict. Identity (slot/holder/attempt),
 * act artifact resolution and evidence references stay on the host side, so
 * authored strategy code cannot forge control ownership.
 */

import type { JsonValue } from '../contracts/types.ts'
import type { StrategyArtifact } from '../contracts/ir.ts'
import type { Strategy, StrategyContext, StrategyVerdict } from './strategy.ts'
import type { Diagnostic, EvidenceRef } from './commitment.ts'

export type StrategyEvaluator = (input: JsonValue) => JsonValue

export type ArtifactStrategyOptions = {
  artifact: StrategyArtifact
  evaluate: StrategyEvaluator
  /** Upper bound for a JSON checkpoint/args blob. */
  maxJsonBytes?: number
}

const DEFAULT_MAX_JSON_BYTES = 16_384

export function createArtifactStrategy(options: ArtifactStrategyOptions): Strategy {
  const { artifact } = options
  const maxBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES

  return {
    key: artifact.definitionId,
    version: artifact.version,
    slot: artifact.slot,
    ...(artifact.hazardClass === undefined ? {} : { hazardClass: artifact.hazardClass }),
    evaluate(context: StrategyContext): StrategyVerdict {
      const facts = context.facts(artifact.facts)
      const input = jsonSafe({
        now: context.now,
        slot: context.slot,
        phase: context.phase,
        attemptId: context.attemptId,
        facts: {
          values: facts.values,
          facts: facts.facts,
          known: facts.known,
          unknown: facts.unknown,
          reasons: facts.reasons,
          coherent: facts.coherent,
          coherenceGapMs: facts.coherenceGapMs,
        },
        memory: context.memory.snapshot(context.now),
        ...(context.commitment === undefined ? {} : { commitment: context.commitment }),
        ...(context.activeAction === undefined ? {} : { activeAction: context.activeAction }),
        ...(context.lastOutcome === undefined ? {} : { lastOutcome: context.lastOutcome }),
      })

      let raw: JsonValue
      try {
        raw = options.evaluate(input)
      } catch (error) {
        return failedVerdict(context, 'STRATEGY_ERROR', messageOf(error))
      }
      if (!isRecord(raw)) return failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'verdict must be an object')
      if (raw.kind !== 'idle'
        && raw.kind !== 'unknown'
        && raw.kind !== 'propose'
        && raw.kind !== 'running'
        && raw.kind !== 'wait'
        && raw.kind !== 'recover'
        && raw.kind !== 'candidate-complete'
        && raw.kind !== 'blocked') {
        return failedVerdict(context, 'INVALID_STRATEGY_VERDICT', `unknown verdict kind: ${String(raw.kind)}`)
      }

      const checkpoint = raw.checkpoint
      if (checkpoint !== undefined) {
        if (!saveCheckpoint(context, checkpoint, maxBytes)) {
          return failedVerdict(context, 'INVALID_CHECKPOINT', 'checkpoint must be JSON under the size limit')
        }
      }

      switch (raw.kind) {
        case 'idle':
          return { kind: 'idle' }
        case 'unknown':
          return { kind: 'unknown', missing: stringArray(raw.missing) }
        case 'propose': {
          const action = readAction(context, artifact, raw)
          if ('error' in action) return action.error
          return { kind: 'propose', intent: action.intent, action: action.request }
        }
        case 'running': {
          if (typeof raw.intent !== 'string' || raw.intent.length === 0) {
            return failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'running.intent is required')
          }
          const progress = isRecord(raw.progress) ? raw.progress : undefined
          return {
            kind: 'running',
            intent: raw.intent,
            ...(progress === undefined ? {} : { progress: progressFrom(progress) }),
          }
        }
        case 'wait': {
          if (typeof raw.until !== 'string' || typeof raw.deadlineMs !== 'number' || raw.deadlineMs <= 0) {
            return failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'wait needs until and a positive deadlineMs')
          }
          return { kind: 'wait', until: raw.until, deadlineMs: raw.deadlineMs }
        }
        case 'recover': {
          if (typeof raw.reason !== 'string') {
            return failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'recover.reason is required')
          }
          if (raw.leasePriority !== 'interrupt' && raw.leasePriority !== 'boundary') {
            return failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'recover.leasePriority must be interrupt or boundary')
          }
          if (raw.action === undefined) {
            return { kind: 'recover', reason: raw.reason, leasePriority: raw.leasePriority }
          }
          const action = readAction(context, artifact, raw)
          if ('error' in action) return action.error
          return { kind: 'recover', reason: raw.reason, leasePriority: raw.leasePriority, action: action.request }
        }
        case 'candidate-complete': {
          const keys = stringArray(raw.evidence)
          if (keys.length === 0) {
            return failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'candidate-complete needs evidence fact keys')
          }
          const evidence: EvidenceRef[] = []
          const missing: string[] = []
          for (const key of keys) {
            if (!artifact.facts.includes(key)) {
              return failedVerdict(context, 'EVIDENCE_UNDECLARED', `evidence fact ${key} is not declared in manifest.facts`)
            }
            if (!facts.known.includes(key)) {
              missing.push(key)
              continue
            }
            evidence.push(context.evidence(key))
          }
          if (missing.length > 0) return { kind: 'unknown', missing }
          return { kind: 'candidate-complete', evidence }
        }
        case 'blocked': {
          const diagnostics = Array.isArray(raw.diagnostics)
            ? raw.diagnostics.filter(isRecord).map(item => diagnosticFrom(context, item))
            : []
          return {
            kind: 'blocked',
            missing: stringArray(raw.missing),
            since: typeof raw.since === 'number' ? raw.since : context.now,
            diagnostics,
          }
        }
        default:
          return failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'unreachable verdict')
      }
    },
  }
}

type ActionRead =
  | { request: ReturnType<StrategyContext['request']>; intent: string }
  | { error: StrategyVerdict }

function readAction(
  context: StrategyContext,
  artifact: StrategyArtifact,
  value: Record<string, JsonValue>,
): ActionRead {
  if (typeof value.intent !== 'string' || value.intent.length === 0 || value.intent.length > 200) {
    return { error: failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'action.intent must be a short non-empty string') }
  }
  if (typeof value.act !== 'string' || value.act.length === 0) {
    return { error: failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'action.act must name a declared act') }
  }
  if (!artifact.acts.includes(value.act)) {
    return { error: failedVerdict(context, 'ACT_UNDECLARED', `act ${value.act} is not declared in manifest.acts`) }
  }
  const actArtifactId = artifact.resolvedActs[value.act]
  if (actArtifactId === undefined) {
    return { error: failedVerdict(context, 'ACT_NOT_RESOLVED', `act ${value.act} has no resolved artifact`) }
  }
  const args = value.args === undefined ? {} : value.args
  if (!isRecord(args)) {
    return { error: failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'action.args must be an object') }
  }
  if (JSON.stringify(args).length > 16_384) {
    return { error: failedVerdict(context, 'INVALID_STRATEGY_VERDICT', 'action.args is too large') }
  }
  return {
    intent: value.intent,
    request: context.request(value.intent, actArtifactId, args),
  }
}

function saveCheckpoint(context: StrategyContext, value: JsonValue, maxBytes: number): boolean {
  const size = JSON.stringify(value).length
  if (size > maxBytes) return false
  context.saveCheckpoint(value)
  return true
}

function failedVerdict(context: StrategyContext, code: string, message: string): StrategyVerdict {
  return {
    kind: 'blocked',
    missing: ['strategy-verdict'],
    since: context.now,
    diagnostics: [context.diagnostic(code, message)],
  }
}

function diagnosticFrom(context: StrategyContext, value: Record<string, JsonValue>): Diagnostic {
  const code = typeof value.code === 'string' ? value.code : 'STRATEGY_DIAGNOSTIC'
  const message = typeof value.message === 'string' ? value.message : code
  const detail = value.detail
  const diagnostic = context.diagnostic(code, message, detail)
  return diagnostic
}

function progressFrom(value: Record<string, JsonValue>): { step?: string; fraction?: number; detail?: JsonValue } {
  return {
    ...(typeof value.step === 'string' ? { step: value.step } : {}),
    ...(typeof value.fraction === 'number' ? { fraction: value.fraction } : {}),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  }
}

function stringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function isRecord(value: JsonValue | unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strip undefined/function fields so strategy input is exactly JSON. */
function jsonSafe(value: unknown): JsonValue {
  const text = JSON.stringify(value)
  return text === undefined ? null : JSON.parse(text) as JsonValue
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}



