/**
 * Fact readers shared by strategies. They only parse observation-bus values;
 * a missing or malformed field returns `undefined` so the strategy reports
 * `unknown` instead of guessing.
 */

import type { JsonValue } from '../../contracts/types.ts'

export type PositionFact = {
  x: number
  y: number
  z: number
  dimension?: string
  inWater?: boolean
  oxygen?: number
}

export type BlockFact = {
  name: string
  x: number
  y: number
  z: number
}

export type EntityFact = {
  id?: number
  name: string
  kind?: string
  x: number
  y: number
  z: number
  distance?: number
}

export function readPosition(value: JsonValue | undefined): PositionFact | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (typeof record.x !== 'number' || typeof record.y !== 'number' || typeof record.z !== 'number') return undefined
  return {
    x: record.x,
    y: record.y,
    z: record.z,
    ...(typeof record.dimension === 'string' ? { dimension: record.dimension } : {}),
    ...(typeof record.inWater === 'boolean' ? { inWater: record.inWater } : {}),
    ...(typeof record.oxygen === 'number' ? { oxygen: record.oxygen } : {}),
  }
}

export function readBlocks(value: JsonValue | undefined): BlockFact[] | undefined {
  if (!Array.isArray(value)) return undefined
  const blocks: BlockFact[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === undefined) return undefined
    if (typeof record.name !== 'string'
      || typeof record.x !== 'number'
      || typeof record.y !== 'number'
      || typeof record.z !== 'number') return undefined
    blocks.push({ name: record.name, x: record.x, y: record.y, z: record.z })
  }
  return blocks
}

export function readEntities(value: JsonValue | undefined): EntityFact[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entities: EntityFact[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === undefined) return undefined
    if (typeof record.name !== 'string') return undefined
    const position = asRecord(record.position)
    if (position === undefined) return undefined
    if (typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') return undefined
    entities.push({
      name: record.name,
      x: position.x,
      y: position.y,
      z: position.z,
      ...(typeof record.id === 'number' ? { id: record.id } : {}),
      ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
      ...(typeof record.distance === 'number' ? { distance: record.distance } : {}),
    })
  }
  return entities
}

export function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
}

export function distanceBetween(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
}


