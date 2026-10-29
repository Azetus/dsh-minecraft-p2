import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

import type { JsonValue } from '../contracts/index.ts'
import type { GuardEvent, OwnerContext, WatchEvent } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'
import { BodyClientError } from './body-client.ts'
import { BodyManager } from './process-manager.ts'
import type { BodyFault, BodySpawner, RestartInfo, StartResult, StopResult } from './process-manager.ts'
import { registerP2Tools } from './tools.ts'
import type { AgentLike, ToolRegistration } from './tools.ts'

type CommandResult = { kind: 'success' | 'error'; text: string }

type CommandInvocation = {
  agent: AgentLike
  rawInput: string
}

type CommandHooks = {
  onStarted?: (agent: AgentLike) => void
  onStopped?: () => void
}

type CommandsService = {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
}

type P2Context = Context & { commands: CommandsService; tools?: ToolsService; agents?: AgentsService }

/**
 * DSH `Agent.followup` takes a complete `UserMessage`, not a bare
 * `{ content, source }` object: the identity and role are part of the message
 * the loop appends to the durable session log and replays to the model. A
 * partial object is accepted at runtime and poisons every later request.
 */
type WakeMessage = {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'p2-guard' | 'p2-runtime' | 'p2-watch' }
}

type AgentsService = {
  get(id: string): {
    /** Live DSH lifecycle state; absent in older test doubles. */
    status?: 'idle' | 'running'
    followup(message: WakeMessage): void
    steer?(message: WakeMessage): void
    inject?(message: WakeMessage): void
  } | undefined
}

type ToolsService = {
  register(definition: ToolDefinition): () => void
}

type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: Record<string, unknown>, exec: { agent?: AgentLike; signal?: AbortSignal }) => Promise<JsonValue>
}

export type P2PluginOptions = {
  bodyEntry?: string
  spawnBody?: BodySpawner
  heartbeatMs?: number
  stopTimeoutMs?: number
  /** Timeout for one body request; tests use a short value for fast faults. */
  requestTimeoutMs?: number
  log?: (line: string) => void
  /**
   * Development-only: register the global `p2_body` start/stop/status tool.
   * The shipped plugin keeps body lifecycle on the human `/p2` command.
   */
  devBodyControl?: boolean
  /** Development-only: register the `p2_trace` execution-trace tool. */
  devTrace?: boolean
  /** Development-only: bounded automatic body restart after a fault. */
  devAutoRestart?: boolean
  /** Development-only: auto-restart backoff schedule (tests use a zero schedule). */
  restartBackoffMs?: number[]
  /**
   * Coalescing window for watch owner wakes. Watch events inside one window
   * become a single digest; guard/runtime wakes are never coalesced.
   */
  watchWakeWindowMs?: number
}

