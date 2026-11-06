import {
  OBSERVE_FIND_MAX_LIMIT,
  OBSERVE_FIND_MAX_RADIUS,
  OBSERVE_FIND_TOTAL_CAP,
  OBSERVE_MAX_AXIS,
  OBSERVE_MAX_BLOCKS,
  isRecord,
  p2Error,
} from '../contracts/protocol.ts'
import type {
  ObserveVec3,
  WorldFoundBlock,
  WorldObserveBlock,
  WorldObserveCounts,
  WorldObserveResult,
  WorldObserveSurface,
} from '../contracts/protocol.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { P2Error } from '../contracts/types.ts'
import type { Box, ClientPort } from '../port/index.ts'

const MAX_POINTS = 256

/**
 * Read-only observation for the Agent. It never takes a write token and never
 * calls an act method: the same bytes in must leave the world untouched.
 *
 * Three box views keep the reply proportional to the question: exact blocks,
 * name counts, or a per-column surface. A points query is the narrowest.
 * Caps are part of the contract: an oversized request is rejected, never
 * silently truncated.
 */
export function observeWorld(
  port: ClientPort,
  params: Record<string, unknown>,
  at: number,
): WorldObserveResult {
  const self = port.self()
  const time = port.time()
  const inventory = port.inventory().map(item => ({ slot: item.slot, name: item.name, count: item.count }))
  const common = {
    at,
    self: {
      pos: { ...self.pos },
      yaw: self.yaw,
      pitch: self.pitch,
      health: self.health,
      food: self.food,
      onGround: self.onGround,
      inWater: self.inWater,
      inLava: self.inLava,
    },
    inventory,
    time: { ...time },
    biome: port.biomeAt(self.pos),
  }

  const mode = readMode(params.mode)
  if (mode === 'find' || (mode === undefined && params.near !== undefined)) {
    return observeFind(port, params, common, mode)
  }
  if (mode === 'points' || (mode === undefined && params.points !== undefined)) {
    return observePoints(port, params, common, mode)
  }
  return observeBox(port, params, common, mode)
}

type Common = Pick<WorldObserveResult, 'at' | 'self' | 'inventory' | 'time' | 'biome'>

function observeFind(
  port: ClientPort,
  params: Record<string, unknown>,
  common: Common,
  mode: 'find' | undefined,
): WorldObserveResult {
  if (mode !== undefined && mode !== 'find') {
    throw observeError('mode find requires a near query')
  }
  if (params.min !== undefined || params.max !== undefined) {
    throw observeError('find does not accept min/max')
  }
  if (params.points !== undefined) {
    throw observeError('find does not accept points')
  }
  if (params.detail !== undefined || params.excludeAir !== undefined || params.includeEntities !== undefined) {
    throw observeError('find only accepts near, radius, only and limit')
  }
  const near = params.near === undefined ? floorVec(common.self.pos) : readVec(params.near, 'near')
  const radius = readBoundedInt(params.radius, 'radius', 16, 1, OBSERVE_FIND_MAX_RADIUS, 'maxRadius')
  const limit = readBoundedInt(params.limit, 'limit', 5, 1, OBSERVE_FIND_MAX_LIMIT, 'maxLimit')
  const only = readFindOnly(params.only)
  const wanted = new Set(only)
  const raw = port.findBlocks({
    near,
    radius,
    names: only,
    count: OBSERVE_FIND_TOTAL_CAP + 1,
  })
  const matches: Array<{
    cell: ObserveVec3
    name: string
    sort: number
    light?: number
    skyLight?: number
  }> = []
  const radiusSquared = radius * radius
  for (const block of raw) {
    if (!block.loaded || block.pos === undefined) continue
    if (!wanted.has(block.name)) continue
    const cell = { x: block.pos.x, y: block.pos.y, z: block.pos.z }
    const sort = squaredDistance(near, cell)
    if (sort > radiusSquared) continue
    matches.push({
      cell,
      name: block.name,
      sort,
      ...(block.light === undefined ? {} : { light: block.light }),
      ...(block.skyLight === undefined ? {} : { skyLight: block.skyLight }),
    })
  }
  matches.sort((left, right) =>
    left.sort - right.sort
    || left.cell.x - right.cell.x
    || left.cell.y - right.cell.y
    || left.cell.z - right.cell.z)
  const total = Math.min(matches.length, OBSERVE_FIND_TOTAL_CAP)
  const truncated = matches.length > OBSERVE_FIND_TOTAL_CAP
  const blocks: WorldFoundBlock[] = matches.slice(0, limit).map(match => ({
    cell: match.cell,
    name: match.name,
    distance: Math.round(Math.sqrt(match.sort) * 100) / 100,
    ...(match.light === undefined ? {} : { light: match.light }),
    ...(match.skyLight === undefined ? {} : { skyLight: match.skyLight }),
  }))
  return {
    ...common,
    mode: 'find',
    detail: 'find',
    near,
    radius,
    only,
    total,
    truncated,
    blocks,
  }
}

