import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { BodyServer } from '../src/body/server.ts'
import type { MindRuntime } from '../src/body/mind.ts'
import { BodyManager } from '../src/bridge/process-manager.ts'
import type { BodyHandle } from '../src/bridge/process-manager.ts'
import { createP2Plugin } from '../src/bridge/plugin.ts'
import { CompletionFeed, formatCompletionWake } from '../src/bridge/completion-wake.ts'
import { ensureFailureObserved } from '../src/mind/failure.ts'
import {
  PROTOCOL_VERSION,
  bodyManifestDigest,
  createMemoryTransportPair,
} from '../src/contracts/index.ts'
import type { BodyInfo, BodyManifest, JsonValue, MessageTransport, MindEventsResult } from '../src/contracts/index.ts'
import type { AgentLike, ToolDefinition } from '../src/bridge/tools.ts'

const manifest: BodyManifest = {
  schemaVersion: 1,
  bodyVersion: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  entry: 'body.mjs',
  files: { 'body.mjs': 'a'.repeat(64) },
}

const body: BodyInfo = {
  manifest,
  manifestDigest: bodyManifestDigest(manifest),
  bindingId: null,
  capabilities: [],
  provider: null,
}

const owner = { sessionId: 'session-1', agentId: 'agent-1', cwd: process.cwd() }
const lockDirs: string[] = []
const workspaceDirs: string[] = []

