import {
  ENTITIES_MAX_LIMIT,
  ENTITIES_MAX_RADIUS,
  isRecord,
  p2Error,
} from '../contracts/protocol.ts'
import type {
  ObserveVec3,
  WorldEntitiesParams,
  WorldEntitiesResult,
  WorldEntityView,
} from '../contracts/protocol.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { P2Error } from '../contracts/types.ts'
import type { ClientPort } from '../port/index.ts'

/**
 * Entity-only observation. It reuses the client's tracked entity set, so it
 * needs no movement and no block-volume budget; the server tracking range
 * (not rendering) is the real limit.
 */
export function observeEntities(
  port: ClientPort,
  params: Record<string, unknown>,
  at: number,
): WorldEntitiesResult {
  const self = port.self()
  const center = params.center === undefined
    ? { x: Math.floor(self.pos.x), y: Math.floor(self.pos.y), z: Math.floor(self.pos.z) }
    : readVec(params.center, 'center')
  const radius = readNumber(params.radius, 'radius', 64, 0, ENTITIES_MAX_RADIUS)
  const limit = readInteger(params.limit, 'limit', 128, 1, ENTITIES_MAX_LIMIT)
  const types = readNames(params.types, 'types', 16)
  const names = readNames(params.names, 'names', 32)

  const raw = port.entities({
    min: { x: center.x - radius, y: center.y - radius, z: center.z - radius },
    max: { x: center.x + radius, y: center.y + radius, z: center.z + radius },
  })
  const filtered: Array<WorldEntityView & { distance: number }> = []
  for (const entity of raw) {
    if (types !== undefined && !types.includes(entity.type ?? '')) continue
    if (names !== undefined && !names.includes(entity.name)) continue
    const distance = Math.hypot(
      entity.position.x - center.x,
      entity.position.y - center.y,
      entity.position.z - center.z,
    )
    filtered.push({
      id: entity.id,
      name: entity.name,
      ...(entity.type === undefined ? {} : { type: entity.type }),
      ...(entity.kind === undefined ? {} : { kind: entity.kind }),
      ...(entity.username === undefined ? {} : { username: entity.username }),
      ...(entity.item === undefined ? {} : { item: { ...entity.item } }),
      position: { ...entity.position },
      distance: Math.round(distance * 100) / 100,
    })
  }
  filtered.sort((left, right) => left.distance - right.distance)
  return {
    at,
    center,
    radius,
    total: filtered.length,
    entities: filtered.slice(0, limit),
  }
}

function readVec(value: unknown, label: string): ObserveVec3 {
  if (!isRecord(value)) throw invalid(`${label} must be an object`)
  return {
    x: readInteger(value.x, `${label}.x`, 0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    y: readInteger(value.y, `${label}.y`, 0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    z: readInteger(value.z, `${label}.z`, 0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  }
}

function readNumber(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${label} must be a finite number`)
  if (value < min || value > max) throw invalid(`${label} must be between ${min} and ${max}`)
  return value
}

function readInteger(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(`${label} must be an integer`)
  if (value < min || value > max) throw invalid(`${label} must be between ${min} and ${max}`)
  return value
}

function readNames(value: unknown, label: string, max: number): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw invalid(`${label} must be an array of strings`)
  }
  if (value.length > max) throw invalid(`${label} exceeds ${max} entries`)
  return value as string[]
}

function invalid(message: string): P2Error {
  return p2Error(ErrorCodes.INVALID_MESSAGE, 'validation', message, { module: 'body.entities' })
}
