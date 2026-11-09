import { isRecord } from '../contracts/protocol.ts'
import type { JsonValue } from '../contracts/types.ts'

export type ConflictMode = 'skip' | 'clear' | 'abort'

export type ConflictPolicy = {
  mode: ConflictMode
  allow?: string[]
  deny?: string[]
}

export type MaterialMode = 'require-all' | 'auto-gather'

export type MaterialPolicy = {
  mode: MaterialMode
  maxGatherBlocks?: number
}

/** Agent-level fatal-exit policy; never consumed by the motion core. */
export const HAZARD_KINDS = ['void', 'lethal_fall', 'lava'] as const
export type HazardKind = (typeof HAZARD_KINDS)[number]
export type HazardPolicy = { allow: HazardKind[]; reason?: string }

/** undefined = absent; null = invalid. */
export function parseHazardPolicy(value: unknown): HazardPolicy | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (key !== 'allow' && key !== 'reason') return null
  }
  if (!Array.isArray(value.allow) || value.allow.length === 0) return null
  const allow: HazardKind[] = []
  for (const entry of value.allow) {
    if (typeof entry !== 'string' || !(HAZARD_KINDS as readonly string[]).includes(entry)) return null
    if (!allow.includes(entry as HazardKind)) allow.push(entry as HazardKind)
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') return null
  return {
    allow,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  }
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
    if (key !== 'conflict' && key !== 'materials' && key !== 'hazards') {
      return { ok: false, error: `policy.${key} is not supported` }
    }
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

export type MaterialPolicyParse =
  | { ok: true; policy: MaterialPolicy | undefined }
  | { ok: false; error: string }

export function parseMaterialPolicy(value: JsonValue | undefined): MaterialPolicyParse {
  if (value === undefined) return { ok: true, policy: undefined }
  if (!isRecord(value)) return { ok: false, error: 'policy must be an object' }
  const materials = value.materials
  if (materials === undefined) return { ok: true, policy: undefined }
  if (!isRecord(materials)) return { ok: false, error: 'policy.materials must be an object' }
  for (const key of Object.keys(materials)) {
    if (!['mode', 'maxGatherBlocks'].includes(key)) {
      return { ok: false, error: `policy.materials.${key} is unknown` }
    }
  }
  const mode = materials.mode ?? 'require-all'
  if (mode !== 'require-all' && mode !== 'auto-gather') {
    return { ok: false, error: 'policy.materials.mode must be require-all or auto-gather' }
  }
  const max = materials.maxGatherBlocks
  if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 0)) {
    return { ok: false, error: 'policy.materials.maxGatherBlocks must be a non-negative integer' }
  }
  return {
    ok: true,
    policy: {
      mode,
      ...(max === undefined ? {} : { maxGatherBlocks: max as number }),
    },
  }
}
