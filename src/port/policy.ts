import { isRecord } from '../contracts/protocol.ts'
import type { Vec3 } from './types.ts'

/** Dynamic, per-order break authorization. */
export type UnstickBlock = Vec3 & { name: string }

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

export function parseUnstickBlocks(value: unknown): UnstickBlock[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2) return null
  const result: UnstickBlock[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || !['x', 'y', 'z'].every(k => Number.isInteger(entry[k]))
      || typeof entry.name !== 'string' || entry.name.length === 0) return null
    result.push({ x: entry.x, y: entry.y, z: entry.z, name: entry.name.replace(/^minecraft:/u, '') })
  }
  return result
}
