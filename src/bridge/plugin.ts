import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

import { ChatBatcher } from './chat-batcher.ts'
import { CompletionFeed, formatCompletionWake } from './completion-wake.ts'
import type { CompletionItem, MindEventView } from './completion-wake.ts'
import type { JsonValue, StatusResult } from '../contracts/index.ts'
import type { ChatMessage, OwnerContext } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'
import { BodyClientError } from './body-client.ts'
import { OPERATOR_CONTRACT } from './operator-skill.ts'
import { annotateCompletion, RepeatTracker } from './repeat.ts'
import { BodyManager } from './process-manager.ts'
import type { BodyFault, BodySpawner, RestartInfo, StartResult, StopResult } from './process-manager.ts'
import { formatTarget, parseTargetArgs, parseTargetFields } from './target.ts'
import type { McTarget } from './target.ts'
import { registerP2Tools } from './tools.ts'
import type { AgentLike, ToolDefinition, ToolsService } from './tools.ts'
import {
  ensureWorkspace,
  loadAutoWakeConfig,
  memoryFilePath,
  workspacePaths,
} from './workspace.ts'
import type { AutoWakeConfig } from './workspace.ts'
import { PersonaProvider } from './persona.ts'
import { MemoryStore } from './memory-store.ts'
import { registerMemoryTool } from './memory-tools.ts'
import { AutoWakeScheduler, evaluateAutoWakeGate } from './auto-wake.ts'
import type { AutoWakeActivity, AutoWakeGateResult, AutoWakeLogEntry } from './auto-wake.ts'
import { loadPackagedSkills, registerPackagedSkills } from './owner-skills.ts'
import type { PackagedSkillSource } from './owner-skills.ts'
import { registerWorkspaceSkills } from './workspace-skills.ts'

type CommandResult = { kind: 'success' | 'error'; text: string }

type CommandInvocation = {
  agent: AgentLike
  rawInput: string
}

type CommandHooks = {
  onStarted?: (agent: AgentLike) => void | Promise<void>
  onStopped?: () => void
  prepareWorkspace?: (cwd: string) => Promise<void>
}

type CommandsService = {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
}

type P2Context = Context & {
  commands: CommandsService
  tools?: ToolsService
  agents?: AgentsService
  get?: (name: string) => unknown
}

type PromptSection = {
  name: string
  order: number
  text: string | (() => string)
  interpolate?: boolean
  complete?: boolean
}

type PromptContext = {
  name: string
  order: number
  text: string | (() => string)
  interpolate?: boolean
  required?: boolean
}

type SystemPromptService = {
  section(section: PromptSection): () => void
  context(context: PromptContext): () => void
}

type GoalViewLike = {
  phase?: string
  activation?: string
}

type GoalsService = {
  get(agent: unknown): GoalViewLike | undefined
}

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
  source: { kind: 'p2-runtime' }
}

type AgentsService = {
  get(id: string): {
    /** Live DSH agent identity; present in real agents, optional in test doubles. */
    id?: string
    session?: { id: string; header?: { cwd?: string } }
    /** Agent-scoped services; absent in older test doubles. */
    ctx?: { get(name: string): unknown }
    /** Live DSH lifecycle state; absent in older test doubles. */
    status?: 'idle' | 'running'
    followup(message: WakeMessage): void
    steer?(message: WakeMessage): void
    /** Attach context to a running turn without waking it. */
    inject?(message: WakeMessage): void
  } | undefined
}

export type P2PluginOptions = {
  bodyEntry?: string
  spawnBody?: BodySpawner
  heartbeatMs?: number
  stopTimeoutMs?: number
  /** Timeout for one body request; tests use a short value for fast faults. */
  requestTimeoutMs?: number
  /** The body connects the MC provider before hello; give start its own budget. */
  startTimeoutMs?: number
  /** How long a fault waits for the old body process to exit before restarting. */
  faultExitTimeoutMs?: number
  /** Cross-process single-body lock directory; tests inject a temp directory. */
  lockDir?: string
  lockStaleMs?: number
  lockHeartbeatMs?: number
  log?: (line: string) => void
  /**
   * Register the global `p2_body` lifecycle tool. It must exist before a body
   * does: while inactive any session may start one; once active, only the
   * owner session may control it.
   */
  bodyControl?: boolean
  /** Bounded automatic body restart after a fault. */
  autoRestart?: boolean
  /** Development-only: auto-restart backoff schedule (tests use a zero schedule). */
  restartBackoffMs?: number[]
  /** Packaged templates copied into a missing workspace; tests may override. */
  templatesDir?: string
  /** Test seam: use a temporary P2 workspace instead of the owner session cwd. */
  workspaceDir?: string
  /** Test seam: local clock for auto-wake. */
  now?: () => number
  /** Test seam: auto-wake local tick interval. */
  autoWakeTickMs?: number
}