afterEach(() => {
  for (const dir of lockDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const dir of workspaceDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempLockDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-completion-lock-'))
  lockDirs.push(dir)
  return dir
}

function tempWorkspace(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-completion-workspace-'))
  workspaceDirs.push(dir)
  return dir
}

type MindEvent = MindEventsResult['events'][number]

function event(seq: number, kind: string, data: JsonValue): MindEvent {
  return { seq, at: seq, kind, data }
}

function createCompletionFeedTest(): void {
  describe('completion feed', () => {
    it('uses the job orderId instead of the currently active order', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'order.accepted', { kind: 'order.accepted', orderId: 'ord-A' }),
        event(2, 'job.terminal', {
          kind: 'job.terminal',
          orderId: 'ord-B',
          driverId: 'move',
          state: 'failed',
          code: 'NO_PATH',
          blocked: false,
        }),
        event(3, 'order.terminal', { kind: 'order.terminal', orderId: 'ord-B', state: 'failed' }),
      ])
      expect(items).toHaveLength(1)
      expect(items[0]?.payload).toMatchObject({
        orderId: 'ord-B',
        cause: { orderId: 'ord-B', reason: 'NO_PATH' },
      })
    })

    it('ignores an intermediate retry job terminal', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'job.terminal', {
          kind: 'job.terminal',
          driverId: 'move',
          state: 'failed',
          code: 'NO_PATH',
          blocked: false,
          retry: true,
        }),
      ])
      expect(items).toHaveLength(0)
    })

    it('wakes on duty terminal but skips a replaced cancellation', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'duty.terminal', {
          id: 'duty-1', kind: 'gather', item: 'dirt', state: 'blocked', collected: 2, quota: 8,
          lastError: 'DUTY_NO_SOURCE',
        }),
        event(2, 'duty.terminal', {
          id: 'duty-0', kind: 'gather', item: 'dirt', state: 'cancelled',
          lastError: 'REPLACED_BY_NEW_DUTY',
        }),
      ])
      expect(items).toHaveLength(1)
      expect(items[0]?.severity).toBe('critical')
      expect(items[0]?.payload).toMatchObject({
        kind: 'duty.terminal',
        dutyId: 'duty-1',
        state: 'blocked',
        reason: 'DUTY_NO_SOURCE',
      })
    })

    it('reports a lost escort target once and ignores base/duty job noise', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'base.waiting', { reason: 'TARGET_LOST', target: 'Alice' }),
        event(2, 'job.terminal', {
          keys: 'base:wander:0,64,0:1', driverId: 'move', state: 'failed', code: 'GOTO_NO_PATH', blocked: false,
        }),
        event(3, 'job.terminal', {
          keys: 'duty:gather:dirt:1,64,0', driverId: 'dig', state: 'failed', code: 'DIG_PARTIAL', blocked: false,
        }),
      ])
      expect(items).toHaveLength(1)
      expect(items[0]?.severity).toBe('normal')
      expect(items[0]?.payload).toEqual({
        kind: 'base.waiting',
        reason: 'TARGET_LOST',
        target: 'Alice',
      })
    })

    it('wakes on a critical hold but not on a deliberate silent hold', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'mind.hold', { tree: 'constant', reason: 'NO_SAFE_TARGET', notify: true }),
        event(2, 'mind.hold', { tree: 'main', reason: 'HOLD_ORDER', notify: false }),
      ])
      expect(items).toHaveLength(1)
      expect(items[0]?.severity).toBe('critical')
      expect(items[0]?.payload).toEqual({
        kind: 'mind.hold',
        tree: 'constant',
        reason: 'NO_SAFE_TARGET',
      })
    })

    it('folds a failed job terminal into one structured order result', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'order.accepted', { kind: 'order.accepted', orderId: 'ord-1' }),
        event(2, 'job.terminal', {
          kind: 'job.terminal',
          runId: 'run-1',
          driverId: 'move',
          state: 'failed',
          code: 'NO_PATH',
          blocked: false,
          observed: { requested: { x: 1, y: 64, z: 1 } },
        }),
        event(3, 'order.terminal', { kind: 'order.terminal', orderId: 'ord-1', state: 'failed' }),
      ])

      expect(items).toHaveLength(1)
      expect(items[0]?.severity).toBe('critical')
      expect(items[0]?.payload).toEqual({
        kind: 'order.terminal',
        orderId: 'ord-1',
        state: 'failed',
        reason: 'NO_PATH',
        observed: { requested: { x: 1, y: 64, z: 1 } },
        cause: {
          kind: 'job.terminal',
          orderId: 'ord-1',
          runId: 'run-1',
          driverId: 'move',
          state: 'failed',
          code: 'NO_PATH',
          blocked: false,
          reason: 'NO_PATH',
        },
      })
    })

    it('keeps budget exhaustion facts on the failed order wake', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const observed = ensureFailureObserved({
        budget: { maxTicks: 100, maxWallMs: 1_000 },
        elapsedMs: 2_000,
        elapsedGameAge: 240,
      } as unknown as JsonValue, 'BUDGET_EXCEEDED', 'move')
      const items = feed.accept([
        event(1, 'order.accepted', { kind: 'order.accepted', orderId: 'ord-budget' }),
        event(2, 'job.terminal', {
          kind: 'job.terminal',
          runId: 'run-budget',
          driverId: 'move',
          state: 'failed',
          code: 'BUDGET_EXCEEDED',
          blocked: false,
          observed,
        }),
        event(3, 'order.terminal', { kind: 'order.terminal', orderId: 'ord-budget', state: 'failed' }),
      ])

      expect(items).toHaveLength(1)
      expect(items[0]?.payload).toMatchObject({
        kind: 'order.terminal',
        orderId: 'ord-budget',
        state: 'failed',
        failure: {
          layer: 'budget',
          code: 'BUDGET_EXCEEDED',
          cause: { kind: 'budget' },
          facts: {
            budget: { maxTicks: 100, maxWallMs: 1_000 },
            elapsedMs: 2_000,
            elapsedGameAge: 240,
          },
        },
      })
    })

    it('keeps a failed check observation when the job itself succeeded', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'order.accepted', { orderId: 'ord-check' }),
        event(2, 'job.terminal', {
          runId: 'run-check',
          driverId: 'check',
          state: 'succeeded',
          code: 'CHECK_OPEN_FAILED',
          blocked: false,
          observed: {
            kind: 'container',
            state: 'failed',
            code: 'CHECK_OPEN_FAILED',
            message: 'blocked',
            orderId: 'ord-check',
          },
        }),
        event(3, 'order.terminal', { orderId: 'ord-check', state: 'failed' }),
      ])

      expect(items).toHaveLength(1)
      expect(items[0]?.payload).toMatchObject({
        kind: 'order.terminal',
        orderId: 'ord-check',
        state: 'failed',
        reason: 'CHECK_OPEN_FAILED',
        observed: { state: 'failed', code: 'CHECK_OPEN_FAILED' },
        cause: { driverId: 'check', state: 'succeeded', code: 'CHECK_OPEN_FAILED' },
      })
    })

    it('ignores a successful job terminal and pushes one normal digest', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'order.accepted', { orderId: 'ord-2' }),
        event(2, 'job.terminal', { runId: 'run-2', driverId: 'move', state: 'succeeded' }),
        event(3, 'order.terminal', { orderId: 'ord-2', state: 'succeeded' }),
      ])

      expect(items).toEqual([
        {
          severity: 'normal',
          payload: { kind: 'order.terminal', orderId: 'ord-2', state: 'succeeded' },
        },
      ])
    })

    it('reports plan.blocked with the blocked work items and reasons', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'plan.blocked', {
          kind: 'plan.blocked',
          planId: 'plan-1',
          blocked: [{ id: 'wi-1', reason: 'CONFLICT', expected: 'dirt', current: 'chest' }],
          basis: { at: 7 },
        }),
      ])

      expect(items).toHaveLength(1)
      expect(items[0]?.severity).toBe('critical')
      expect(items[0]?.payload).toMatchObject({
        kind: 'plan.blocked',
        planId: 'plan-1',
        blocked: [{ id: 'wi-1', reason: 'CONFLICT' }],
      })
    })

    it('keeps a plan-work job failure when no order terminal follows', () => {
      const feed = new CompletionFeed()
      feed.attach('epoch-1')
      const items = feed.accept([
        event(1, 'order.accepted', { orderId: 'ord-3' }),
        event(2, 'job.terminal', {
          runId: 'run-3',
          driverId: 'place',
          state: 'failed',
          code: 'PLACE_REFUSED',
          blocked: true,
          observed: { at: { x: 2, y: 64, z: 2 } },
        }),
      ])

      expect(items).toHaveLength(1)
      expect(items[0]?.payload).toMatchObject({
        kind: 'job.terminal',
        orderId: 'ord-3',
        runId: 'run-3',
        driverId: 'place',
        state: 'failed',
        reason: 'PLACE_REFUSED',
        blocked: true,
      })
    })

    it('never delivers the same seq twice and resets the cursor per epoch', () => {
      const feed = new CompletionFeed()
      expect(feed.attach('epoch-1')).toBe(true)
      expect(feed.attach('epoch-1')).toBe(false)
      const first = feed.accept([event(4, 'order.terminal', { orderId: 'ord-4', state: 'failed' })])
      expect(first).toHaveLength(1)
      expect(feed.cursor).toBe(4)
      expect(feed.accept([event(4, 'order.terminal', { orderId: 'ord-4', state: 'failed' })])).toEqual([])

      expect(feed.attach('epoch-2')).toBe(true)
      expect(feed.cursor).toBe(0)
      expect(feed.accept([event(3, 'order.terminal', { orderId: 'ord-5', state: 'failed' })])).toHaveLength(1)
    })

    it('labels critical and digest wakes', () => {
      const critical = formatCompletionWake([{
        severity: 'critical',
        payload: { kind: 'order.terminal', orderId: 'ord-1', state: 'blocked', reason: 'NO_MATERIAL' },
      }], 'epoch-1')
      expect(critical).toContain('[p2 completion][CRITICAL] body epoch=epoch-1')
      expect(critical).toContain('"orderId":"ord-1"')
      expect(critical).toContain('Do not Start-Sleep')

      const digest = formatCompletionWake([{
        severity: 'normal',
        payload: { kind: 'order.terminal', orderId: 'ord-2', state: 'succeeded' },
      }])
      expect(digest).toContain('[p2 completion][DIGEST]')
      expect(digest).not.toContain('Start-Sleep')
    })
  })
}

