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
