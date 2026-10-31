import { isRecord } from '../contracts/protocol.ts'
import type { JsonValue } from '../contracts/types.ts'

export type ConflictMode = 'skip' | 'clear' | 'abort'

export type ConflictPolicy = {
  mode: ConflictMode
  allow?: string[]
  deny?: string[]
}

export const DEFAULT_DENY: ReadonlySet<string> = new Set([
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
  'hopper', 'dropper', 'dispenser', 'brewing_stand', 'enchanting_table',
  'beacon', 'spawner', 'bedrock', 'obsidian',
])

export type ConflictPolicyParse =
  | { ok: true; policy: ConflictPolicy | undefined }
  | { ok: false; error: string }

export function parseConflictPolicy(value: JsonValue | undefined): ConflictPolicyParse {
  if (value === undefined) return { ok: true, policy: undefined }
  if (!isRecord(value)) return { ok: false, error: 'policy must be an object' }
  for (const key of Object.keys(value)) {
    if (key !== 'conflict') return { ok: false, error: `policy.${key} is not supported` }
  }
  const conflict = value.conflict
  if (conflict === undefined) return { ok: true, policy: undefined }
  if (!isRecord(conflict)) return { ok: false, error: 'policy.conflict must be an object' }
  for (const key of Object.keys(conflict)) {
    if (!['mode', 'allow', 'deny'].includes(key)) {
      return { ok: false, error: `policy.conflict.${key} is unknown` }
    }
  }
  const mode = conflict.mode ?? 'skip'
  if (mode !== 'skip' && mode !== 'clear' && mode !== 'abort') {
    return { ok: false, error: 'policy.conflict.mode must be skip, clear or abort' }
  }
  const allow = readNames(conflict.allow, 'policy.conflict.allow')
  if (!allow.ok) return allow
  const deny = readNames(conflict.deny, 'policy.conflict.deny')
  if (!deny.ok) return deny
  return {
    ok: true,
    policy: {
      mode,
      ...(allow.names === undefined ? {} : { allow: allow.names }),
      ...(deny.names === undefined ? {} : { deny: deny.names }),
    },
  }
}

/** Explicit deny wins; explicit allow overrides only the default deny set. */
export function canClearBlock(policy: ConflictPolicy, name: string): boolean {
  const normalized = normalizeName(name)
  if (policy.deny?.includes(normalized) === true) return false
  if (policy.allow?.includes(normalized) === true) return true
  return !DEFAULT_DENY.has(normalized)
}

function readNames(
  value: JsonValue | undefined,
  path: string,
): { ok: true; names?: string[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    return { ok: false, error: `${path} must be an array of block names` }
  }
  return { ok: true, names: value.map(entry => normalizeName(entry as string)) }
}

function normalizeName(name: string): string {
  return name.replace(/^minecraft:/u, '')
}