type FakeMind = {
  runtime: MindRuntime
  push(kind: string, data: JsonValue): void
}

function createFakeMind(): FakeMind {
  const events: MindEvent[] = []
  let seq = 0
  let clock = 1_000
  const runtime = {
    tick() {},
    status: () => ({
      tracker: 'idle',
      job: null,
      fault: null,
      home: null,
      activeOrder: null,
      queuedOrders: 0,
      eventsSeq: seq,
      plan: null,
    }),
    report: () => null,
    enqueueOrder: () => ({ id: 'ord-1', state: 'active' }),
    cancelOrder: (id: string) => ({ id, state: 'cancelled' }),
    listOrders: () => ({ active: null, queued: [] }),
    sinceEvents: (sinceSeq: number, limit = 100) => ({
      events: events.filter(item => item.seq > sinceSeq).slice(0, limit),
      seq,
    }),
    watchedBlock: () => undefined,
    orders: {},
    events: {},
  } as unknown as MindRuntime
  return {
    runtime,
    push: (kind, data) => {
      seq += 1
      clock += 1
      events.push({ seq, at: clock, kind, data })
    },
  }
}

type FakeBody = {
  handle: BodyHandle
  runtime: BodyRuntime
  server: BodyServer
  mind: FakeMind
  setSilent(value: boolean): void
}

