import type { SchemaNode } from '../schema.ts'
import { approachBlock } from '../approach.ts'
import type { ClientPort, Vec3 } from '../../port/index.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { AsyncDriverHandle } from './handle.ts'

export const CRAFT_DRIVER_ID = 'craft'

const CRAFT_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    count: { type: 'number' },
  },
  required: ['item'],
  additionalProperties: false,
}

type CraftParams = { item: string; count?: number }

/** Craft one recipe result in a bounded batch; the world is the authority. */
export function createCraftDriver(): Driver {
  return {
    id: CRAFT_DRIVER_ID,
    schema: CRAFT_SCHEMA,
    defaults: {
      budget: { maxTicks: 600, maxWallMs: 45_000 },
      interrupt: 'constant-only',
      suspendable: false,
    },
    validate(job: Job, _world: WorldView): DriverValidation {
      const params = job.params as unknown as CraftParams
      if (typeof params.item !== 'string' || params.item.length === 0) return { ok: false, code: 'BAD_ARGS' }
      if (params.count !== undefined && (!Number.isInteger(params.count) || params.count < 1 || params.count > 64)) {
        return { ok: false, code: 'BAD_ARGS' }
      }
      return { ok: true }
    },
    start(job: Job, ctx: DriverCtx) {
      const params = job.params as unknown as CraftParams
      return new AsyncDriverHandle(`craft:${params.item}:${params.count ?? 1}`, craft(ctx, params))
    },
  }
}

async function craft(ctx: DriverCtx, params: CraftParams): Promise<DriverResult> {
  const count = params.count ?? 1
  const before = countItem(ctx.port.inventory(), params.item)
  let result = await ctx.port.craft(params.item, count)
  if (result.state === 'failed' && result.code === 'CRAFT_NO_TABLE') {
    const table = findCraftingTable(ctx.port)
    if (table === undefined) return { state: 'failed', code: 'CRAFT_NO_TABLE' }
    const approach = await approachBlock(ctx.port, table, {
      range: 2,
      timeoutMs: 12_000,
      code: 'CRAFT_APPROACH_FAILED',
    })
    if (!approach.ok) {
      return {
        state: 'failed',
        code: approach.code,
        ...(approach.observed === undefined ? {} : { observed: approach.observed }),
      }
    }
    result = await ctx.port.craft(params.item, count)
  }
  if (result.state === 'failed') return { state: 'failed', code: result.code ?? 'CRAFT_FAILED' }
  if (result.state === 'unknown') return { state: 'failed', code: result.code ?? 'CLIENT_TIMEOUT' }
  const after = countItem(ctx.port.inventory(), params.item)
  if (after < before + count) return { state: 'failed', code: 'CRAFT_READBACK_MISMATCH' }
  return {
    state: 'succeeded',
    observed: { kind: 'craft', item: params.item, count, before, after },
  }
}

function findCraftingTable(port: ClientPort): Vec3 | undefined {
  const self = port.self().pos
  const feet = { x: Math.floor(self.x), y: Math.floor(self.y), z: Math.floor(self.z) }
  const blocks = port.blocksIn({
    min: { x: feet.x - 16, y: feet.y - 8, z: feet.z - 16 },
    max: { x: feet.x + 16, y: feet.y + 8, z: feet.z + 16 },
  }, ['crafting_table'])
  return blocks.find(block => block.pos !== undefined)?.pos
}

function countItem(inventory: Array<{ name: string; count: number }>, name: string): number {
  return inventory.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
}
