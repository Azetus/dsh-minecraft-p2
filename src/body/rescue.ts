import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue } from '../contracts/types.ts'
import type { QueryOutcome } from '../core/node-runtime.ts'
import type { RescueParams, RescueResult } from '../contracts/protocol.ts'

export type RescueProvider = {
  query(op: string, args?: Record<string, JsonValue>): QueryOutcome
  sendCommand(command: string): void
}

export type RescueOptions = {
  allowRescue: boolean
  tpRadius: number
  auditPath: string
  owner: string
}

const EFFECTS = new Set(['instant_health', 'regeneration', 'saturation'])
const CATEGORIES = new Set(['stuck', 'trapped', 'death_loop', 'health', 'food', 'other'])

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw p2Error('RESCUE_INVALID', 'validation', `${field} must be a finite number`, { module: 'body.rescue' })
  }
  return value
}

/** Build a normalized, allow-listed command; never accept arbitrary command text. */
export function buildRescueCommand(
  params: RescueParams,
  position: { x: number; y: number; z: number },
  tpRadius: number,
): string {
  if (typeof params.reason !== 'string' || params.reason.trim().length < 3) {
    throw p2Error('RESCUE_INVALID', 'validation', 'rescue reason is required', { module: 'body.rescue' })
  }
  if (!CATEGORIES.has(params.category)) {
    throw p2Error('RESCUE_INVALID', 'validation', 'rescue category is invalid', { module: 'body.rescue' })
  }
  if (params.action === 'tp') {
    const x = requireFinite(params.x, 'x')
    const y = requireFinite(params.y, 'y')
    const z = requireFinite(params.z, 'z')
    if (y < -64 || y > 320) {
      throw p2Error('RESCUE_INVALID', 'validation', 'teleport y is outside the world', { module: 'body.rescue' })
    }
    const distance = Math.hypot(x - position.x, y - position.y, z - position.z)
    if (distance > tpRadius) {
      throw p2Error(
        'RESCUE_TOO_FAR',
        'validation',
        `teleport distance ${distance.toFixed(1)} exceeds ${tpRadius}`,
        { module: 'body.rescue' },
      )
    }
    return `/tp @s ${x} ${y} ${z}`
  }
  if (params.action === 'effect') {
    if (typeof params.effect !== 'string' || !EFFECTS.has(params.effect)) {
      throw p2Error('RESCUE_INVALID', 'validation', 'effect is not allowed', { module: 'body.rescue' })
    }
    const duration = params.durationSeconds === undefined ? 5 : Math.floor(requireFinite(params.durationSeconds, 'durationSeconds'))
    const amplifier = params.amplifier === undefined ? 0 : Math.floor(requireFinite(params.amplifier, 'amplifier'))
    if (duration < 1 || duration > 10 || amplifier < 0 || amplifier > 1) {
      throw p2Error('RESCUE_INVALID', 'validation', 'effect duration or amplifier is out of range', { module: 'body.rescue' })
    }
    return `/effect give @s minecraft:${params.effect} ${duration} ${amplifier}`
  }
  if (params.action === 'respawn') return '/kill @s'
  throw p2Error('RESCUE_INVALID', 'validation', 'unknown rescue action', { module: 'body.rescue' })
}

export async function executeRescue(
  provider: RescueProvider,
  params: RescueParams,
  options: RescueOptions,
): Promise<RescueResult> {
  if (!options.allowRescue) {
    throw p2Error('RESCUE_DISABLED', 'capability', 'rescue commands are disabled in this body', { module: 'body.rescue' })
  }
  const position = provider.query('position', {})
  if (position.status !== 'ok') throw p2Error('RESCUE_UNAVAILABLE', 'environment', 'position is unavailable', { module: 'body.rescue' })
  const value = position.value as { x?: number; y?: number; z?: number } | null
  if (value === null || typeof value.x !== 'number' || typeof value.y !== 'number' || typeof value.z !== 'number') {
    throw p2Error('RESCUE_UNAVAILABLE', 'environment', 'position is incomplete', { module: 'body.rescue' })
  }
  const health = provider.query('health', {})
  const command = buildRescueCommand(params, { x: value.x, y: value.y, z: value.z }, options.tpRadius)
  provider.sendCommand(command)
  const auditId = randomUUID()
  const record = {
    auditId,
    at: new Date().toISOString(),
    owner: options.owner,
    action: params.action,
    command,
    reason: params.reason,
    category: params.category,
    before: {
      position: position.value,
      health: health.status === 'ok' ? health.value : null,
    },
  }
  await mkdir(dirname(options.auditPath), { recursive: true })
  await appendFile(options.auditPath, `${JSON.stringify(record)}\n`, 'utf8')
  return {
    auditId,
    command,
    sent: true,
    before: record.before,
    note: 'command sent; verify the effect with position/health queries',
  }
}