function createFakeBody(epoch: string, mind: FakeMind): FakeBody {
  const runtime = new BodyRuntime({ body, newEpoch: () => epoch, mind: mind.runtime })
  const [client, serverTransport] = createMemoryTransportPair()
  const server = new BodyServer(runtime, serverTransport)
  server.start()
  let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    resolveExit = resolve
  })
  server.onClose(() => resolveExit({ code: 0, signal: null }))
  let silent = false
  const transport: MessageTransport = {
    send: line => {
      if (!silent) client.send(line)
    },
    onLine: listener => client.onLine(listener),
    onError: listener => client.onError(listener),
    onClose: listener => client.onClose(listener),
    close: () => client.close(),
  }
  return {
    runtime,
    server,
    mind,
    setSilent: value => { silent = value },
    handle: {
      transport,
      kill: () => server.stop(),
      waitForExit: () => exit,
    },
  }
}

type Wake = {
  role: string
  content: Array<{ type: string; text: string }>
  source: { kind: string }
}

type OwnerScoped = {
  tools: Map<string, ToolDefinition>
  sections: Array<Record<string, unknown>>
  contexts: Array<Record<string, unknown>>
  skills: string[]
  disposedSections: number
  disposedContexts: number
  disposedSkills: number
}

type Harness = {
  bodies: FakeBody[]
  mind: FakeMind
  agent: AgentLike
  state: { status: 'idle' | 'running'; followups: Wake[]; steers: Wake[] }
  tools: Map<string, ToolDefinition>
  owner?: OwnerScoped
  start(): Promise<void>
  stop(): Promise<void>
}

type HarnessOptions = {
  devAutoRestart?: boolean
  restartBackoffMs?: number[]
  ownerScoped?: boolean
}

