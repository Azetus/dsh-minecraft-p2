import type { BlockInfo, ClientPort } from '../../port/index.ts'
import { approachBlock } from '../approach.ts'
import type { SchemaNode } from '../schema.ts'
import { chooseTool } from '../tools.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle, actFailure, sleep } from './handle.ts'

export const CLEAR_DRIVER_ID = 'clear'

const CLEAR_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
}

type ClearParams = { x: number; y: number; z: number }

/**
 * Clear one cell. Toils: observe → dig → readback #1 → readback #2. It never
 * changes target and reports `failed` when the two reads disagree.
 */
export function createClearDriver(): Driver {
  return {
    id: CLEAR_DRIVER_ID,
    schema: CLEAR_SCHEMA,
    defaults: {
      budget: { maxTicks: 200, maxWallMs: 15_000 },
      interrupt: 'constant-only',
      suspendable: true,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as ClearParams
      return Number.isFinite(params.x) && Number.isFinite(params.y) && Number.isFinite(params.z)
        ? { ok: true }
        : { ok: false, code: 'BAD_ARGS' }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as ClearParams
      const key = `clear:${params.x},${params.y},${params.z}`
      const autoEquip = ctx.allowAutoEquip?.() ?? true
      return new AsyncDriverHandle(key, clearCell(ctx.port, params, autoEquip))
    },
  }
}

async function clearCell(port: ClientPort, params: ClearParams, autoEquip: boolean): Promise<DriverResult> {
  const target = { x: params.x, y: params.y, z: params.z }
  const before = port.blockAt(target)
  if (before === null || !before.loaded) {
    return { state: 'failed', code: 'OBSERVATION_UNAVAILABLE' }
  }
  if (isAir(before.name)) return { state: 'succeeded' }

  const choice = chooseTool(before, port.inventory(), 'clear')
  if (choice.error !== undefined) return { state: 'failed', code: choice.error }
  const approach = await approachBlock(port, target, {
    range: 2,
    timeoutMs: 12_000,
    code: 'CLEAR_APPROACH_FAILED',
  })
  if (!approach.ok) {
    return {
      state: 'failed',
      code: approach.code,
      ...(approach.observed === undefined ? {} : { observed: approach.observed }),
    }
  }
  if (choice.item !== undefined && autoEquip) {
    const equipped = await port.equip(choice.item)
    if (equipped.state !== 'ok') return actFailure(equipped, 'EQUIP_FAILED')
  }

  const result = await port.dig(target)
  if (result.state !== 'ok') return actFailure(result, 'DIG_FAILED')

  const first = port.blockAt(target)
  await sleep(200)
  const second = port.blockAt(target)
  if (isAirBlock(first) && isAirBlock(second)) {
    return {
      state: 'succeeded',
      observed: { kind: 'clear', ...target, block: before.name, tool: choice.item ?? null },
    }
  }
  return { state: 'failed', code: 'READBACK_UNSTABLE' }
}

function isAir(name: string): boolean {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function isAirBlock(block: BlockInfo | null): boolean {
  return block !== null && block.loaded && isAir(block.name)
}