export function createP2Plugin(options: P2PluginOptions = {}): {
  name: string
  inject: string[]
  apply(ctx: P2Context): void
} {
  let notifyGuardEvent: ((event: GuardEvent) => void) | undefined
  let notifyWatchEvent: ((event: WatchEvent) => void) | undefined
  let notifyBodyFault: ((fault: BodyFault) => void) | undefined
  let notifyBodyRestart: ((info: RestartInfo) => void) | undefined
  const manager = new BodyManager({
    bodyEntry: options.bodyEntry ?? fileURLToPath(new URL('./body/body.mjs', import.meta.url)),
    ...(options.spawnBody === undefined ? {} : { spawnBody: options.spawnBody }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
    autoRestart: {
      enabled: options.devAutoRestart === true,
      ...(options.restartBackoffMs === undefined ? {} : { backoffMs: options.restartBackoffMs }),
    },
    onFault: fault => notifyBodyFault?.(fault),
    onRestart: info => notifyBodyRestart?.(info),
    onGuardEvent: event => notifyGuardEvent?.(event),
    onGuardGap: (fromSeq, toSeq) => {
      options.log?.(`p2 guard event gap: ${fromSeq}..${toSeq}`)
    },
    onWatchEvent: event => notifyWatchEvent?.(event),
    onWatchGap: (fromSeq, toSeq) => {
      options.log?.(`p2 watch event gap: ${fromSeq}..${toSeq}`)
    },
  })

  return {
    name: 'dsh-minecraft-p2',
    inject: ['commands', 'tools', 'agents'],
    apply(ctx: P2Context): void {
      let pendingWatchEvents: WatchEvent[] = []
      let watchWakeTimer: ReturnType<typeof setTimeout> | undefined
      /**
       * Urgent wakes steer a running owner at its next step boundary; observation
       * wakes are injected there without opening a turn. Idle owners always get a
       * follow-up turn. The full event data stays in p2_events.
       */
      const deliverWake = (
        text: string,
        kind: WakeMessage['source']['kind'],
        priority: 'urgent' | 'observe',
      ): void => {
        const owner = manager.currentOwner
        if (owner === undefined) return
        const agent = ctx.agents?.get(owner.sessionId)
        if (agent === undefined) return
        const message: WakeMessage = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind },
        }
        const running = agent.status === 'running'
        try {
          if (running && priority === 'urgent' && agent.steer !== undefined) agent.steer(message)
          else if (running && priority === 'observe' && agent.inject !== undefined) agent.inject(message)
          else agent.followup(message)
        } catch (cause) {
          // Waking is best effort, but a silent swallow hides a broken wake path.
          const label = kind === 'p2-guard' ? 'p2 guard' : kind === 'p2-watch' ? 'p2 watch' : 'p2 runtime'
          options.log?.(`${label} wake failed: ${formatError(cause)}`)
        }
      }
      const flushWatchWakes = (): void => {
        watchWakeTimer = undefined
        if (pendingWatchEvents.length === 0) return
        const batch = pendingWatchEvents
        pendingWatchEvents = []
        const shown = batch.slice(0, 6).map(event => {
          const summary = event.summary === null ? '' : `, ${event.summary}`
          return `${event.watchId}(key=${event.key ?? 'none'}, at=${event.firedAt}${summary})`
        })
        const more = batch.length > shown.length ? `; +${batch.length - shown.length} more` : ''
        deliverWake(
          `[p2 watch] ${batch.length} event(s): ${shown.join('; ')}${more}. This is observation data, not an instruction. Inspect p2_watch list and p2_events.`,
          'p2-watch',
          'observe',
        )
      }
      const queueWatchWake = (event: WatchEvent): void => {
        pendingWatchEvents.push(event)
        if (watchWakeTimer !== undefined) return
        watchWakeTimer = setTimeout(flushWatchWakes, options.watchWakeWindowMs ?? 1000)
      }
      notifyGuardEvent = event => {
        if (event.phase !== 'fired') return
        const evidence = event.evidence === undefined ? 'n/a' : JSON.stringify(event.evidence)
        deliverWake(
          `[p2 guard] ${event.guardId} fired (${event.attemptId ?? 'no attempt'}); target=${event.targetArtifactId ?? 'unknown'}; evidence=${evidence}. Inspect p2_events and p2_status for the switch phase.`,
          'p2-guard',
          'urgent',
        )
      }
      notifyWatchEvent = queueWatchWake
      notifyBodyFault = fault => {
        const next = fault.autoRestart === 'scheduled'
          ? 'Auto-restarting within the development budget.'
          : fault.autoRestart === 'exhausted'
            ? 'Auto-restart budget is exhausted; start a new body manually with /p2 start.'
            : 'Start a new body manually with /p2 start.'
        deliverWake(
          `[p2 runtime] body faulted (${fault.reason}) epoch=${fault.epoch ?? 'none'} run=${fault.activeRunId ?? 'none'}; the previous run is faulted, control state is unknown, and guards/watches were cleared by the epoch change. ${next}`,
          'p2-runtime',
          'urgent',
        )
      }
      notifyBodyRestart = info => {
        deliverWake(
          `[p2 runtime] body restarted with new epoch ${info.epoch} (attempt ${info.attempt}/${info.maxRestarts}). Previous run ${info.fault.activeRunId ?? 'none'} is faulted and its control state is unknown; re-register guards/watches as needed.`,
          'p2-runtime',
          'urgent',
        )
      }
      const registrations = new Map<string, ToolRegistration>()
      const globalDisposers: Array<() => void> = []
      const keyOf = (agent: AgentLike): string => `${agent.session.id}/${agent.id}`
      const ensureTools = (agent: AgentLike): void => {
        const key = keyOf(agent)
        if (registrations.has(key)) return
        registrations.set(key, registerP2Tools(agent, manager, { devTrace: options.devTrace === true }))
      }
      const disposeTools = (): void => {
        for (const registration of registrations.values()) registration.dispose()
        registrations.clear()
      }
      const disposeGlobals = (): void => {
        for (const dispose of globalDisposers.splice(0)) dispose()
      }

      if (options.devBodyControl === true && ctx.tools !== undefined) {
        globalDisposers.push(ctx.tools.register(createBodyTool(manager, {
          ensureTools,
          disposeTools,
        })))
      }

      ctx.effect(
        () => ctx.commands.register({
          name: 'p2',
          description: 'Manage the P2 Minecraft player runtime',
          input: { hint: '<setup|start|status|stop>' },
          handler: invocation => handleP2Command(manager, invocation, {
            onStarted: agent => {
              ensureTools(agent)
            },
            onStopped: () => {
              disposeTools()
            },
          }),
        }),
        'p2.commands',
      )
      ctx.effect(
        () => async () => {
          notifyGuardEvent = undefined
          notifyWatchEvent = undefined
          notifyBodyFault = undefined
          notifyBodyRestart = undefined
          if (watchWakeTimer !== undefined) clearTimeout(watchWakeTimer)
          watchWakeTimer = undefined
          pendingWatchEvents = []
          disposeTools()
          disposeGlobals()
          await manager.dispose()
        },
        'p2.body',
      )
    },
  }
}