function observePoints(
  port: ClientPort,
  params: Record<string, unknown>,
  common: Common,
  mode: 'points' | undefined,
): WorldObserveResult {
  if (mode !== undefined && mode !== 'points') {
    throw observeError('mode points requires a points query')
  }
  if (params.near !== undefined || params.radius !== undefined || params.limit !== undefined) {
    throw observeError('near/radius/limit apply to find, not points')
  }
  if (!Array.isArray(params.points) || params.points.length === 0) {
    throw observeError('points must be a non-empty array')
  }
  if (params.points.length > MAX_POINTS) {
    throw observeError(`points exceeds ${MAX_POINTS}`, { maxPoints: MAX_POINTS })
  }
  if (params.detail !== undefined && params.detail !== 'blocks') {
    throw observeError('a points query only supports detail=blocks')
  }
  if (params.only !== undefined || params.excludeAir !== undefined) {
    throw observeError('only/excludeAir apply to box queries, not points')
  }
  if (params.min !== undefined || params.max !== undefined) {
    throw observeError('provide either points or min/max, not both')
  }

  const seen = new Set<string>()
  const blocks: WorldObserveBlock[] = []
  for (const value of params.points) {
    const position = readVec(value, 'points[]')
    const key = `${position.x},${position.y},${position.z}`
    if (seen.has(key)) continue
    seen.add(key)
    const block = port.blockAt(position)
    blocks.push(block === null
      ? { ...position, name: '', loaded: false }
      : {
          ...position,
          name: block.name,
          loaded: block.loaded,
          ...(block.solid === undefined ? {} : { solid: block.solid }),
          ...(block.state === undefined ? {} : { state: { ...block.state } }),
          ...(block.light === undefined ? {} : { light: block.light }),
          ...(block.skyLight === undefined ? {} : { skyLight: block.skyLight }),
        })
  }
  return { ...common, mode: 'points', detail: 'points', blocks }
}

function observeBox(
  port: ClientPort,
  params: Record<string, unknown>,
  common: Common,
  mode: 'box' | undefined,
): WorldObserveResult {
  if (mode !== undefined && mode !== 'box') {
    throw observeError('mode box requires min/max')
  }
  if (params.points !== undefined) {
    throw observeError('a box query does not accept points')
  }
  if (params.near !== undefined || params.radius !== undefined || params.limit !== undefined) {
    throw observeError('near/radius/limit apply to find, not box')
  }
  const min = readVec(params.min, 'min')
  const max = readVec(params.max, 'max')
  if (min.x > max.x || min.y > max.y || min.z > max.z) {
    throw observeError('box min must not exceed max')
  }
  const sizeX = max.x - min.x + 1
  const sizeY = max.y - min.y + 1
  const sizeZ = max.z - min.z + 1
  if (sizeX > OBSERVE_MAX_AXIS || sizeY > OBSERVE_MAX_AXIS || sizeZ > OBSERVE_MAX_AXIS) {
    throw observeError(`box axis exceeds ${OBSERVE_MAX_AXIS}`, { maxAxis: OBSERVE_MAX_AXIS })
  }
  const volume = sizeX * sizeY * sizeZ
  if (volume > OBSERVE_MAX_BLOCKS) {
    throw observeError(`box volume ${volume} exceeds ${OBSERVE_MAX_BLOCKS}`, {
      maxBlocks: OBSERVE_MAX_BLOCKS,
    })
  }
  const detail = readDetail(params.detail)
  const only = readOnly(params.only)
  if (params.excludeAir !== undefined && typeof params.excludeAir !== 'boolean') {
    throw observeError('excludeAir must be a boolean')
  }
  const includeEntities = params.includeEntities
  if (includeEntities !== undefined && typeof includeEntities !== 'boolean') {
    throw observeError('includeEntities must be a boolean')
  }

  const box: Box = { min, max }
  const raw = port.blocksIn(box)
  const base: WorldObserveResult = {
    ...common,
    mode: 'box',
    detail,
    box,
  }

  if (detail === 'blocks') {
    const blocks: WorldObserveBlock[] = []
    for (const block of raw) {
      if (block.pos === undefined) {
        throw p2Error(
          ErrorCodes.INTERNAL_ERROR,
          'runtime',
          'blocksIn returned a block without a position',
          { module: 'body.observe' },
        )
      }
      if (block.loaded) {
        if (params.excludeAir === true && isAirName(block.name)) continue
        if (only !== undefined && !only.includes(block.name)) continue
      }
      blocks.push({
        x: block.pos.x,
        y: block.pos.y,
        z: block.pos.z,
        name: block.name,
        loaded: block.loaded,
        ...(block.solid === undefined ? {} : { solid: block.solid }),
        ...(block.state === undefined ? {} : { state: { ...block.state } }),
        ...(block.light === undefined ? {} : { light: block.light }),
        ...(block.skyLight === undefined ? {} : { skyLight: block.skyLight }),
      })
    }
    base.blocks = blocks
  } else if (detail === 'counts') {
    base.counts = countBlocks(raw)
  } else {
    base.surface = surfaceOf(raw, min, max)
  }

  if (includeEntities !== false) {
    base.entities = port.entities(box).map(entity => ({
      id: entity.id,
      name: entity.name,
      position: { ...entity.position },
    }))
  }
  return base
}

