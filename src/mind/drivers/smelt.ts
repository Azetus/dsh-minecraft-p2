import type { ClientPort, Vec3 } from '../../port/index.ts'
import type { SchemaNode } from '../schema.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle, sleep } from './handle.ts'

export const SMELT_DRIVER_ID = 'smelt'

const POSITION: SchemaNode = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
}

const SMELT_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    furnace: POSITION,
    chest: POSITION,
    input: { type: 'string' },
    fuel: { type: 'string' },
    output: { type: 'string' },
    count: { type: 'number' },
  },
  required: ['furnace', 'chest'],
  additionalProperties: false,
}

type SmeltParams = {
  furnace: Vec3
  chest: Vec3
  input?: string
  fuel?: string
  output?: string
  count?: number
}

function position(value: unknown): Vec3 | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.x !== 'number' || typeof record.y !== 'number' || typeof record.z !== 'number') return undefined
  return { x: record.x, y: record.y, z: record.z }
}

/** Withdraw ore/fuel, smelt in the Agent-selected furnace, deposit the product. */
export function createSmeltDriver(): Driver {
  return {
    id: SMELT_DRIVER_ID,
    schema: SMELT_SCHEMA,
    defaults: {
      budget: { maxTicks: 1_200, maxWallMs: 60_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as SmeltParams
      if (position(params.furnace) === undefined || position(params.chest) === undefined) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      return new AsyncDriverHandle('smelt', smelt(ctx.port, job.params as unknown as SmeltParams))
    },
  }
}

async function smelt(port: ClientPort, params: SmeltParams): Promise<DriverResult> {
  const furnace = position(params.furnace)
  const chest = position(params.chest)
  if (furnace === undefined || chest === undefined) return { state: 'failed', code: 'BAD_ARGS' }
  const input = params.input ?? 'raw_iron'
  const fuel = params.fuel ?? 'coal'
  const output = params.output ?? 'iron_ingot'
  const count = Math.max(1, Math.floor(params.count ?? 1))

  const toChest = await port.moveTo(chest, { range: 4, intent: 'interact', timeoutMs: 20_000 })
  if (toChest.state !== 'ok') return { state: 'failed', code: toChest.code ?? 'SMELT_MOVE_CHEST' }

  for (const [item, itemCount] of [[input, count], [fuel, count]] as const) {
    const withdrawn = await port.containerTransfer(chest, 'withdraw', item, itemCount)
    if (withdrawn.state !== 'ok') {
      return { state: 'failed', code: withdrawn.code ?? 'SMELT_WITHDRAW_FAILED' }
    }
  }

  const toFurnace = await port.moveTo(furnace, { range: 4, intent: 'interact', timeoutMs: 20_000 })
  if (toFurnace.state !== 'ok') return { state: 'failed', code: toFurnace.code ?? 'SMELT_MOVE_FURNACE' }

  const loadedInput = await port.containerTransfer(furnace, 'load-input', input, count)
  if (loadedInput.state !== 'ok') {
    return { state: 'failed', code: loadedInput.code ?? 'SMELT_LOAD_INPUT' }
  }
  const loadedFuel = await port.containerTransfer(furnace, 'load-fuel', fuel, count)
  if (loadedFuel.state !== 'ok') {
    return { state: 'failed', code: loadedFuel.code ?? 'SMELT_LOAD_FUEL' }
  }

  const deadline = Date.now() + 25_000
  let produced = false
  while (Date.now() < deadline) {
    const check = await port.containerAt(furnace)
    if (check.state === 'ok' && check.items.some(item => item.name === output && item.count >= count)) {
      produced = true
      break
    }
    await sleep(500)
  }
  if (!produced) return { state: 'failed', code: 'SMELT_NO_OUTPUT' }

  const taken = await port.containerTransfer(furnace, 'take-output')
  if (taken.state !== 'ok') return { state: 'failed', code: taken.code ?? 'SMELT_TAKE_OUTPUT' }

  const back = await port.moveTo(chest, { range: 4, intent: 'interact', timeoutMs: 20_000 })
  if (back.state !== 'ok') return { state: 'failed', code: back.code ?? 'SMELT_RETURN_FAILED' }
  const deposited = await port.containerTransfer(chest, 'deposit', output, count)
  if (deposited.state !== 'ok') {
    return { state: 'failed', code: deposited.code ?? 'SMELT_DEPOSIT_FAILED' }
  }

  return {
    state: 'succeeded',
    observed: { kind: 'smelt', input, fuel, output, count, furnace, chest },
  }
}
