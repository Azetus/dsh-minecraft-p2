import type { UnstickBlock } from '../body/api.ts'

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