function countBlocks(raw: Array<{ name: string; loaded: boolean }>): WorldObserveCounts {
  const byName: Record<string, number> = {}
  let loaded = 0
  let unloaded = 0
  for (const block of raw) {
    if (!block.loaded) {
      unloaded += 1
      continue
    }
    loaded += 1
    byName[block.name] = (byName[block.name] ?? 0) + 1
  }
  return { total: raw.length, loaded, unloaded, byName }
}

function surfaceOf(
  raw: Array<{ name: string; loaded: boolean; solid?: boolean; pos?: ObserveVec3 }>,
  min: ObserveVec3,
  max: ObserveVec3,
): WorldObserveSurface[] {
  type Column = {
    x: number
    z: number
    y: number | null
    name: string | null
    solidY: number | null
    solidName: string | null
    loaded: boolean
  }
  const columns = new Map<string, Column>()
  for (let x = min.x; x <= max.x; x += 1) {
    for (let z = min.z; z <= max.z; z += 1) {
      columns.set(`${x},${z}`, { x, z, y: null, name: null, solidY: null, solidName: null, loaded: true })
    }
  }
  for (const block of raw) {
    if (block.pos === undefined) continue
    const column = columns.get(`${block.pos.x},${block.pos.z}`)
    if (column === undefined) continue
    if (!block.loaded) {
      column.loaded = false
      continue
    }
    if (isAirName(block.name)) continue
    if (column.y === null || block.pos.y > column.y) {
      column.y = block.pos.y
      column.name = block.name
    }
    if (block.solid !== false && (column.solidY === null || block.pos.y > column.solidY)) {
      column.solidY = block.pos.y
      column.solidName = block.name
    }
  }
  for (const column of columns.values()) {
    if (!column.loaded) {
      column.y = null
      column.name = null
      column.solidY = null
      column.solidName = null
    }
  }
  return [...columns.values()]
}

function readVec(value: unknown, label: string): ObserveVec3 {
  if (!isRecord(value)) throw observeError(`${label} must be an object`)
  const x = readInt(value.x, `${label}.x`)
  const y = readInt(value.y, `${label}.y`)
  const z = readInt(value.z, `${label}.z`)
  return { x, y, z }
}

function floorVec(value: ObserveVec3): ObserveVec3 {
  return { x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) }
}

function squaredDistance(left: ObserveVec3, right: ObserveVec3): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2
}

function readMode(value: unknown): 'box' | 'points' | 'find' | undefined {
  if (value === undefined) return undefined
  if (value === 'box' || value === 'points' || value === 'find') return value
  throw observeError('mode must be box, points or find')
}

function readBoundedInt(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
  capKey?: string,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw observeError(`${label} must be an integer`)
  }
  if (value < min || value > max) {
    throw observeError(
      `${label} must be between ${min} and ${max}`,
      capKey === undefined ? undefined : { [capKey]: max },
    )
  }
  return value
}

function readFindOnly(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw observeError('find requires a non-empty only array')
  }
  if (value.some(entry => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw observeError('only must be an array of non-empty block names')
  }
  if (value.length > 32) throw observeError('only exceeds 32 block names', { maxNames: 32 })
  const names = (value as string[]).map(entry => entry.trim().replace(/^minecraft:/u, ''))
  if (names.some(name => name.length === 0)) {
    throw observeError('only must be an array of non-empty block names')
  }
  return [...new Set(names)]
}

function readInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw observeError(`${label} must be a finite number`)
  }
  return Math.floor(value)
}

function readDetail(value: unknown): 'blocks' | 'counts' | 'surface' {
  if (value === undefined) return 'blocks'
  if (value === 'blocks' || value === 'counts' || value === 'surface') return value
  throw observeError('detail must be blocks, counts or surface')
}

function readOnly(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw observeError('only must be an array of block names')
  }
  if (value.length > 32) throw observeError('only exceeds 32 block names', { maxNames: 32 })
  return value as string[]
}

function isAirName(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function observeError(message: string, details?: Record<string, number>): P2Error {
  return p2Error(ErrorCodes.INVALID_MESSAGE, 'validation', message, { module: 'body.observe' }, details)
}
