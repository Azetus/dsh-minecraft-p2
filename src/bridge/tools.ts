import type { JsonValue } from '../contracts/index.ts'
import { ORDER_VERBS } from '../mind/orders.ts'
import type { BodyManager } from './process-manager.ts'

export type AgentLike = {
  id: string
  session: {
    id: string
    header?: { cwd?: string }
  }
}

export type ToolRegistration = {
  dispose(): void
}

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: Record<string, unknown>, exec: { agent?: AgentLike; signal?: AbortSignal }) => Promise<JsonValue>
}

export type ToolsService = {
  register(definition: ToolDefinition): () => void
}

/**
 * Agent-scoped observation/control surface. These tools only read P2Mind state
 * or submit orders; they never perform a game action themselves.
 */
export function registerP2Tools(agent: AgentLike, manager: BodyManager, tools: ToolsService): ToolRegistration {
  const disposers = [
    tools.register({
      name: 'p2_status',
      description: 'Current P2 order/job/tracker state plus provider health. Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: output(),
      execute: async () => statusOf(manager, agent),
    }),
    tools.register({
      name: 'p2_observe',
      description: 'Read-only world observation. Box query (min+max, max 4096 blocks) or targeted points (max 256); detail blocks/counts/surface. Unloaded cells are loaded=false, never air. Does not act on the world.',
      parameters: {
        type: 'object',
        properties: {
          min: vecSchema('Box minimum corner, inclusive'),
          max: vecSchema('Box maximum corner, inclusive'),
          points: {
            type: 'array',
            description: 'Targeted query instead of a box; max 256 unique points',
            items: vecSchema('Point'),
            maxItems: 256,
          },
          includeEntities: { type: 'boolean', description: 'Defaults to true for box queries' },
          detail: {
            type: 'string',
            enum: ['blocks', 'counts', 'surface'],
            description: 'Box detail level; counts/surface keep replies small',
          },
          only: {
            type: 'array',
            description: 'Block names to include in a blocks view',
            items: { type: 'string' },
            maxItems: 32,
          },
          excludeAir: { type: 'boolean', description: 'Omit loaded air from a blocks view' },
        },
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        return await manager.worldObserve(args as unknown as JsonValue)
      },
    }),
    tools.register({
      name: 'p2_entities',
      description: 'Read-only entity observation without moving. Radius capped at 160; returns entities sorted by distance, with type/kind/username and dropped-item name/count when available. Server tracking range still limits what exists.',
      parameters: {
        type: 'object',
        properties: {
          center: vecSchema('Center; defaults to the body position'),
          radius: { type: 'number', minimum: 0, maximum: 160, description: 'Defaults to 64' },
          types: {
            type: 'array',
            description: 'Entity categories such as animal/hostile/player/other',
            items: { type: 'string' },
            maxItems: 16,
          },
          names: {
            type: 'array',
            description: 'Entity names such as sheep/item',
            items: { type: 'string' },
            maxItems: 32,
          },
          limit: { type: 'number', minimum: 1, maximum: 512, description: 'Defaults to 128' },
        },
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        return await manager.worldEntities(args as unknown as JsonValue)
      },
    }),
    tools.register({
      name: 'p2_order',
      description: 'Submit one goal-level order. The NPC chooses and executes the work; do not use it as a micro-command.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Optional stable order id; generated when omitted' },
          verb: { type: 'string', enum: [...ORDER_VERBS] },
          params: { type: 'object' },
          constraints: { type: 'object' },
          blueprint: { type: 'object' },
        },
        required: ['verb'],
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        const order: Record<string, JsonValue> = { verb: args.verb as JsonValue }
        for (const key of ['id', 'params', 'constraints', 'blueprint'] as const) {
          if (args[key] !== undefined) order[key] = args[key] as JsonValue
        }
        return await manager.mindOrder(order)
      },
    }),
    tools.register({
      name: 'p2_orders',
      description: 'Active and queued orders. Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: output(),
      execute: async () => {
        requireActiveOwner(manager, agent)
        return await manager.mindOrders()
      },
    }),
    tools.register({
      name: 'p2_cancel',
      description: 'Cancel one order by id. A cancelled order never revives.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        if (typeof args.id !== 'string' || args.id.length === 0) throw new Error('p2_cancel requires an order id')
        return await manager.mindCancel(args.id)
      },
    }),
    tools.register({
      name: 'p2_report',
      description: 'Latest deviation or terminal digest; read it when woken.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: output(),
      execute: async () => {
        requireActiveOwner(manager, agent)
        return await manager.mindReport()
      },
    }),
    tools.register({
      name: 'p2_events',
      description: 'Mind events since a cursor (orders, jobs, tracker, definition errors).',
      parameters: {
        type: 'object',
        properties: {
          sinceSeq: { type: 'number', minimum: 0 },
          limit: { type: 'number', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        const sinceSeq = typeof args.sinceSeq === 'number' ? args.sinceSeq : 0
        return await manager.mindEvents(sinceSeq, typeof args.limit === 'number' ? args.limit : undefined)
      },
    }),
  ]
  return {
    dispose(): void {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

async function statusOf(manager: BodyManager, agent: AgentLike): Promise<JsonValue> {
  if (manager.currentState !== 'active') return { state: manager.currentState }
  requireActiveOwner(manager, agent)
  const result = await manager.status()
  if (result.state !== 'active') return { state: result.state }
  const status = result.status
  return {
    state: 'active',
    epoch: status.bodyEpoch,
    health: status.health,
    connection: status.connection,
    paused: status.providerState?.paused ?? null,
    mind: status.mind ?? null,
  } as unknown as JsonValue
}

function requireActiveOwner(manager: BodyManager, agent: AgentLike): void {
  if (manager.currentState !== 'active') throw new Error('P2 body is not active')
  const owner = manager.currentOwner
  if (owner !== undefined && owner.sessionId !== agent.session.id) {
    throw new Error('P2 body is owned by a different session')
  }
}

function output(): ToolDefinition['output'] {
  return {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

function vecSchema(description: string): Record<string, unknown> {
  return {
    type: 'object',
    description,
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      z: { type: 'number' },
    },
    required: ['x', 'y', 'z'],
    additionalProperties: false,
  }
}