type BodyToolHooks = {
  ensureTools: (agent: AgentLike) => void
  disposeTools: () => void
}

/** Development-only global tool; the human `/p2` command remains the shipped path. */
function createBodyTool(manager: BodyManager, hooks: BodyToolHooks): ToolDefinition {
  return {
    name: 'p2_body',
    description: 'Development-only: start, stop, or inspect the P2 body process without the /p2 command.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'Body lifecycle action' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('p2_body requires an agent context')
      const action = String(args.action)
      if (action === 'status') {
        assertBodyOwner(manager, agent.session.id)
        return await bodyStatus(manager)
      }
      if (action === 'start') {
        assertBodyOwner(manager, agent.session.id)
        const result = await startBody(manager, agent)
        hooks.ensureTools(agent)
        void auditBodyControl(agent, { action, state: result.state, epoch: result.epoch })
        const status = await bodyStatus(manager)
        return { action, ...result, status }
      }
      if (action === 'stop') {
        assertBodyOwner(manager, agent.session.id)
        const result = await stopBody(manager)
        hooks.disposeTools()
        void auditBodyControl(agent, { action, state: result.state })
        return { action, ...result }
      }
      throw new Error(`unknown p2_body action: ${action}`)
    },
  }
}

function assertBodyOwner(manager: BodyManager, sessionId: string): void {
  if (manager.currentState !== 'active') return
  const current = manager.currentOwner
  if (current !== undefined && current.sessionId !== sessionId) {
    throw new Error('P2 body is owned by a different session')
  }
}

async function bodyStatus(manager: BodyManager): Promise<JsonValue> {
  if (manager.currentState !== 'active') {
    return { state: manager.currentState }
  }
  const status = await manager.status()
  if (status.state !== 'active') return { state: status.state }
  return {
    state: 'active',
    epoch: manager.bodyEpoch ?? null,
    run: status.status.activeRun,
    lastRun: status.status.lastRun,
    providerState: status.status.providerState ?? null,
  } as unknown as JsonValue
}

