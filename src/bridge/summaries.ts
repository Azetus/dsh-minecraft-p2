import type { JsonValue } from '../contracts/index.ts'

/** Pure inventory summary; the provider stays raw. */
export type InventorySummary = {
  items: Array<{ name: string; count: number }>
  total: number
  distinct: number
  byName: Record<string, number>
}

export function summarizeInventory(value: JsonValue): InventorySummary {
  const items: Array<{ name: string; count: number }> = []
  const byName: Record<string, number> = {}
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as Record<string, JsonValue>
      if (typeof record.name !== 'string' || record.name.length === 0) continue
      if (typeof record.count !== 'number' || !Number.isFinite(record.count)) continue
      const count = Math.max(0, Math.trunc(record.count))
      items.push({ name: record.name, count })
      byName[record.name] = (byName[record.name] ?? 0) + count
    }
  }
  const total = items.reduce((sum, item) => sum + item.count, 0)
  return { items, total, distinct: Object.keys(byName).length, byName }
}

export type EntitySummary = {
  count: number
  hostile: number
  nearestDistance: number | null
}

/** Pure entity summary over the provider's `entities` view. */
export function summarizeEntities(value: JsonValue): EntitySummary {
  let count = 0
  let hostile = 0
  let nearestDistance: number | null = null
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      count += 1
      const record = entry as Record<string, JsonValue>
      if (record.kind === 'Hostile mobs') hostile += 1
      if (typeof record.distance === 'number' && Number.isFinite(record.distance)) {
        nearestDistance = nearestDistance === null ? record.distance : Math.min(nearestDistance, record.distance)
      }
    }
  }
  return { count, hostile, nearestDistance }
}