function createHarness(
  bodies: FakeBody[] = [createFakeBody('epoch-1', createFakeMind())],
  options: HarnessOptions = {},
): Harness {
  let spawns = 0
  const state: Harness['state'] = { status: 'idle', followups: [], steers: [] }
  const definitions: Array<{ handler: (input: { agent: AgentLike; rawInput: string }) => Promise<{ kind: string }> }> = []
  const tools = new Map<string, ToolDefinition>()
  const agent: AgentLike = { id: owner.agentId, session: { id: owner.sessionId, header: { cwd: owner.cwd } } }
  let ownerScoped: OwnerScoped | undefined
  if (options.ownerScoped === true) {
    ownerScoped = {
      tools: new Map(),
      sections: [],
      contexts: [],
      skills: [],
      disposedSections: 0,
      disposedContexts: 0,
      disposedSkills: 0,
    }
    const scoped = ownerScoped
    const services: Record<string, unknown> = {
      tools: {
        register: (definition: ToolDefinition) => {
          scoped.tools.set(definition.name, definition)
          return () => scoped.tools.delete(definition.name)
        },
      },
      skills: {
        register: (skill: Record<string, unknown>) => {
          scoped.skills.push(String(skill.name))
          return () => { scoped.disposedSkills += 1 }
        },
      },
      systemPrompt: {
        section: (section: Record<string, unknown>) => {
          scoped.sections.push(section)
          return () => { scoped.disposedSections += 1 }
        },
        context: (context: Record<string, unknown>) => {
          scoped.contexts.push(context)
          return () => { scoped.disposedContexts += 1 }
        },
      },
      goals: { get: () => undefined },
    }
    agent.ctx = { get: (name: string) => services[name] }
  }
  const agentApi = {
    get status() { return state.status },
    followup: (message: Wake) => { state.followups.push(message) },
    steer: (message: Wake) => { state.steers.push(message) },
  }
  const ctx = {
    commands: {
      register: (definition: typeof definitions[number]) => {
        definitions.push(definition)
        return () => {}
      },
    },
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    agents: {
      get: (id: string) => id === owner.sessionId ? agentApi : undefined,
    },
    effect: (callback: () => unknown) => {
      callback()
      return () => {}
    },
  }
  const plugin = createP2Plugin({
    bodyEntry: 'unused-body.mjs',
    heartbeatMs: 20,
    requestTimeoutMs: 200,
    lockDir: tempLockDir(),
    workspaceDir: tempWorkspace(),
    devAutoRestart: options.devAutoRestart === true,
    ...(options.restartBackoffMs === undefined ? {} : { restartBackoffMs: options.restartBackoffMs }),
    spawnBody: () => bodies[Math.min(spawns++, bodies.length - 1)]!.handle,
    log: () => {},
  })
  ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)

  return {
    bodies,
    mind: bodies[0]!.mind,
    agent,
    state,
    tools,
    ...(ownerScoped === undefined ? {} : { owner: ownerScoped }),
    async start() {
      const result = await definitions[0]!.handler({ agent, rawInput: ' start 127.0.0.1:25575' })
      expect(result.kind).toBe('success')
    },
    async stop() {
      await definitions[0]!.handler({ agent, rawInput: ' stop' })
    },
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function texts(wakes: Wake[]): string[] {
  return wakes.map(wake => wake.content[0]?.text ?? '')
}

function payloads(text: string): Array<Record<string, JsonValue>> {
  return text
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => JSON.parse(line.slice(2)) as Record<string, JsonValue>)
}

function completionTexts(wakes: Wake[]): string[] {
  return texts(wakes).filter(text => text.includes('[p2 completion]'))
}