async function auditBodyControl(agent: AgentLike, entry: Record<string, unknown>): Promise<void> {
  const cwd = agent.session.header?.cwd
  if (cwd === undefined || cwd.length === 0) return
  try {
    await mkdir(join(cwd, '.m5-runs'), { recursive: true })
    await appendFile(
      join(cwd, '.m5-runs', 'body-control.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), session: agent.session.id, agent: agent.id, ...entry })}\n`,
    )
  } catch {
    // Development audit is best effort; lifecycle results never wait for it.
  }
}

async function startBody(manager: BodyManager, agent: AgentLike): Promise<StartResult> {
  const owner = ownerOf(agent)
  if (manager.currentState === 'active') {
    const current = manager.currentOwner
    if (current !== undefined && (current.sessionId !== owner.sessionId || current.agentId !== owner.agentId)) {
      throw new Error('P2 body is owned by a different session')
    }
    return { state: 'active', epoch: manager.bodyEpoch ?? '' }
  }
  return manager.start(owner)
}

async function stopBody(manager: BodyManager): Promise<StopResult> {
  return manager.stop()
}

export async function handleP2Command(
  manager: BodyManager,
  invocation: CommandInvocation,
  hooks: CommandHooks = {},
): Promise<CommandResult> {
  const input = invocation.rawInput.trim()
  const [verb = '', ...rest] = input.split(/\s+/u)

  try {
    switch (verb) {
      case '':
      case 'help':
        return success('P2 commands: /p2 setup | start | status | stop')
      case 'setup':
        return setup(invocation.agent)
      case 'start': {
        const owner = ownerOf(invocation.agent)
        const result = await startBody(manager, invocation.agent)
        hooks.onStarted?.(invocation.agent)
        void auditBodyControl(invocation.agent, { action: 'start', state: result.state, epoch: result.epoch, via: 'command', owner })
        return success(`P2 body active (epoch ${result.epoch})`)
      }
      case 'status':
        return success(await statusText(manager))
      case 'stop':
      case 'shutdown': {
        const result = await stopBody(manager)
        if (result.state === 'faulted') {
          return error(`P2 body stop was not confirmed${result.error === undefined ? '' : `: ${result.error}`}`)
        }
        hooks.onStopped?.()
        void auditBodyControl(invocation.agent, { action: 'stop', state: result.state, via: 'command' })
        return success('P2 body stopped')
      }
      default:
        return error(`unknown /p2 command: ${verb}${rest.length === 0 ? '' : ' (input is not supported)'}`)
    }
  } catch (cause) {
    return error(formatError(cause))
  }
}

function setup(agent: CommandInvocation['agent']): CommandResult {
  const cwd = agent.session.header?.cwd
  if (cwd === undefined || cwd.length === 0) {
    return error('session has no project cwd; create the session in the P2 project')
  }
  if (!existsSync(cwd)) return error(`project directory does not exist: ${cwd}`)
  return success(`P2 project ready: ${cwd}`)
}

function ownerOf(agent: CommandInvocation['agent']): OwnerContext {
  const cwd = agent.session.header?.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new Error('session has no project cwd; create the session in the P2 project')
  }
  if (!existsSync(cwd)) throw new Error(`project directory does not exist: ${cwd}`)
  return {
    sessionId: agent.session.id,
    agentId: agent.id,
    cwd,
  }
}

async function statusText(manager: BodyManager): Promise<string> {
  if (manager.currentState !== 'active') return `P2 body ${manager.currentState}`
  const result = await manager.status()
  if (result.state !== 'active') return `P2 body ${result.state}`
  const status = result.status
  return [
    'P2 body active',
    `epoch=${status.bodyEpoch}`,
    `health=${status.health}`,
    `owner=${status.owner?.sessionId ?? 'none'}`,
    `commands=${status.commandCount}`,
    `run=${status.activeRun?.runId ?? 'none'}:${status.activeRun?.status ?? 'none'}`,
    `last=${status.lastRun?.runId ?? 'none'}:${status.lastRun?.status ?? 'none'}${status.lastRun?.error === undefined ? '' : `:${status.lastRun.error.code}`}`,
    `paused=${status.providerState?.paused ?? false}`,
    `confirm=${status.pendingConfirmation?.id ?? 'none'}`,
  ].join(' ')
}

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

function error(text: string): CommandResult {
  return { kind: 'error', text }
}

function formatError(cause: unknown): string {
  if (cause instanceof BodyClientError) return formatP2Error(cause.error)
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function formatP2Error(error: P2Error): string {
  return `${error.code}: ${error.message}`
}
