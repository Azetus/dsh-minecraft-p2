import {
  OBSERVE_MAX_AXIS,
  OBSERVE_MAX_BLOCKS,
  isRecord,
  p2Error,
} from '../contracts/protocol.ts'
import type {
  ObserveVec3,
  WorldObserveBlock,
  WorldObserveResult,
} from '../contracts/protocol.ts'
import { ErrorCodes } from '../contracts/types.ts'
import type { P2Error } from '../contracts/types.ts'
import type { Box, ClientPort } from '../port/index.ts'

/**
 * Read-only observation for the Agent. It never takes a write token and never
 * calls an act method: the same bytes in must leave the world untouched.
 *
 * Caps are part of the contract: a huge box is rejected instead of silently
 * truncating, because an Agent must not mistake a partial view for a full one.
 */
export function observeWorld(
  port: ClientPort,
  params: Record<string, unknown>,
  at: number,
): WorldObserveResult {
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
  if (params.includeEntities !== undefined && typeof params.includeEntities !== 'boolean') {
    throw observeError('includeEntities must be a boolean')
  }

  const box: Box = { min, max }
  const self = port.self()
  const time = port.time()
  const inventory = port.inventory().map(item => ({ slot: item.slot, name: item.name, count: item.count }))

  const blocks: WorldObserveBlock[] = []
  for (const block of port.blocksIn(box)) {
    if (block.pos === undefined) {
      throw p2Error(
        ErrorCodes.INTERNAL_ERROR,
        'runtime',
        'blocksIn returned a block without a position',
        { module: 'body.observe' },
      )
    }
    blocks.push({
      x: block.pos.x,
      y: block.pos.y,
      z: block.pos.z,
      name: block.name,
      loaded: block.loaded,
      ...(block.state === undefined ? {} : { state: { ...block.state } }),
    })
  }

  const result: WorldObserveResult = {
    at,
    box,
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
    blocks,
  }
  if (params.includeEntities !== false) {
    result.entities = port.entities(box).map(entity => ({
      id: entity.id,
      name: entity.name,
      position: { ...entity.position },
    }))
  }
  return result
}

function readVec(value: unknown, label: string): ObserveVec3 {
  if (!isRecord(value)) throw observeError(`${label} must be an object`)
  const x = readInt(value.x, `${label}.x`)
  const y = readInt(value.y, `${label}.y`)
  const z = readInt(value.z, `${label}.z`)
  return { x, y, z }
}

function readInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw observeError(`${label} must be a finite number`)
  }
  return Math.floor(value)
}

function observeError(message: string, details?: Record<string, number>): P2Error {
  return p2Error(ErrorCodes.INVALID_MESSAGE, 'validation', message, { module: 'body.observe' }, details)
}
