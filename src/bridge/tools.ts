import type { JsonValue } from '../contracts/index.ts'
import type { BodyManager } from './process-manager.ts'

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
    return execute(args, exec)
  }
  const register = (definition: ToolDefinition): void => {
    disposers.push(tools.register(definition))
  }

  register({
    name: 'p2_status',
    description: 'Read the P2 body, heartbeat, active run, and pending confirmation.',
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
    name: 'p2_check',
    description: 'Check a behavior, act, policy or op source file in the owner project without activating or running it.',
    parameters: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: 'Path inside the owner project' },
        artifactKind: { type: 'string', enum: ['behavior', 'act', 'policy', 'op'], description: 'Artifact kind; defaults to behavior' },
        format: { type: 'string', enum: ['ir', 'js'], description: 'Behavior format; defaults to ir' },
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
        || args.artifactKind === 'behavior'
        ? args.artifactKind
        : undefined
      const format = args.format === 'js' || args.format === 'ir' ? args.format : undefined
      return manager.check(String(args.sourcePath), {
        ...(kind === undefined ? {} : { artifactKind: kind }),
        ...(format === undefined ? {} : { format }),
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
      })
    }),
  })

  register({
    name: 'p2_activate',
    description: 'Activate a checked artifact in its target binding. This does not start a run.',
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
    name: 'p2_switch',
    description: 'Accept a serial switch to an activated artifact. Accepted is not task completion.',
    parameters: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'Activated artifact id' },
        params: { type: 'object', description: 'Behavior parameters', additionalProperties: true },
      },
      required: ['artifactId'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => manager.switch(
      String(args.artifactId),
      (args.params ?? {}) as JsonValue,
    )),
  })

  register({
    name: 'p2_confirm',
    description: 'Submit the agent judgment for a pending external confirmation. The source is bridge-derived, never self-reported.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run awaiting confirmation' },
        confirmationId: { type: 'string', description: 'Confirmation record id' },
        decision: { type: 'string', enum: ['confirm', 'deny'], description: 'Agent decision' },
      },
      required: ['runId', 'confirmationId', 'decision'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => manager.confirm(
      String(args.runId),
      String(args.confirmationId),
      args.decision === 'deny' ? 'deny' : 'confirm',
    )),
  })

  register({
    name: 'p2_stop',
    description: 'Stop the current behavior run while keeping the P2 body alive.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Active run id; defaults to the current run' },
      },
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => manager.stopBehavior(
      typeof args.runId === 'string' ? args.runId : undefined,
    )),
  })

  register({
    name: 'p2_guard',
    description: 'Manage the one-shot guard that switches to an activated behavior when health drops below a threshold. Set requires condition, target, and ttlMs; clear keeps the current behavior.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'clear', 'status'], description: 'Guard action' },
        condition: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['health'], description: 'Condition kind; only health in the first version' },
            hpBelow: { type: 'number', description: 'Fire when health is at or below this value' },
          },
          required: ['kind', 'hpBelow'],
          additionalProperties: false,
        },
        target: {
          type: 'object',
          properties: {
            artifactId: { type: 'string', description: 'Activated target behavior artifact id' },
            params: { type: 'object', description: 'Target behavior parameters', additionalProperties: true },
          },
          required: ['artifactId'],
          additionalProperties: false,
        },
        ttlMs: { type: 'number', description: 'Authorization lifetime in milliseconds (10000-3600000)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    execute: guarded(async args => {
      const action = String(args.action)
      if (action === 'status') {
        const status = await manager.status()
        return status.state === 'active'
          ? { state: 'active', guard: status.status.guard ?? null, lastSwitch: status.status.lastSwitch ?? null, guardEventSeq: status.status.guardEventSeq ?? 0 }
          : { state: status.state, guard: null }
      }
      if (action === 'clear') {
        return await manager.guardClear()
      }
      if (action !== 'set') throw new Error(`unknown p2_guard action: ${action}`)
      const condition = args.condition as { kind?: unknown; hpBelow?: unknown } | undefined
      const target = args.target as { artifactId?: unknown; params?: unknown } | undefined
      if (condition?.kind !== 'health' || typeof condition.hpBelow !== 'number') {
        throw new Error('p2_guard set requires condition { kind: "health", hpBelow }')
      }
      if (target === undefined || typeof target.artifactId !== 'string') {
        throw new Error('p2_guard set requires target { artifactId, params? }')
      }
      if (typeof args.ttlMs !== 'number') {
        throw new Error('p2_guard set requires ttlMs')
      }
      return await manager.guardSet({
        condition: { kind: 'health', hpBelow: condition.hpBelow },
        targetArtifactId: target.artifactId,
        params: (target.params ?? {}) as JsonValue,
        ttlMs: args.ttlMs,
      })
    }),
  })

  register({
    name: 'p2_events',
    description: 'Drain the bounded current-epoch P2 event buffer, including run status and guard events.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonOutput(),
    execute: guarded(async () => {
      const drained = manager.drainEvents()
      return {
        events: drained.events as unknown as JsonValue,
        gap: drained.gap,
        dropped: drained.dropped,
      }
    }),
  })

  register({
    name: 'p2_rescue',
    description: 'Experiment-only rescue channel. Sends one allow-listed self command, records an audit entry, and refuses while a behavior is active.',
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

function jsonOutput(): ToolDefinition['output'] {
  return {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}