describe('bridge completion wake', () => {
  createCompletionFeedTest()

  it('registers P2 tools, memory and persona on the owner scope and disposes them', async () => {
    const harness = createHarness(undefined, { ownerScoped: true })
    await harness.start()
    try {
      expect(harness.owner).toBeDefined()
      expect(harness.owner!.tools.has('p2_status')).toBe(true)
      expect(harness.owner!.tools.has('p2_order')).toBe(true)
      expect(harness.owner!.tools.has('p2_memory')).toBe(true)
      expect(harness.tools.has('p2_status')).toBe(false)
      expect(harness.tools.size).toBe(0)
      expect(harness.owner!.sections).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'p2:persona', order: 100, interpolate: false }),
      ]))
      expect(harness.owner!.contexts).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'p2:memory', order: 130, interpolate: false }),
      ]))
      expect(harness.owner!.skills).toEqual(expect.arrayContaining([
        'p2-operator', 'p2-persona', 'p2-memory', 'p2-wake', 'p2-subagent',
      ]))
    } finally {
      await harness.stop()
    }
    expect(harness.owner!.tools.size).toBe(0)
    expect(harness.owner!.disposedSections).toBe(1)
    expect(harness.owner!.disposedContexts).toBe(1)
    expect(harness.owner!.disposedSkills).toBe(5)
  })

  it('wakes an idle owner once with the failed order, observed and reason', async () => {
    const harness = createHarness()
    await harness.start()
    try {
      harness.mind.push('order.accepted', { orderId: 'ord-1' })
      harness.mind.push('job.terminal', {
        runId: 'run-1',
        driverId: 'move',
        state: 'failed',
        code: 'NO_PATH',
        blocked: false,
        observed: { requested: { x: 1, y: 64, z: 1 } },
      })
      harness.mind.push('order.terminal', { orderId: 'ord-1', state: 'failed' })
      await wait(700)

      expect(harness.state.followups).toHaveLength(1)
      expect(harness.state.steers).toHaveLength(0)
      const text = texts(harness.state.followups)[0] as string
      expect(text).toContain('[p2 completion][CRITICAL]')
      const lines = payloads(text)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        kind: 'order.terminal',
        orderId: 'ord-1',
        state: 'failed',
        reason: 'NO_PATH',
        observed: { requested: { x: 1, y: 64, z: 1 } },
      })
      expect(harness.state.followups[0]?.role).toBe('user')
      expect(harness.state.followups[0]?.source.kind).toBe('p2-runtime')
    } finally {
      await harness.stop()
    }
  })

  it('uses steer for a critical result while the owner is running', async () => {
    const harness = createHarness()
    await harness.start()
    try {
      harness.state.status = 'running'
      harness.mind.push('order.terminal', { orderId: 'ord-1', state: 'blocked' })
      await wait(700)

      expect(harness.state.steers).toHaveLength(1)
      expect(harness.state.followups).toHaveLength(0)
      expect(texts(harness.state.steers)[0]).toContain('[p2 completion][CRITICAL]')
    } finally {
      await harness.stop()
    }
  })

  it('holds a successful result while running and follows up once idle', async () => {
    const harness = createHarness()
    await harness.start()
    try {
      harness.state.status = 'running'
      harness.mind.push('job.terminal', { runId: 'run-9', driverId: 'move', state: 'succeeded' })
      harness.mind.push('order.terminal', { orderId: 'ord-9', state: 'succeeded' })
      await wait(700)
      expect(harness.state.steers).toHaveLength(0)
      expect(harness.state.followups).toHaveLength(0)

      harness.state.status = 'idle'
      await wait(700)
      expect(harness.state.followups).toHaveLength(1)
      const text = texts(harness.state.followups)[0] as string
      expect(text).toContain('[p2 completion][DIGEST]')
      expect(payloads(text)).toEqual([
        { kind: 'order.terminal', orderId: 'ord-9', state: 'succeeded' },
      ])
    } finally {
      await harness.stop()
    }
  })

  it('resets the event cursor on a body restart and still delivers the new epoch result', async () => {
    const first = createFakeBody('epoch-1', createFakeMind())
    const second = createFakeBody('epoch-2', createFakeMind())
    const harness = createHarness([first, second], { devAutoRestart: true, restartBackoffMs: [0] })
    await harness.start()
    try {
      // Drive the first epoch's cursor past the seq numbers the new ring will use.
      for (const id of ['ord-a1', 'ord-a2', 'ord-a3', 'ord-a4']) {
        first.mind.push('order.terminal', { orderId: id, state: 'succeeded' })
      }
      await wait(700)
      const before = completionTexts(harness.state.followups)
      expect(before).toHaveLength(1)
      expect(payloads(before[0] as string)).toHaveLength(4)

      first.setSilent(true)
      let epoch: string | undefined
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const status = await harness.tools.get('p2_status')!.execute({}, { agent: harness.agent }) as {
            state?: string
            epoch?: string
          }
          if (status.state === 'active' && status.epoch === 'epoch-2') {
            epoch = status.epoch
            break
          }
        } catch {
          // The old body is faulting; the manager will report the new epoch.
        }
        await wait(50)
      }
      expect(epoch).toBe('epoch-2')

      second.mind.push('order.terminal', { orderId: 'ord-b1', state: 'failed' })
      await wait(800)
      const after = completionTexts(harness.state.followups)
      expect(after).toHaveLength(2)
      expect(after[1]).toContain('"orderId":"ord-b1"')
      expect(after[1]).toContain('[p2 completion][CRITICAL]')
    } finally {
      await harness.stop()
    }
  })

  it('p2_order returns after acceptance instead of waiting for the terminal state', async () => {
    const harness = createHarness()
    await harness.start()
    try {
      const order = harness.tools.get('p2_order')
      expect(order).toBeDefined()
      const value = await order?.execute({ verb: 'go', params: { x: 1, y: 64, z: 1 } }, { agent: harness.agent })
      expect(value).toEqual({ accepted: true, id: 'ord-1', state: 'active' })
    } finally {
      await harness.stop()
    }
  })
})
