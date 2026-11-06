import { isRecord } from '../contracts/index.ts'
import type { JsonValue } from '../contracts/index.ts'
import { ORDER_VERBS } from '../mind/orders.ts'
import type { BodyManager } from './process-manager.ts'
import { formatTarget } from './target.ts'
import { repeatHint } from './repeat.ts'
import type { RepeatTracker } from './repeat.ts'

export type AgentLike = {
  id: string
  session: {
    id: string
    header?: { cwd?: string }
  }
  /** Live DSH lifecycle state; optional in test doubles. */
  status?: 'idle' | 'running'
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
      description: 'Read-only world observation. find returns the nearest loaded blocks by name within a radius, sorted by distance; it never chooses a target or moves, so use it first and then issue p2_order go/craft. Only loaded blocks are returned; absence is not proof the block does not exist. Box (min+max) and targeted points queries remain available. Block entries include raw block light `light` and sky light `skyLight` (0-15) when the adapter can read them; omitted means unknown.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['box', 'points', 'find'],
            description: 'Defaults to box, or points when points is given, find when near is given',
          },
          min: vecSchema('Box minimum corner, inclusive; box mode'),
          max: vecSchema('Box maximum corner, inclusive; box mode'),
          points: {
            type: 'array',
            description: 'Targeted query instead of a box; max 256 unique points',
            items: vecSchema('Point'),
            maxItems: 256,
          },
          near: vecSchema('Find center cell; defaults to the body position'),
          radius: {
            type: 'number',
            minimum: 1,
            maximum: 32,
            description: 'Find radius in blocks; defaults to 16',
          },
          limit: {
            type: 'number',
            minimum: 1,
            maximum: 10,
            description: 'Maximum find results; defaults to 5',
          },
          includeEntities: { type: 'boolean', description: 'Box queries only; defaults to true' },
          detail: {
            type: 'string',
            enum: ['blocks', 'counts', 'surface'],
            description: 'Box detail level; counts/surface keep replies small',
          },
          only: {
            type: 'array',
            description: 'Block names to include; required for find (1-32 names)',
            items: { type: 'string' },
            maxItems: 32,
          },
          excludeAir: { type: 'boolean', description: 'Omit loaded air from a box blocks view' },
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
      description: 'Submit one goal-level order. Returns as soon as the order is accepted (id + state); terminal, blocked and failed results are pushed back as a completion wake, so end the turn instead of sleeping or polling. Keep one active order. If the same (verb,target) has failed twice, change the coordinate, verb, or region instead of resubmitting it unchanged. hold is a queue barrier that occupies the active slot, not a queue purge: use p2_cancel {all:true} to clear queued orders. A body restart creates a new epoch and loses queued orders. Failure wakes include facts.snapshot (same-moment feet/head/support, neighbours, bodyOverlap) and one closed diagnosis; read those before issuing another p2_observe. Before the first order after start, load the p2-operator skill if it is listed. Verbs/primitives: go {x,y,z,range?,exact?,risky?}, dig {x,y,z} or volume {shape:"box"|"line",from,to,height?,only?,preserveFloor?,maxBlocks?} (hard cap 64, default 24) or tunnel {shape:"tunnel",to,height? 1-3 default 2,maxBlocks? default 24,preserveFloor?} (one horizontal axis, at most one y-step, no shaft), place {x,y,z,item,face?,stands?} (x/y/z is the occupied target cell, not the support; face is auto-selected when omitted), traverse {mode:"bridge"|"scaffold",x,y,z,item,maxBlocks?}, craft {item,count?}, use {x,y,z|item,durationMs?}, equip {item}, check {x,y,z}, container {x,y,z,action,item,count?}, attack {entityId,maxChases?}, hold {durationMs?}. risky go is unvalidated and opt-in; exact disables goal snapping and requires a standable goal.',
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
      description: 'Start or stop a standing duty. D1 supports {kind:"gather", item, quota, radius?, maxJobs?, maxWallMs?}. A duty only runs when no explicit order/plan is active; an explicit order preempts it. Starting a duty replaces the current active duty: the old one is terminal (cancelled, REPLACED_BY_NEW_DUTY), its job is stopped, and the result carries previousDuty + started. Duty state is persisted; base activity is not. Read the duty state from p2_status.',
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
      name: 'p2_base_activity',
      description: 'Set or read the permanent default activity. Default is idle; use wandering (radius 1-8, default 8) around the anchor recorded when base takes over, or escort to follow a player/entity name at distance (1-8, default 3) without teleporting. Base activity is NOT persisted: a body restart returns to idle. escort keeps state active with waitingReason:"TARGET_LOST" when the target is not observable; it does not switch itself. Use p2_order {verb:"hold"} for a hard stop that also keeps duty/base inactive. Read the current view from p2_status or this tool with action:"status".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'status'] },
          activity: {
            type: 'object',
            description: 'Required for set: {kind:"idle"} | {kind:"wandering",radius?} | {kind:"escort",target,distance?}',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        if (args.action !== 'set' && args.action !== 'status') {
          throw new Error('p2_base_activity action must be set or status')
        }
        if (args.action === 'status') return await manager.mindBaseActivity({ action: 'status' })
        if (args.activity === undefined) throw new Error('p2_base_activity set requires activity')
        return await manager.mindBaseActivity({ action: 'set', activity: args.activity as JsonValue })
      },
    }),
    tools.register({
      name: 'p2_policy',
      description: 'Set, reset, or read the body-level reaction policy. set replaces the whole policy: omit fight for flee-only; fight.allowedTargets [] means every adapter-classified hostile except players, passive/neutral, known neutral names, and auto-avoid (creeper, wither, ender dragon, warden). fight requires allowedTargets explicitly. Auto-fight is disabled while an explicit attack order is active; an explicit attack order may target any entity and P2 does not apply the protection filter. Policy is process-local: a body restart resets to flee-only. selfCare defaults are enabled.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'reset', 'status'] },
          reaction: {
            type: 'object',
            description: 'Required for set: {fight?:{allowedTargets,retreatHealth?,radius?,leash?}, selfCare?:{eat?,retreat?,unstuck?}}',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output(),
      execute: async args => {
        requireActiveOwner(manager, agent)
        if (args.action !== 'set' && args.action !== 'reset' && args.action !== 'status') {
          throw new Error('p2_policy action must be set, reset or status')
        }
        if (args.action === 'status') return await manager.mindPolicy({ action: 'status' })
        if (args.action === 'reset') return await manager.mindPolicy({ action: 'reset' })
        if (args.reaction === undefined) throw new Error('p2_policy set requires reaction')
        return await manager.mindPolicy({ action: 'set', reaction: args.reaction as JsonValue })
      },
    }),
    tools.register({
      name: 'p2_orders',
      description: 'Active and queued orders. Read-only. queueBlockedBy names a barrier order (such as hold) that is occupying the single active slot and keeping the queue from starting. A timed hold shows expiresAt; an indefinite hold has no expiry and must be cancelled.',
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

async function statusOf(manager: BodyManager, agent: AgentLike): Promise<JsonValue> {
  if (manager.currentState === 'faulted') {
    const result = await manager.status()
    const fault = result.state === 'faulted' ? result.fault ?? null : null
    return { state: 'faulted', locks: await manager.locks(), fault } as unknown as JsonValue
  }
  if (manager.currentState !== 'active') {
    return { state: manager.currentState, locks: await manager.locks() }
  }
  requireActiveOwner(manager, agent)
  const result = await manager.status()
  if (result.state !== 'active') {
    return {
      state: result.state,
      locks: await manager.locks(),
      ...(result.state === 'faulted' && result.fault !== undefined ? { fault: result.fault } : {}),
    } as unknown as JsonValue
  }
  const status = result.status
  return {
    state: 'active',
    epoch: status.bodyEpoch,
    target: manager.target === undefined ? null : formatTarget(manager.target),
    owner: status.owner?.sessionId ?? null,
    lock: manager.lockInfo ?? null,
    lastDisconnect: status.providerState?.lastDisconnect ?? null,
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
    const target = manager.target === undefined ? 'unknown target' : formatTarget(manager.target)
    throw new Error(
      `P2 body is owned by a different session (session ${owner.sessionId}, agent ${owner.agentId}, ${target}); `
      + 'ask that owner to stop it first',
    )
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
