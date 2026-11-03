import { isRecord } from '../contracts/index.ts'
import type { JsonValue } from '../contracts/index.ts'
import { ORDER_VERBS } from '../mind/orders.ts'
import type { BodyManager } from './process-manager.ts'
import { repeatHint } from './repeat.ts'
import type { RepeatTracker } from './repeat.ts'

export type AgentLike = {
  id: string
  session: {
    id: string
    header?: { cwd?: string }
  }
  /** Agent-scoped Cordis context; optional in tests. */
  ctx?: {
    get(name: string): unknown
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
export function registerP2Tools(
  agent: AgentLike,
  manager: BodyManager,
  tools: ToolsService,
  repeat?: RepeatTracker,
): ToolRegistration {
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
      name: 'p2_preview_blueprint',
      description: 'Dry-run a final-geometry blueprint: required/missing materials, conflicts (current/clearable), unknown cells and invalid fields. Read-only; no material is consumed and no block is cleared or placed.',
      parameters: {
        type: 'object',
        properties: {
          blueprint: {
            type: 'object',
            description: '{ blocks: [{x,y,z,name,state?}], verify?: {kind:"sealed-room",min,max} }',
          },
        },
        required: ['blueprint'],
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        return await manager.blueprintPreview(args.blueprint as JsonValue)
      },
    }),
    tools.register({
      name: 'p2_say',
      description: 'Send one chat message as the body. Use this to answer a game-chat message that was pushed to you.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 256 } },
        required: ['text'],
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        if (typeof args.text !== 'string' || args.text.trim().length === 0) throw new Error('p2_say requires text')
        return await manager.chatSay(args.text)
      },
    }),
    tools.register({
      name: 'p2_order',
      description: 'Submit one goal-level order. Returns as soon as the order is accepted (id + state); terminal, blocked and failed results are pushed back as a completion wake, so end the turn instead of sleeping or polling. Keep one active order. If the same (verb,target) has failed twice, change the coordinate, verb, or region instead of resubmitting it unchanged. hold is a queue barrier that occupies the active slot, not a queue purge: use p2_cancel {all:true} to clear queued orders. A body restart creates a new epoch and loses queued orders. Before the first order after start, load the p2-operator skill if it is listed. Verbs/primitives: go {x,y,z,range?,exact?,risky?}, dig {x,y,z} or volume {shape:"box"|"line",from,to,height?,only?,preserveFloor?,maxBlocks?} (hard cap 64, default 24), place {x,y,z,item,face?,stands?}, traverse {mode:"bridge"|"scaffold",x,y,z,item,maxBlocks?}, craft {item,count?}, use {x,y,z|item,durationMs?}, equip {item}, check {x,y,z}, container {x,y,z,action,item,count?}, attack {entityId}, hold {durationMs?}. risky go is unvalidated and opt-in; exact disables goal snapping and requires a standable goal.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Optional stable order id; generated when omitted' },
          verb: { type: 'string', enum: [...ORDER_VERBS] },
          params: { type: 'object' },
          constraints: { type: 'object' },
          blueprint: { type: 'object' },
          policy: {
            type: 'object',
            description: 'Execution policy, e.g. {conflict:{mode:"skip"|"clear"|"abort",allow:[],deny:[]}}',
          },
        },
        required: ['verb'],
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        const order: Record<string, JsonValue> = { verb: args.verb as JsonValue }
        for (const key of ['id', 'params', 'constraints', 'blueprint', 'policy'] as const) {
          if (args[key] !== undefined) order[key] = args[key] as JsonValue
        }
        const accepted = await manager.mindOrder(order) as unknown as {
          id?: string
          state?: string
          queue?: JsonValue
        }
        const verb = typeof args.verb === 'string' ? args.verb : ''
        const orderId = typeof accepted?.id === 'string' ? accepted.id : undefined
        const repeatFailures = orderId !== undefined && repeat !== undefined
          ? repeat.noteAccepted(agent.session.id, orderId, verb, args.params)
          : 0
        const warning = queueWarning(accepted?.queue)
        return {
          accepted: true,
          ...(orderId === undefined ? {} : { id: orderId }),
          ...(typeof accepted?.state === 'string' ? { state: accepted.state } : {}),
          ...(accepted?.queue === undefined ? {} : { queue: accepted.queue }),
          ...(warning === undefined ? {} : { warning }),
          ...(repeatFailures >= 2
            ? { repeatFailures, repeatHint: repeatHint(verb, repeatFailures) }
            : {}),
        } as JsonValue
      },
    }),
    tools.register({
      name: 'p2_duty',
      description: 'Start or stop a standing duty. D1 supports {kind:"gather", item, quota, radius?, maxJobs?, maxWallMs?}. A duty only runs when no explicit order/plan is active; an explicit order preempts it. Read the duty state from p2_status.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop'] },
          duty: {
            type: 'object',
            description: 'Required for start: {kind:"gather",item,quota,radius?,maxJobs?,maxWallMs?}',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        if (args.action !== 'start' && args.action !== 'stop') throw new Error('p2_duty action must be start or stop')
        if (args.action === 'stop') return await manager.mindDuty({ action: 'stop' })
        if (args.duty === undefined) throw new Error('p2_duty start requires duty')
        return await manager.mindDuty({ action: 'start', duty: args.duty as JsonValue })
      },
    }),
    tools.register({
      name: 'p2_orders',
      description: 'Active and queued orders. Read-only. queueBlockedBy names a barrier order (such as hold) that is occupying the single active slot and keeping the queue from starting.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: output(),
      execute: async () => {
        requireActiveOwner(manager, agent)
        return await manager.mindOrders()
      },
    }),
    tools.register({
      name: 'p2_cancel',
      description: 'Cancel one order by id, or every queued/active order with all:true. A hold order blocks the whole queue until cancelled; a cancelled order never revives.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Order id; required unless all is true' },
          all: { type: 'boolean', description: 'Cancel every queued and active order' },
        },
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        if (args.all === true) return await manager.mindCancel('*', true)
        if (typeof args.id !== 'string' || args.id.length === 0) throw new Error('p2_cancel requires an order id or all:true')
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
      description: 'Detailed mind-event audit trail since a cursor. Completion/failure is pushed automatically as a wake; use this only to investigate, never as the main polling loop.',
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

function queueWarning(queue: JsonValue | undefined): string | undefined {
  if (!isRecord(queue)) return undefined
  const blockedBy = isRecord(queue.blockedBy) ? queue.blockedBy : undefined
  const blockedId = typeof blockedBy?.id === 'string' ? blockedBy.id : undefined
  if (blockedBy?.verb === 'hold' && blockedId !== undefined) {
    return `the active hold ${blockedId} is a queue barrier; this order will not start until the hold ends. Release it with p2_cancel {id:"${blockedId}"} or p2_cancel {all:true}.`
  }
  if (queue.holdsActiveSlot === true && typeof queue.queuedBehind === 'number' && queue.queuedBehind > 0) {
    return `hold is a barrier: ${queue.queuedBehind} queued order(s) will not start until this hold ends. This is not a queue purge; use p2_cancel {all:true} to clear the queue, or p2_cancel {id} to release the hold.`
  }
  return undefined
}

async function statusOf(manager: BodyManager, agent: AgentLike): Promise<JsonValue> {  if (manager.currentState !== 'active') return { state: manager.currentState }
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