export function createP2Plugin(options: P2PluginOptions = {}): {
  name: string
  inject: string[]
  apply(ctx: P2Context): void
} {
  let notifyBodyFault: ((fault: BodyFault) => void) | undefined
  let notifyBodyRestart: ((info: RestartInfo) => void) | undefined
  const manager = new BodyManager({
    bodyEntry: options.bodyEntry ?? fileURLToPath(new URL('./body/body.mjs', import.meta.url)),
    ...(options.spawnBody === undefined ? {} : { spawnBody: options.spawnBody }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
    ...(options.faultExitTimeoutMs === undefined ? {} : { faultExitTimeoutMs: options.faultExitTimeoutMs }),
    ...(options.lockDir === undefined ? {} : { lockDir: options.lockDir }),
    ...(options.lockStaleMs === undefined ? {} : { lockStaleMs: options.lockStaleMs }),
    ...(options.lockHeartbeatMs === undefined ? {} : { lockHeartbeatMs: options.lockHeartbeatMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
    autoRestart: {
      enabled: options.autoRestart === true,
      ...(options.restartBackoffMs === undefined ? {} : { backoffMs: options.restartBackoffMs }),
    },
    onFault: fault => notifyBodyFault?.(fault),
    onRestart: info => notifyBodyRestart?.(info),
  })

  return {
    name: 'dsh-minecraft-p2',
    inject: ['commands', 'tools', 'agents'],
    apply(ctx: P2Context): void {
      const repeat = new RepeatTracker()
      const contractSessions = new Set<string>()
      const personaInjectedSessions = new Set<string>()
      const packageRoot = resolvePackageRoot()
      const templatesDir = options.templatesDir ?? join(packageRoot, 'content', 'templates')
      const packagedSkills: PackagedSkillSource[] = loadPackagedSkills(packageRoot)
      let registeredAgent: AgentLike | undefined
      let registeredKey: string | undefined
      let registeredWorkspace: string | undefined
      let autoWakeScheduler: AutoWakeScheduler | undefined
      let chatCursor = 0
      let chatTimer: ReturnType<typeof setInterval> | undefined
      let chatPolling = false
      let perceptionCursor = 0
      let perceptionPolling = false
      let perceptionTimer: ReturnType<typeof setTimeout> | undefined
      const pendingPerception: string[] = []
      let perceptionFirstAt = 0
      let startChatPolling: (() => void) | undefined
      let stopChatPolling: (() => void) | undefined
      const pendingNormal: string[] = []
      const completion = new CompletionFeed()
      const pendingCompletion: CompletionItem[] = []
      let completionTimer: ReturnType<typeof setTimeout> | undefined
      let completionUnavailable = false
      let mindPolling = false
      /** Runtime faults steer a running owner; idle owners get a follow-up turn. */
      const wakeMessage = (text: string): WakeMessage => ({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'p2-runtime' },
      })
      const followup = (text: string): boolean => {
        const owner = manager.currentOwner
        if (owner === undefined) return false
        const agent = ctx.agents?.get(owner.sessionId)
        if (agent === undefined) return false
        try {
          agent.followup(wakeMessage(text))
          return true
        } catch (cause) {
          options.log?.(`p2 runtime wake failed: ${formatError(cause)}`)
          return false
        }
      }
      const flushPendingNormal = (): void => {
        if (pendingNormal.length === 0) return
        const owner = manager.currentOwner
        if (owner === undefined) return
        const agent = ctx.agents?.get(owner.sessionId)
        if (agent === undefined || agent.status !== 'idle') return
        const text = pendingNormal.splice(0).join('\n\n')
        followup(text)
      }
      const deliverWake = (text: string, kind: 'normal' | 'critical' = 'normal'): void => {
        const owner = manager.currentOwner
        if (owner === undefined) return
        const agent = ctx.agents?.get(owner.sessionId)
        if (agent === undefined) return
        const status = agent.status ?? 'idle'
        if (kind === 'critical' && status === 'running' && agent.steer !== undefined) {
          try {
            agent.steer(wakeMessage(text))
          } catch (cause) {
            options.log?.(`p2 runtime steer failed: ${formatError(cause)}`)
          }
          return
        }
        if (status === 'idle') {
          followup(text)
          return
        }
        // Normal notices wait for the current turn to finish; never interrupt it.
        pendingNormal.push(text)
        if (pendingNormal.length > 8) pendingNormal.splice(0, pendingNormal.length - 8)
      }
      const clearCompletionTimer = (): void => {
        if (completionTimer !== undefined) clearTimeout(completionTimer)
        completionTimer = undefined
      }
      const flushCompletion = (): void => {
        clearCompletionTimer()
        if (pendingCompletion.length === 0) return
        const items = pendingCompletion.splice(0)
        deliverWake(formatCompletionWake(items, manager.bodyEpoch), 'normal')
      }
      const deliverCompletion = (items: CompletionItem[], epoch: string | undefined): void => {
        if (items.length === 0) return
        const owner = manager.currentOwner
        if (owner !== undefined) annotateCompletion(items, repeat, owner.sessionId)
        if (!items.some(item => item.severity === 'critical')) {
          // Successful results are merged into one digest; a finished job does
          // not wake a running turn by itself. The window starts at the first
          // pending result so a later success cannot delay it past 1 s.
          pendingCompletion.push(...items)
          if (completionTimer === undefined) {
            completionTimer = setTimeout(flushCompletion, 250)
            completionTimer.unref?.()
          }
          return
        }
        // Critical results never wait for the merge window, but pending normal
        // results ride along so a restart or failure wake does not drop them.
        const merged = [...pendingCompletion.splice(0), ...items]
        clearCompletionTimer()
        deliverWake(formatCompletionWake(merged, epoch), 'critical')
      }
      const resetCompletion = (): void => {
        pendingCompletion.length = 0
        clearCompletionTimer()
        completion.reset()
        completionUnavailable = false
      }
      const chatBatcher = new ChatBatcher(messages => {
        const lines = messages.map(message => `${message.username}: ${message.message}`).join('\n')
        deliverWake(
          `[p2 chat]\n${lines}\n用 p2_say 回复；短句、保持人格；只提真正记录过的事，不确定就说不知道。需要改变目标时用 p2_order / p2_cancel。`,
        )
      })
      notifyBodyFault = fault => {
        stopChatPolling?.()
        stopAutoWake?.()
        pendingNormal.length = 0
        resetCompletion()
        const owner = manager.currentOwner
        if (owner !== undefined) repeat.reset(owner.sessionId)
        const next = fault.autoRestart === 'scheduled'
          ? 'Auto-restarting within the restart budget.'
          : fault.autoRestart === 'exhausted'
            ? 'Auto-restart budget is exhausted; start a new body manually with /p2 start.'
            : 'Start a new body manually with /p2 start.'
        const detail = fault.detail === undefined ? '' : ` detail=${boundedText(fault.detail)}`
        deliverWake(
          `[p2 runtime] body faulted (${fault.reason})${detail} epoch=${fault.epoch ?? 'none'}; control state is unknown and was lost with the epoch. ${next}`,
          'critical',
        )
      }
      notifyBodyRestart = info => {
        chatCursor = 0
        perceptionCursor = 0
        pendingNormal.length = 0
        resetCompletion()
        const owner = manager.currentOwner
        if (owner !== undefined) repeat.reset(owner.sessionId)
        startChatPolling?.()
        if (owner !== undefined) {
          const current = ctx.agents?.get(owner.sessionId)
          if (current !== undefined) {
            const agent: AgentLike = {
              id: current.id ?? owner.agentId,
              session: current.session ?? { id: owner.sessionId, header: { cwd: owner.cwd } },
              ...(current.status === undefined ? {} : { status: current.status }),
              ...(current.ctx === undefined ? {} : { ctx: current.ctx }),
            }
            void ensureOwnerSession(agent).catch(error => {
              options.log?.(`p2 owner session restart failed: ${formatError(error)}`)
            })
          }
        }
        deliverWake(
          `[p2 runtime] body restarted with new epoch ${info.epoch} (attempt ${info.attempt}/${info.maxRestarts} in window). Control state is empty; P2Mind will rebuild it from the world.`,
          'critical',
        )
      }

      const pollChat = async (): Promise<void> => {
        flushPendingNormal()
        if (chatPolling || manager.currentState !== 'active') return
        chatPolling = true
        try {
          const result = await manager.chatPoll(chatCursor) as unknown as {
            messages?: ChatMessage[]
            seq?: number
          }
          const messages = result.messages ?? []
          if (messages.length > 0) {
            chatCursor = messages[messages.length - 1]?.seq ?? chatCursor
            for (const message of messages) chatBatcher.add(message)
          }
        } catch (error) {
          // Polling is a side channel; a transient body failure must not fault it.
          options.log?.(`p2 chat poll failed: ${formatError(error)}`)
        } finally {
          chatPolling = false
          flushPendingNormal()
        }
      }
      const flushPerception = (): void => {
        if (perceptionTimer !== undefined) clearTimeout(perceptionTimer)
        perceptionTimer = undefined
        perceptionFirstAt = 0
        if (pendingPerception.length === 0) return
        const lines = pendingPerception.splice(0)
        deliverWake(
          `[p2 perception][DIGEST]\n${lines.join('\n')}\nNo immediate action required; assess after current work.`,
          'normal',
        )
      }
      const schedulePerception = (): void => {
        const at = Date.now()
        if (perceptionFirstAt === 0) perceptionFirstAt = at
        if (perceptionTimer !== undefined) clearTimeout(perceptionTimer)
        const wait = Math.max(0, Math.min(1_000, 3_000 - (at - perceptionFirstAt)))
        perceptionTimer = setTimeout(flushPerception, wait)
        perceptionTimer.unref?.()
      }
      const pollPerception = async (): Promise<void> => {
        if (perceptionPolling || manager.currentState !== 'active') return
        perceptionPolling = true
        try {
          const result = await manager.perceptionPoll(perceptionCursor) as unknown as {
            notices?: Array<{ seq: number; kind: string; severity: string; summary: string; at: number }>
          }
          for (const notice of result.notices ?? []) {
            perceptionCursor = Math.max(perceptionCursor, notice.seq)
            if (notice.severity === 'critical') {
              deliverWake(
                [
                  '[p2 perception][IMMEDIATE]',
                  `- ${notice.kind}: ${notice.summary}`,
                  'FIRST ACTION (do not call p2_observe first):',
                  'FIGHT only if your combat ROE already allows this target:',
                  '  p2_order {verb:"attack", params:{entityId:"<id from summary>"}}',
                  'FLIGHT is the default without ROE / low health / creeper / multiple threats:',
                  '  p2_order {verb:"go", params:{x:<safe> y:<safe> z:<safe>}} or p2_cancel',
                  'Then verify; never auto-attack without an explicit combat order.',
                ].join('\n'),
                'critical',
              )
            } else {
              pendingPerception.push(`- ${notice.kind}: ${notice.summary}`)
              schedulePerception()
            }
          }
        } catch (error) {
          options.log?.(`p2 perception poll failed: ${formatError(error)}`)
        } finally {
          perceptionPolling = false
        }
      }
      const pollMind = async (): Promise<void> => {
        if (mindPolling || manager.currentState !== 'active') return
        const epoch = manager.bodyEpoch
        if (completion.attach(epoch)) {
          // A new body epoch starts a fresh event ring and cursor; results
          // queued for the old epoch are no longer actionable.
          pendingCompletion.length = 0
          clearCompletionTimer()
          completionUnavailable = false
        }
        if (completionUnavailable) return
        mindPolling = true
        try {
          const result = await manager.mindEvents(completion.cursor) as unknown as {
            events?: MindEventView[]
          }
          deliverCompletion(completion.accept(result.events ?? []), epoch)
        } catch (error) {
          if (error instanceof BodyClientError && error.error.code === 'MIND_UNAVAILABLE') {
            // A providerless test body has no mind; do not log every 300 ms.
            completionUnavailable = true
            options.log?.('p2 completion polling disabled: this body has no mind runtime')
          } else {
            options.log?.(`p2 completion poll failed: ${formatError(error)}`)
          }
        } finally {
          mindPolling = false
        }
      }
      startChatPolling = (): void => {
        if (chatTimer !== undefined) return
        perceptionCursor = 0
        chatTimer = setInterval(() => {
          void pollChat()
          void pollPerception()
          void pollMind()
        }, 300)
        chatTimer.unref?.()
        void pollChat()
        void pollPerception()
        void pollMind()
      }
      stopChatPolling = (): void => {
        if (chatTimer !== undefined) clearInterval(chatTimer)
        chatTimer = undefined
        if (perceptionTimer !== undefined) clearTimeout(perceptionTimer)
        perceptionTimer = undefined
        pendingPerception.length = 0
        perceptionFirstAt = 0
        perceptionCursor = 0
        chatBatcher.stop()
        pendingNormal.length = 0
        resetCompletion()
      }

      const globalDisposers: Array<() => void> = []
      const registrations: Array<{ dispose(): void }> = []
      const personaFallbackText = readPersonaTemplate(templatesDir)
      const prepareWorkspace = (cwd: string): Promise<void> => ensureWorkspace(
        options.workspaceDir ?? cwd,
        templatesDir,
        options.log,
      ).then(() => {})
      /** Body start is the only point that adds P2-specific context to a session. */
      const injectOperatorContract = (agent: AgentLike): void => {
        const sessionId = agent.session.id
        if (contractSessions.has(sessionId)) return
        contractSessions.add(sessionId)
        const target = agent as AgentLike & { inject?: (message: WakeMessage) => void }
        if (target.inject === undefined) return
        try {
          target.inject(wakeMessage(OPERATOR_CONTRACT))
        } catch (cause) {
          options.log?.(`p2 operator contract injection failed: ${formatError(cause)}`)
        }
      }
      const injectPersonaFallback = (agent: AgentLike, text: string): void => {
        const sessionId = agent.session.id
        if (personaInjectedSessions.has(sessionId)) return
        personaInjectedSessions.add(sessionId)
        const target = agent as AgentLike & { inject?: (message: WakeMessage) => void }
        if (target.inject === undefined) return
        try {
          target.inject(wakeMessage(text))
        } catch (cause) {
          options.log?.(`p2 persona fallback injection failed: ${formatError(cause)}`)
        }
      }
      const stopAutoWake = (): void => {
        autoWakeScheduler?.stop()
        autoWakeScheduler = undefined
      }
      const disposeTools = (): void => {
        stopAutoWake()
        for (const registration of registrations.splice(0)) registration.dispose()
        registeredAgent = undefined
        registeredKey = undefined
        registeredWorkspace = undefined
      }
      const currentAgentStatus = (): 'idle' | 'running' | 'missing' => {
        const owner = manager.currentOwner
        if (owner === undefined) return 'missing'
        const agent = ctx.agents?.get(owner.sessionId)
        if (agent === undefined) return 'missing'
        return agent.status ?? 'idle'
      }
      const goalIsActive = (agent: unknown): boolean => {
        const goals = getService<GoalsService>(ctx, 'goals')
        if (goals === undefined) return false
        try {
          const goal = goals.get(agent)
          return goal?.phase === 'active' && goal.activation === 'armed'
        } catch {
          return false
        }
      }
      const startAutoWake = async (agent: AgentLike, workspaceDir: string): Promise<void> => {
        if (autoWakeScheduler !== undefined) return
        const config = await loadAutoWakeConfig(workspaceDir, options.log)
        if (!config.enabled) return
        const probe = async (lastWake: AutoWakeActivity | undefined): Promise<AutoWakeGateResult> => {
          const owner = manager.currentOwner
          if (owner === undefined) return { ok: false, reason: 'no-owner' }
          const current = ctx.agents?.get(owner.sessionId)
          if (current === undefined) return { ok: false, reason: 'agent-missing' }
          const result = await manager.status().catch(() => undefined)
          const status = result !== undefined && result.state === 'active' ? result.status : undefined
          const pending = pendingNormal.length > 0
            || pendingCompletion.length > 0
            || pendingPerception.length > 0
          return evaluateAutoWakeGate({
            now: (options.now ?? Date.now)(),
            config,
            bodyState: manager.currentState,
            agentStatus: current.status ?? 'idle',
            ownerPresent: true,
            status,
            pendingWake: pending,
            goalActive: goalIsActive(current),
            lastWake,
          })
        }
        const scheduler = new AutoWakeScheduler({
          config,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.autoWakeTickMs === undefined ? {} : { tickMs: options.autoWakeTickMs }),
          getAgentStatus: currentAgentStatus,
          probe,
          wake: text => followup(text),
          log: entry => writeWakeLog(workspaceDir, entry, options.log),
        })
        autoWakeScheduler = scheduler
        scheduler.start()
      }
      const ensureOwnerSession = async (agent: AgentLike): Promise<void> => {
        const owner = ownerOf(agent)
        const workspaceDir = options.workspaceDir ?? owner.cwd
        try {
          await ensureWorkspace(workspaceDir, templatesDir, options.log)
        } catch (error) {
          options.log?.(`p2 workspace init failed: ${formatError(error)}`)
        }
        const result = await manager.status().catch(() => undefined)
        const status = result !== undefined && result.state === 'active' ? result.status : undefined
        const identity = status?.mind?.identity
        const target = manager.target
        const scope = identity ?? {
          worldId: target === undefined ? 'unknown' : formatTarget(target),
          characterId: 'unknown',
        }
        if (identity === undefined) {
          options.log?.('p2 memory scope fallback: mind identity unavailable; using target/unknown')
        }
        const key = [
          agent.session.id,
          agent.id,
          owner.cwd,
          workspaceDir,
          target === undefined ? 'none' : formatTarget(target),
          scope.worldId,
          scope.characterId,
        ].join('|')
        if (registeredAgent === agent && registeredKey === key) {
          await startAutoWake(agent, workspaceDir)
          return
        }
        disposeTools()
        const ownerTools = getService<ToolsService>(agent.ctx, 'tools')
        const toolsService = ownerTools ?? ctx.tools
        if (toolsService === undefined) {
          options.log?.('p2 tools were not registered (tools service unavailable)')
          return
        }
        const memoryStore = new MemoryStore({
          path: memoryFilePath(workspaceDir, scope),
          scope,
          ...(options.log === undefined ? {} : { log: options.log }),
        })
        const persona = new PersonaProvider({
          path: workspacePaths(workspaceDir).persona,
          fallbackText: personaFallbackText,
          onChange: read => {
            if (read.truncated) options.log?.(`p2 persona truncated to 4096 bytes from ${read.path ?? 'default'}`)
          },
        })
        registrations.push(registerP2Tools(agent, manager, toolsService, repeat))
        registrations.push({ dispose: registerMemoryTool(agent, toolsService, memoryStore) })
        const skillDisposers = registerPackagedSkills(agent, packagedSkills)
        if (skillDisposers.length === 0 && packagedSkills.length > 0) {
          options.log?.('p2 packaged skills were not registered (skills service unavailable)')
        }
        for (const dispose of skillDisposers) registrations.push({ dispose })
        const workspaceSkills = await registerWorkspaceSkills(
          agent,
          workspacePaths(workspaceDir).skillsDir,
          options.log,
        )
        if (!workspaceSkills.hotReload) {
          options.log?.('p2 workspace skills use a start-only scan (no dynamic provider API)')
        }
        registrations.push({ dispose: workspaceSkills.dispose })
        const systemPrompt = getService<SystemPromptService>(agent.ctx, 'systemPrompt')
        if (systemPrompt !== undefined) {
          registrations.push({
            dispose: systemPrompt.section({
              name: 'p2:persona',
              order: 100,
              text: () => persona.read().text,
              interpolate: false,
            }),
          })
          registrations.push({
            dispose: systemPrompt.context({
              name: 'p2:memory',
              order: 130,
              text: () => memoryStore.summary(),
              interpolate: false,
            }),
          })
        } else {
          injectPersonaFallback(agent, persona.read().text)
          options.log?.('p2 systemPrompt unavailable; memory summary is not injected')
        }
        injectOperatorContract(agent)
        registeredAgent = agent
        registeredKey = key
        registeredWorkspace = workspaceDir
        await startAutoWake(agent, workspaceDir)
      }

      if (options.bodyControl === true && ctx.tools !== undefined) {
        globalDisposers.push(ctx.tools.register(createBodyTool(manager, {
          ensureTools: ensureOwnerSession,
          disposeTools,
          startChatPolling: () => startChatPolling?.(),
          stopChatPolling: () => stopChatPolling?.(),
          prepareWorkspace: (cwd: string) => prepareWorkspace(cwd),
        })))
      }

      ctx.effect(
        () => ctx.commands.register({
          name: 'p2',
          description: 'Manage the P2 Minecraft player runtime',
          input: { hint: '<setup|start|status|stop>' },
          handler: invocation => handleP2Command(manager, invocation, {
            onStarted: async agent => {
              await ensureOwnerSession(agent)
              startChatPolling?.()
            },
            onStopped: () => {
              stopChatPolling?.()
              disposeTools()
            },
            prepareWorkspace: (cwd: string) => prepareWorkspace(cwd),
          }),
        }),
        'p2.commands',
      )
      ctx.effect(
        () => async () => {
          notifyBodyFault = undefined
          notifyBodyRestart = undefined
          stopChatPolling?.()
          disposeTools()
          for (const dispose of globalDisposers.splice(0)) dispose()
          await manager.dispose()
        },
        'p2.body',
      )

    },
  }
}

/** Development-only global tool; the human `/p2` command remains the shipped path. */
type BodyToolHooks = {
  ensureTools: (agent: AgentLike) => Promise<void>
  disposeTools: () => void
  startChatPolling: () => void
  stopChatPolling: () => void
  prepareWorkspace: (cwd: string) => Promise<void>
}

function createBodyTool(manager: BodyManager, hooks: BodyToolHooks): ToolDefinition {
  return {
    name: 'p2_body',
    description: 'P2 body lifecycle. start requires host/port and both starts the body and connects it to that Minecraft server. restart stops and starts again; omit host/port to reuse the last target. stop closes the body process (there is no separate disconnect). A new start/restart creates a new epoch: tracker/job state and the order queue are not restored; P2Mind rebuilds from the world. After a restart, observe before ordering again and do not replay the last order blindly. While the body is inactive any session may start it; once active only the owner session may control it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'status'], description: 'Body lifecycle action' },
        host: { type: 'string', description: 'MC server host for start/restart; required for start' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'MC server port for start/restart; required for start' },
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
        const parsed = parseTargetFields(args.host, args.port)
        if ('error' in parsed) throw new Error(parsed.error)
        const cwd = agent.session.header?.cwd
        if (cwd !== undefined) await hooks.prepareWorkspace(cwd)
        const result = await startBody(manager, agent, parsed.target)
        await hooks.ensureTools(agent)
        hooks.startChatPolling()
        return { action, ...result, target: formatTarget(parsed.target), status: await bodyStatus(manager) }
      }
      if (action === 'restart') {
        assertBodyOwner(manager, agent.session.id)
        const hasTarget = args.host !== undefined || args.port !== undefined
        let target: McTarget | undefined
        if (hasTarget) {
          const parsed = parseTargetFields(args.host, args.port)
          if ('error' in parsed) throw new Error(parsed.error)
          target = parsed.target
        } else {
          target = manager.target
          if (target === undefined) throw new Error('restart requires host/port; no previous target is known')
        }
        const stopped = await stopBody(manager)
        if (stopped.state === 'faulted') return { action, ...stopped }
        hooks.disposeTools()
        const cwd = agent.session.header?.cwd
        if (cwd !== undefined) await hooks.prepareWorkspace(cwd)
        const result = await startBody(manager, agent, target)
        await hooks.ensureTools(agent)
        hooks.startChatPolling()
        return { action, ...result, target: formatTarget(target), status: await bodyStatus(manager) }
      }
      if (action === 'stop') {
        assertBodyOwner(manager, agent.session.id)
        const result = await stopBody(manager)
        hooks.stopChatPolling()
        hooks.disposeTools()
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
    const target = manager.target === undefined ? 'unknown target' : formatTarget(manager.target)
    throw new Error(
      `P2 body is owned by a different session (session ${current.sessionId}, agent ${current.agentId}, ${target}); `
      + 'ask that owner to stop it first',
    )
  }
}

async function bodyStatus(manager: BodyManager): Promise<JsonValue> {
  if (manager.currentState === 'faulted') {
    const result = await manager.status()
    const fault = result.state === 'faulted' ? result.fault ?? null : null
    return { state: 'faulted', locks: await manager.locks(), fault } as unknown as JsonValue
  }
  if (manager.currentState !== 'active') {
    return { state: manager.currentState, locks: await manager.locks() }
  }
  const status = await manager.status()
  if (status.state !== 'active') {
    return {
      state: status.state,
      locks: await manager.locks(),
      ...(status.state === 'faulted' && status.fault !== undefined ? { fault: status.fault } : {}),
    } as unknown as JsonValue
  }
  return {
    state: 'active',
    epoch: manager.bodyEpoch ?? null,
    target: manager.target === undefined ? null : formatTarget(manager.target),
    owner: status.status.owner?.sessionId ?? null,
    lock: manager.lockInfo ?? null,
    lastDisconnect: status.status.providerState?.lastDisconnect ?? null,
    providerState: status.status.providerState ?? null,
  } as unknown as JsonValue
}

async function startBody(manager: BodyManager, agent: AgentLike, target?: McTarget): Promise<StartResult> {
  const owner = ownerOf(agent)
  if (manager.currentState === 'active') {
    const current = manager.currentOwner
    if (current !== undefined && (current.sessionId !== owner.sessionId || current.agentId !== owner.agentId)) {
      const target = manager.target === undefined ? 'unknown target' : formatTarget(manager.target)
      throw new Error(
        `P2 body is owned by a different session (session ${current.sessionId}, agent ${current.agentId}, ${target}); `
        + 'ask that owner to stop it first',
      )
    }
    if (target !== undefined) {
      const currentTarget = manager.target
      if (currentTarget === undefined || currentTarget.host !== target.host || currentTarget.port !== target.port) {
        throw new Error(`P2 body is already active at ${currentTarget === undefined ? 'an unknown target' : formatTarget(currentTarget)}; use restart`)
      }
    }
    return { state: 'active', epoch: manager.bodyEpoch ?? '' }
  }
  return manager.start(owner, target)
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
        return success('P2 commands: /p2 setup | start <host>:<port> | status | stop')
      case 'setup':
        return setup(invocation.agent)
      case 'start': {
        const parsed = parseTargetArgs(rest)
        if ('error' in parsed) return error(parsed.error)
        const cwd = invocation.agent.session.header?.cwd
        if (cwd !== undefined) await hooks.prepareWorkspace?.(cwd)
        const result = await startBody(manager, invocation.agent, parsed.target)
        await hooks.onStarted?.(invocation.agent)
        return success(`P2 body active at ${formatTarget(parsed.target)} (epoch ${result.epoch})`)
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
  if (manager.currentState === 'faulted') {
    const result = await manager.status()
    const fault = result.state === 'faulted' ? result.fault : undefined
    const detail = fault?.detail === undefined ? '' : ` detail=${boundedText(fault.detail)}`
    return `P2 body faulted${fault === undefined ? '' : ` (${fault.reason})${detail}`}`
  }
  if (manager.currentState !== 'active') {
    const locks = await manager.locks()
    const locked = locks.length === 0
      ? ''
      : `; locked=${locks.map(lock => `${formatTarget({ host: lock.host, port: lock.port })} by ${lock.ownerSessionId}`).join(',')}`
    return `P2 body ${manager.currentState}${locked}`
  }
  const result = await manager.status()
  if (result.state !== 'active') return `P2 body ${result.state}`
  const status = result.status
  return [
    'P2 body active',
    `epoch=${status.bodyEpoch}`,
    `target=${manager.target === undefined ? 'unknown' : formatTarget(manager.target)}`,
    `owner=${status.owner?.sessionId ?? 'none'}`,
    `health=${status.health}`,
    `paused=${status.providerState?.paused ?? false}`,
  ].join(' ')
}

function boundedText(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}...`
}

function readPersonaTemplate(templatesDir: string): string {
  try {
    return readFileSync(join(templatesDir, 'persona.md'), 'utf8').trim()
  } catch {
    return '你是 P2，Minecraft 世界里的第二个玩家。'
  }
}

/**
 * The built bridge lives in `lib/bridge.js`; source tests live in
 * `src/bridge/plugin.ts`. Prefer the directory that actually contains
 * `content/templates/` so both layouts find the packaged templates.
 */
function resolvePackageRoot(): string {
  const moduleRoot = fileURLToPath(new URL('..', import.meta.url))
  if (existsSync(join(moduleRoot, 'content', 'templates'))) return moduleRoot
  return fileURLToPath(new URL('../../', import.meta.url))
}

function writeWakeLog(
  workspaceDir: string,
  entry: AutoWakeLogEntry,
  log: ((line: string) => void) | undefined,
): void {
  const path = join(workspaceDir, '.p2', 'wake.jsonl')
  void appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8').catch(error => {
    log?.(`p2 auto-wake log failed: ${formatError(error)}`)
  })
}

function getService<T>(
  context: { get?: (name: string) => unknown } | undefined,
  name: string,
): T | undefined {
  if (context?.get === undefined) return undefined
  try {
    return context.get(name) as T | undefined
  } catch {
    return undefined
  }
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
