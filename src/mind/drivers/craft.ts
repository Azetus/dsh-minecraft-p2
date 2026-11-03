import type { SchemaNode } from '../schema.ts'
import { approachBlock } from '../approach.ts'
import type { JsonValue } from '../../contracts/types.ts'
import type { ClientPort, Vec3 } from '../../port/index.ts'
import type { Driver, DriverCtx, DriverResult, DriverValidation, Job, WorldView } from '../types.ts'
import { failureBody, readFailure, withFailure } from '../failure.ts'
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
      return new AsyncDriverHandle(`craft:${params.item}:${params.count ?? 1}`, craft(ctx, params).then(result => attachCraftFailure(result, params)))
    },
  }
}

async function craft(ctx: DriverCtx, params: CraftParams): Promise<DriverResult> {
  const count = params.count ?? 1
  const before = countItem(ctx.port.inventory(), params.item)
  let result = await ctx.port.craft(params.item, count)
  if (result.state === 'failed' && result.code === 'CRAFT_NO_TABLE') {
    const table = findCraftingTable(ctx.port)
    if (table === undefined) {
      return { state: 'failed', code: 'CRAFT_NO_TABLE', observed: craftEvidence(result.observed, params.item, count, before, countItem(ctx.port.inventory(), params.item)) }
    }
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
  const after = countItem(ctx.port.inventory(), params.item)
  const evidence = craftEvidence(result.observed, params.item, count, before, after)
  // The provider proves how many crafts ran and how many items it produced;
  // prefer that over a driver-side guess so a partial batch is never silent.
  const produced = numericField(result.observed, 'produced') ?? (after - before)
  if (result.state !== 'ok') {
    // A provider may stop its loop early (e.g. a recipe yields >1 item) yet
    // still have produced the requested result. The result contract is about
    // the postcondition, not the provider's operation count.
    if (result.state === 'failed' && produced >= count) return { state: 'succeeded', observed: evidence }
    return { state: 'failed', code: result.code ?? 'CRAFT_FAILED', observed: evidence }
  }
  if (produced < count) return { state: 'failed', code: 'CRAFT_INCOMPLETE', observed: evidence }
  return { state: 'succeeded', observed: evidence }
}

/**
 * `attempted` is the requested craft count, `crafted` the provider's executed
 * batches (falling back to the inventory delta), and `produced` the item count.
 * A partial batch is reported with these numbers instead of a bare failure.
 */
function craftEvidence(
  upstream: JsonValue | undefined,
  item: string,
  attempted: number,
  before: number,
  after: number,
): JsonValue {
  const evidence: Record<string, JsonValue> = {
    kind: 'craft',
    item,
    count: attempted,
    attempted,
    before,
    after,
    crafted: numericField(upstream, 'crafted') ?? (after - before),
    produced: numericField(upstream, 'produced') ?? (after - before),
  }
  for (const key of ['produced', 'requested', 'usedTable', 'requiresTable', 'recipeCount'] as const) {
    const value = field(upstream, key)
    if (value !== undefined) evidence[key] = value
  }
  return evidence
}

function field(upstream: JsonValue | undefined, key: string): JsonValue | undefined {
  if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream)) return undefined
  return (upstream as Record<string, JsonValue>)[key]
}

function numericField(upstream: JsonValue | undefined, key: string): number | undefined {
  const value = field(upstream, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

function attachCraftFailure(result: DriverResult, params: CraftParams): DriverResult {
  if (result.state !== 'failed' || readFailure(result.observed) !== undefined) return result
  const code = result.code ?? 'CRAFT_FAILED'
  const count = params.count ?? 1
  return {
    ...result,
    observed: withFailure(result.observed, failureBody({
      layer: 'driver',
      phase: 'execute',
      code,
      observed: result.observed,
      facts: { item: params.item, count },
      cause: { kind: 'world', code },
      recovery: code === 'CRAFT_INCOMPLETE' ? 'retry' : 'replan',
    })),
  }
}
