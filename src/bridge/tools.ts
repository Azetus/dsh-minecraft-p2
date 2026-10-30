import type { JsonValue, SnapshotPart, SnapshotResult } from '../contracts/index.ts'
import type { BodyManager } from './process-manager.ts'
import { summarizeEntities, summarizeInventory } from './summaries.ts'

type ToolText = { type: 'text'; text: string }

type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown>, value: unknown) => ToolText[]
  }
  execute: (args: Record<string, unknown>, exec: { agent?: AgentLike; signal?: AbortSignal }) => Promise<JsonValue>
}

export type AgentLike = {
  id: string
  session: {
    id: string
    header?: { cwd?: string }
  }
  ctx?: {
    tools?: { register(definition: ToolDefinition): () => void }
    effect?: (callback: () => unknown, label?: string) => unknown
  }
}

export type ToolRegistration = {
  owner: { sessionId: string; agentId: string }
  dispose: () => void
}

/** Register owner-scoped P2 tools after a human `/p2 start`; never starts a body. */
export function registerP2Tools(agent: AgentLike, manager: BodyManager): ToolRegistration {
  const tools = agent.ctx?.tools
  if (tools === undefined) {
    return { owner: { sessionId: agent.session.id, agentId: agent.id }, dispose: () => {} }
  }
  const owner = { sessionId: agent.session.id, agentId: agent.id }
  const disposers: Array<() => void> = []
  const guarded = (
    execute: (args: Record<string, unknown>, exec: { agent?: AgentLike; signal?: AbortSignal }) => Promise<JsonValue>,
  ) => async (args: Record<string, unknown>, exec: { agent?: AgentLike; signal?: AbortSignal }): Promise<JsonValue> => {
    assertOwner(exec, owner)
    try {
      return await execute(args, exec)
    } catch (cause) {
      const structured = structuredToolError(cause)
      if (structured !== undefined) throw new Error(`${structured.code}: ${structured.message}`)
      throw cause
    }
  }
  const register = (definition: ToolDefinition): void => {
    disposers.push(tools.register(definition))
  }

  register({
    name: 'p2_status',
    description: 'Read the P2 body, heartbeat, controller and watches.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonOutput(),
    execute: guarded(async () => {
      const status = await manager.status()
      return status as unknown as JsonValue
    }),
  })

  register({
    name: 'p2_observe',
    description: 'Read a P2 world query such as position, inventory, entities, time, or block.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'Query operation, for example position' },
        args: { type: 'object', description: 'Optional query arguments', additionalProperties: true },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => manager.observe(
      String(args.op),
      (args.args ?? {}) as JsonValue,
    )),
  })

  register({
    name: 'p2_snapshot',
    description: 'One-round-trip batch observation: position, health, inventory summary, nearby blocks and entities. Each part carries status/value/meta; partial reports any failed part.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Block search radius (default 8)' },
        count: { type: 'number', description: 'Block and entity limit (default 16)' },
        names: { type: 'array', items: { type: 'string' }, description: 'Optional block names to find' },
        timeoutMs: { type: 'number', description: 'Deadline for pending parts (default 1000)' },
      },
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => {
      const radius = typeof args.radius === 'number' ? args.radius : 8
      const count = typeof args.count === 'number' ? args.count : 16
      const names = Array.isArray(args.names)
        ? args.names.filter((name): name is string => typeof name === 'string')
        : undefined
      const ops: JsonValue = [
        { key: 'position', op: 'position' },
        { key: 'health', op: 'health' },
        { key: 'inventory', op: 'inventory' },
        { key: 'blocks', op: 'blocks', args: { radius, count, ...(names === undefined ? {} : { names }) } },
        { key: 'entities', op: 'entities', args: { count, sort: 'distance' } },
      ]
      const raw = await manager.snapshot(
        ops,
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      ) as unknown as SnapshotResult
      const parts: SnapshotPart[] = raw.parts.map(part => {
        if (part.status !== 'ok') return part
        if (part.key === 'inventory') {
          return { ...part, summary: summarizeInventory(part.value ?? null) as unknown as JsonValue }
        }
        if (part.key === 'entities') {
          return { ...part, summary: summarizeEntities(part.value ?? null) as unknown as JsonValue }
        }
        return part
      })
      return { ...raw, parts } as unknown as JsonValue
    }),
  })

  register({
    name: 'p2_card',
    description: 'Compact high-frequency status card: health, position, nearby hostile count, and watch counts in one round trip.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Hostile search radius (default 16)' },
        timeoutMs: { type: 'number', description: 'Deadline for the observation parts (default 300)' },
      },
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => manager.card({
      ...(typeof args.radius === 'number' ? { radius: args.radius } : {}),
      ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
    } as JsonValue)),
  })

  register({
    name: 'p2_check',
    description: 'Check an act, policy, op or strategy source file in the owner project without activating or running it.',
    parameters: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: 'Path inside the owner project' },
        artifactKind: { type: 'string', enum: ['act', 'policy', 'op', 'strategy'], description: 'Artifact kind; defaults to act' },
        timeoutMs: { type: 'number', description: 'Build timeout in milliseconds' },
      },
      required: ['sourcePath'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => {
      const kind = args.artifactKind === 'act'
        || args.artifactKind === 'policy'
        || args.artifactKind === 'op'
        || args.artifactKind === 'strategy'
        ? args.artifactKind
        : undefined
      return manager.check(String(args.sourcePath), {
        ...(kind === undefined ? {} : { artifactKind: kind }),
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
      })
    }),
  })

  register({
    name: 'p2_activate',
    description: 'Activate a checked artifact in its target binding. This does not start control.',
    parameters: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'Checked artifact id' },
      },
      required: ['artifactId'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => manager.activate(String(args.artifactId))),
  })

  register({
    name: 'p2_controller',
    description: 'Manage the P2Controller control mode: enable/disable, install an activated strategy artifact, commit or cancel a goal, and read controller status/events. The controller owns the single action slot; there is no behavior executor.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['enable', 'disable', 'status', 'install', 'commit', 'cancel', 'events'], description: 'Controller action' },
        artifactId: { type: 'string', description: 'install: activated strategy artifact id' },
        mode: { type: 'string', enum: ['boundary', 'interrupt'], description: 'install: replacement mode, defaults to boundary' },
        id: { type: 'string', description: 'commit: optional commitment id' },
        goal: { type: 'string', description: 'commit: human-readable goal' },
        strategyKey: { type: 'string', description: 'commit: installed strategy key (definition id)' },
        post: { type: 'object', description: 'commit: post-condition {kind:"count-at-least"|"fact-equals"|"standing",...}', additionalProperties: true },
        baselineKeys: { type: 'array', items: { type: 'string' }, description: 'commit: fact keys sampled as the baseline' },
        kind: { type: 'string', enum: ['task', 'standing'], description: 'commit: defaults from the post-condition' },
        deadlineMs: { type: 'number', description: 'commit: commitment deadline' },
        checkpoint: { type: 'object', description: 'commit: initial strategy checkpoint', additionalProperties: true },
        commitmentId: { type: 'string', description: 'cancel: defaults to the active commitment' },
        reason: { type: 'string', description: 'cancel: reason recorded in the checkpoint' },
        sinceSeq: { type: 'number', description: 'events: return events after this seq' },
        limit: { type: 'number', description: 'events: page size (max 100)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => {
      const action = String(args.action)
      if (action === 'enable' || action === 'disable' || action === 'status') {
        return manager.controller(action, {})
      }
      if (action === 'events') {
        return manager.controller('events', {
          ...(typeof args.sinceSeq === 'number' ? { sinceSeq: args.sinceSeq } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        })
      }
      if (action === 'install') {
        if (typeof args.artifactId !== 'string' || args.artifactId.length === 0) {
          throw new Error('install requires artifactId')
        }
        if (args.mode !== undefined && args.mode !== 'boundary' && args.mode !== 'interrupt') {
          throw new Error('mode must be boundary or interrupt')
        }
        return manager.controller('install', {
          artifactId: args.artifactId,
          ...(args.mode === undefined ? {} : { mode: args.mode }),
        })
      }
      if (action === 'commit') {
        if (typeof args.goal !== 'string' || typeof args.strategyKey !== 'string' || typeof args.post !== 'object' || args.post === null) {
          throw new Error('commit requires goal, strategyKey and post')
        }
        const baselineKeys = Array.isArray(args.baselineKeys)
          ? args.baselineKeys.filter((key): key is string => typeof key === 'string')
          : undefined
        if (args.kind !== undefined && args.kind !== 'task' && args.kind !== 'standing') {
          throw new Error('kind must be task or standing')
        }
        return manager.controller('commit', {
          goal: args.goal,
          strategyKey: args.strategyKey,
          post: args.post as JsonValue,
          ...(typeof args.id === 'string' ? { id: args.id } : {}),
          ...(baselineKeys === undefined ? {} : { baselineKeys }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
          ...(typeof args.deadlineMs === 'number' ? { deadlineMs: args.deadlineMs } : {}),
          ...(args.checkpoint === undefined ? {} : { checkpoint: args.checkpoint as JsonValue }),
        })
      }
      if (action === 'cancel') {
        return manager.controller('cancel', {
          ...(typeof args.commitmentId === 'string' ? { commitmentId: args.commitmentId } : {}),
          ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
        })
      }
      throw new Error(`unknown controller action: ${action}`)
    }),
  })

  register({
    name: 'p2_events',
    description: 'Drain the bounded current-epoch execution event buffer (controller, watch, fault, restart). Current state is read with p2_status.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonOutput(),
    execute: guarded(async () => {
      const drained = manager.drainEvents()
      return {
        events: drained.events as unknown as JsonValue,
        gap: drained.gap,
        dropped: drained.dropped,
        droppedTotal: drained.droppedTotal,
      }
    }),
  })

  register({
    name: 'p2_watch',
    description: 'Manage observation-only watches: declared queries + a pure policy predicate produce one notification per edge, subject to cooldown and a global rate cap. A watch cannot stop or steer control; inspect p2_events for delivered events.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'list', 'clear'], description: 'Watch action' },
        watchId: { type: 'string', description: 'Watch id for remove' },
        name: { type: 'string', description: 'Optional human-readable name' },
        priority: { type: 'number', description: 'Ordering hint only; watches never control' },
        queries: {
          type: 'array',
          description: 'Up to 4 queries sampled by the host',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', description: 'Query operation name' },
              args: { type: 'object', description: 'Query arguments', additionalProperties: true },
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
        predicate: { type: 'string', description: 'Checked policy artifactId; returns boolean or { fire, key?, summary? }' },
        edge: { type: 'string', enum: ['rising', 'falling', 'both'], description: 'Edge to notify (default rising)' },
        cooldownMs: { type: 'number', description: 'Minimum gap between events (default 5000, min 1000)' },
        ttlMs: { type: 'number', description: 'Watch lifetime in milliseconds (default 3600000)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => {
      const action = String(args.action)
      if (action === 'list') return await manager.watchList()
      if (action === 'remove') {
        if (typeof args.watchId !== 'string') throw new Error('p2_watch remove requires watchId')
        return await manager.watchRemove(args.watchId)
      }
      if (action === 'clear') return await manager.watchRemove()
      if (action !== 'add') throw new Error(`unknown p2_watch action: ${action}`)
      if (!Array.isArray(args.queries) || typeof args.predicate !== 'string') {
        throw new Error('p2_watch add requires queries and a predicate artifactId')
      }
      return await manager.watchAdd({
        queries: args.queries as JsonValue,
        predicate: args.predicate,
        ...(args.edge === 'rising' || args.edge === 'falling' || args.edge === 'both' ? { edge: args.edge } : {}),
        ...(typeof args.cooldownMs === 'number' ? { cooldownMs: args.cooldownMs } : {}),
        ...(typeof args.ttlMs === 'number' ? { ttlMs: args.ttlMs } : {}),
        ...(typeof args.name === 'string' ? { name: args.name } : {}),
        ...(typeof args.priority === 'number' ? { priority: args.priority } : {}),
      } as JsonValue)
    }),
  })

  register({
    name: 'p2_rescue',
    description: 'Experiment-only rescue channel. Sends one allow-listed self command, records an audit entry, and refuses while a controller action is active.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['tp', 'effect', 'respawn'], description: 'Rescue action' },
        x: { type: 'number', description: 'Teleport x' },
        y: { type: 'number', description: 'Teleport y' },
        z: { type: 'number', description: 'Teleport z' },
        effect: { type: 'string', enum: ['instant_health', 'regeneration', 'saturation'], description: 'Allowed self effect' },
        durationSeconds: { type: 'number', description: 'Effect duration in seconds (1-10)' },
        amplifier: { type: 'number', description: 'Effect amplifier (0-1)' },
        reason: { type: 'string', minLength: 3, description: 'Why rescue is needed; recorded in the audit log' },
        category: { type: 'string', enum: ['stuck', 'trapped', 'death_loop', 'health', 'food', 'other'], description: 'Rescue category' },
      },
      required: ['action', 'reason', 'category'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => manager.rescue(args as JsonValue)),
  })

  register({
    name: 'p2_command',
    description: 'Query an accepted/terminal command by commandId. Unknown is not proof it never ran.',
    parameters: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Command id to query' },
      },
      required: ['commandId'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => manager.commandGet(String(args.commandId))),
  })

  return { owner, dispose: () => { for (const dispose of disposers.splice(0)) dispose() } }
}

function assertOwner(
  exec: { agent?: AgentLike },
  owner: { sessionId: string; agentId: string },
): void {
  if (exec.agent === undefined
    || exec.agent.session.id !== owner.sessionId
    || exec.agent.id !== owner.agentId) {
    throw new Error('P2 tools are owned by a different agent')
  }
}

/** Turn a thrown P2Error/BodyClientError into a message the model can read. */
function structuredToolError(cause: unknown): { code: string; message: string } | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined
  const candidate = (cause as { error?: unknown }).error ?? cause
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const { code, message } = candidate as { code?: unknown; message?: unknown }
  if (typeof code !== 'string' || typeof message !== 'string') return undefined
  return { code, message }
}

function jsonOutput(): ToolDefinition['output'] {
  return {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}





