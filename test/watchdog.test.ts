import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { BodyServer } from '../src/body/server.ts'
import { BodyManager } from '../src/bridge/process-manager.ts'
import type { BodyFault, BodyHandle, RestartInfo } from '../src/bridge/process-manager.ts'
import { BodyLockConflictError } from '../src/bridge/body-lock.ts'
import { createP2Plugin } from '../src/bridge/plugin.ts'
import type { ToolDefinition } from '../src/bridge/tools.ts'
import type { ProviderRuntimeStatus } from '../src/contracts/protocol.ts'
import {
  PROTOCOL_VERSION,
  bodyManifestDigest,
  createMemoryTransportPair,
} from '../src/contracts/index.ts'
import type { BodyInfo, BodyManifest, MessageTransport } from '../src/contracts/index.ts'

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
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-watchdog-lock-'))
  lockDirs.push(dir)
  return dir
}

function tempWorkspace(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-watchdog-workspace-'))
  workspaceDirs.push(dir)
  return dir
}

type FakeBody = {
  handle: BodyHandle
  server: BodyServer
  runtime: BodyRuntime
  setSilent(value: boolean): void
  readonly killTreeCalls: number
}

function createFakeBody(
  epoch: string,
  options: {
    ignoreKill?: boolean
    ignoreKillTree?: boolean
    providerStatus?: () => ProviderRuntimeStatus
  } = {},
): FakeBody {
  const runtime = new BodyRuntime({
    body,
    newEpoch: () => epoch,
    ...(options.providerStatus === undefined ? {} : { providerStatus: options.providerStatus }),
  })
  const [client, serverTransport] = createMemoryTransportPair()
  const server = new BodyServer(runtime, serverTransport)
  server.start()
  let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    resolveExit = resolve
  })
  server.onClose(() => resolveExit({ code: 0, signal: null }))
  let silent = false
  let killTreeCalls = 0
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
    setSilent: value => { silent = value },
    get killTreeCalls() { return killTreeCalls },
    handle: {
      transport,
      kill: () => {
        if (options.ignoreKill !== true) server.stop()
      },
      killTree: () => {
        killTreeCalls += 1
        if (options.ignoreKillTree !== true) server.stop()
      },
      waitForExit: () => exit,
    },
  }
}

type ManagerHarness = {
  manager: BodyManager
  spawns: number
  spawnEnvs: Array<Record<string, string> | undefined>
  faults: BodyFault[]
  restarts: RestartInfo[]
}

function createManager(
  bodies: FakeBody[],
  options: { autoRestart?: boolean; maxRestarts?: number; windowMs?: number; lockDir?: string } = {},
): ManagerHarness {
  const faults: BodyFault[] = []
  const restarts: RestartInfo[] = []
  const harness: ManagerHarness = {
    spawns: 0,
    spawnEnvs: [],
    faults,
    restarts,
    manager: undefined as unknown as BodyManager,
  }
  harness.manager = new BodyManager({
    bodyEntry: 'unused-body.mjs',
    heartbeatMs: 10,
    requestTimeoutMs: 20,
    stopTimeoutMs: 50,
    lockDir: options.lockDir ?? tempLockDir(),
    autoRestart: {
      enabled: options.autoRestart ?? true,
      maxRestarts: options.maxRestarts ?? 3,
      windowMs: options.windowMs ?? 5_000,
      backoffMs: [0, 0, 0],
    },
    delay: async () => {},
    spawnBody: (_entry, _cwd, env) => {
      harness.spawnEnvs.push(env)
      const fake = bodies[Math.min(harness.spawns, bodies.length - 1)] as FakeBody
      harness.spawns += 1
      return fake.handle
    },
    log: () => {},
    onFault: fault => faults.push(fault),
    onRestart: info => restarts.push(info),
  })
  return harness
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

describe('body watchdog', () => {
  it('passes the start target to the body and reuses it on restart', async () => {
    const bodies = [createFakeBody('epoch-1'), createFakeBody('epoch-2')]
    const harness = createManager(bodies)
    const target = { host: '127.0.0.1', port: 25575 }
    await harness.manager.start(owner, target)
    expect(harness.manager.target).toEqual(target)
    expect(harness.spawnEnvs[0]).toMatchObject({ P2_MC_HOST: '127.0.0.1', P2_MC_PORT: '25575' })

    bodies[0]!.setSilent(true)
    await wait(150)
    expect(harness.spawns).toBe(2)
    expect(harness.spawnEnvs[1]).toMatchObject({ P2_MC_HOST: '127.0.0.1', P2_MC_PORT: '25575' })
    expect(harness.manager.target).toEqual(target)
    await harness.manager.stop()
  })

  it('rejects a different target while the body is active', async () => {
    const bodies = [createFakeBody('epoch-1')]
    const harness = createManager(bodies, { autoRestart: false })
    await harness.manager.start(owner, { host: '127.0.0.1', port: 25575 })
    await expect(harness.manager.start(owner, { host: '127.0.0.1', port: 25576 }))
      .rejects.toThrow(/different target/)
    expect(harness.spawns).toBe(1)
    await harness.manager.stop()
  })

  it('rejects a second manager claiming the same target', async () => {
    const dir = tempLockDir()
    const first = createManager([createFakeBody('epoch-a')], { lockDir: dir })
    const second = createManager([createFakeBody('epoch-b')], { lockDir: dir })
    const target = { host: 'localhost', port: 25575 }

    await first.manager.start(owner, target)
    await expect(second.manager.start(owner, target)).rejects.toBeInstanceOf(BodyLockConflictError)
    expect(second.spawns).toBe(0)

    await first.manager.stop()
    await second.manager.start(owner, target)
    expect(second.spawns).toBe(1)
    await second.manager.stop()
  })

  it('does not auto-restart after a duplicate_login kick', async () => {
    const providerStatus = (): ProviderRuntimeStatus => ({
      connected: false,
      paused: false,
      serverAge: 1,
      idleMs: 0,
      lastDisconnect: {
        at: 1,
        kind: 'kick',
        reason: 'multiplayer.disconnect.duplicate_login',
        eventLoopLagMs: 0,
        serverAge: 1,
        paused: false,
        ageIdleMs: 0,
      },
    })
    const bodies = [createFakeBody('epoch-1', { providerStatus })]
    const harness = createManager(bodies)
    await harness.manager.start(owner, { host: 'localhost', port: 25575 })
    await wait(120)

    expect(harness.spawns).toBe(1)
    expect(bodies[0]!.killTreeCalls).toBe(1)
    expect(harness.faults.at(-1)).toMatchObject({
      reason: 'provider-disconnected',
      autoRestart: 'disabled',
      lastDisconnect: {
        kind: 'kick',
        reason: 'multiplayer.disconnect.duplicate_login',
      },
    })
    const faulted = await harness.manager.status()
    expect(faulted).toMatchObject({
      state: 'faulted',
      fault: {
        lastDisconnect: { kind: 'kick', reason: 'multiplayer.disconnect.duplicate_login' },
      },
    })
    expect(harness.manager.lockInfo).toBeUndefined()
    await harness.manager.stop()
  })

  it('restarts a hung body with a new epoch and reports the fault', async () => {
    const bodies = [createFakeBody('epoch-1'), createFakeBody('epoch-2')]
    const harness = createManager(bodies)
    await harness.manager.start(owner)
    bodies[0]!.setSilent(true)
    await wait(150)

    expect(harness.spawns).toBe(2)
    expect(harness.manager.currentState).toBe('active')
    expect(harness.manager.bodyEpoch).toBe('epoch-2')
    expect(bodies[0]!.killTreeCalls).toBe(1)
    expect(harness.faults[0]).toMatchObject({
      reason: 'heartbeat-missed',
      epoch: 'epoch-1',
      control: 'unknown',
      autoRestart: 'scheduled',
    })
    expect(harness.restarts[0]).toMatchObject({ epoch: 'epoch-2', attempt: 1, maxRestarts: 3 })
    await harness.manager.stop()
  })

  it('reports the current-window restart count, not a cumulative count', async () => {
    const bodies = [createFakeBody('epoch-1'), createFakeBody('epoch-2'), createFakeBody('epoch-3')]
    const harness = createManager(bodies, { windowMs: 50 })
    await harness.manager.start(owner)

    bodies[0]!.setSilent(true)
    await wait(150)
    expect(harness.restarts[0]).toMatchObject({ attempt: 1 })

    // The first restart ages out of the 50ms window before the next fault.
    await wait(150)
    bodies[1]!.setSilent(true)
    await wait(150)
    expect(harness.restarts[1]).toMatchObject({ attempt: 1 })
    await harness.manager.stop()
  })

  it('stops restarting when the window budget is exhausted', async () => {
    const bodies = [createFakeBody('epoch-1'), createFakeBody('epoch-2'), createFakeBody('epoch-3')]
    const harness = createManager(bodies, { maxRestarts: 1 })
    await harness.manager.start(owner)
    bodies[0]!.setSilent(true)
    await wait(120)
    expect(harness.manager.bodyEpoch).toBe('epoch-2')

    bodies[1]!.setSilent(true)
    await wait(120)
    expect(harness.spawns).toBe(2)
    expect(harness.manager.currentState).toBe('faulted')
    expect(harness.faults.at(-1)).toMatchObject({ reason: 'heartbeat-missed', autoRestart: 'exhausted' })
    const status = await harness.manager.status()
    expect(status.state).toBe('faulted')
    if (status.state === 'faulted') expect(status.fault?.autoRestart).toBe('exhausted')
  })

  it('force-kills the body tree when a graceful stop does not exit', async () => {
    const bodies = [createFakeBody('epoch-1', { ignoreKill: true })]
    const harness = createManager(bodies)
    await harness.manager.start(owner)
    bodies[0]!.setSilent(true)

    const result = await harness.manager.stop()

    expect(bodies[0]!.killTreeCalls).toBe(1)
    expect(result.state).toBe('inactive')
    expect(harness.manager.currentState).toBe('inactive')
  })

  it('does not start a replacement when the old process never exits', async () => {
    const bodies = [createFakeBody('epoch-1', { ignoreKill: true, ignoreKillTree: true })]
    const harness = createManager(bodies)
    await harness.manager.start(owner)
    bodies[0]!.setSilent(true)

    const stopped = await harness.manager.stop()
    expect(stopped.state).toBe('faulted')
    await expect(harness.manager.start(owner)).rejects.toThrow(/has not exited/)
    expect(harness.spawns).toBe(1)
  })

  it('does not restart after a manual stop', async () => {
    const bodies = [createFakeBody('epoch-1')]
    const harness = createManager(bodies)
    await harness.manager.start(owner)
    await harness.manager.stop()
    await wait(120)
    expect(harness.spawns).toBe(1)
    expect(harness.faults).toHaveLength(0)
    expect(harness.manager.currentState).toBe('inactive')
  })

  it('does not restart while a manual stop is in progress', async () => {
    const bodies = [createFakeBody('epoch-1'), createFakeBody('epoch-2')]
    const harness = createManager(bodies)
    await harness.manager.start(owner)
    bodies[0]!.setSilent(true)
    const stopping = harness.manager.stop()
    await wait(10)
    await stopping
    await wait(100)
    expect(harness.spawns).toBe(1)
    expect(harness.manager.currentState).toBe('inactive')
  })

  it('restarts after an unexpected process exit', async () => {
    const bodies = [createFakeBody('epoch-1'), createFakeBody('epoch-2')]
    const harness = createManager(bodies)
    await harness.manager.start(owner)
    bodies[0]!.server.stop()
    await wait(80)
    expect(harness.manager.currentState).toBe('active')
    expect(harness.manager.bodyEpoch).toBe('epoch-2')
    expect(harness.faults[0]).toMatchObject({ reason: 'process-exit', autoRestart: 'scheduled' })
    await harness.manager.stop()
  })

  it('keeps the body faulted when auto restart is disabled', async () => {
    const bodies = [createFakeBody('epoch-1')]
    const harness = createManager(bodies, { autoRestart: false })
    await harness.manager.start(owner)
    bodies[0]!.setSilent(true)
    await wait(120)
    expect(harness.spawns).toBe(1)
    expect(harness.manager.currentState).toBe('faulted')
    expect(harness.faults[0]).toMatchObject({ autoRestart: 'disabled' })
  })

  it('keeps lastDisconnect visible in faulted p2_body status', async () => {
    const providerStatus = (): ProviderRuntimeStatus => ({
      connected: false,
      paused: false,
      serverAge: 1,
      idleMs: 0,
      lastDisconnect: {
        at: 1,
        kind: 'kick',
        reason: 'multiplayer.disconnect.duplicate_login',
        eventLoopLagMs: 0,
        serverAge: 1,
        paused: false,
        ageIdleMs: 0,
      },
    })
    const bodies = [createFakeBody('epoch-1', { providerStatus })]
    let spawns = 0
    const tools = new Map<string, ToolDefinition>()
    const ctx = {
      commands: { register: () => () => {} },
      tools: {
        register: (definition: ToolDefinition) => {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
      agents: { get: () => undefined },
      effect: (callback: () => unknown) => {
        callback()
        return () => {}
      },
    }
    const plugin = createP2Plugin({
      bodyEntry: 'unused-body.mjs',
      heartbeatMs: 10,
      requestTimeoutMs: 20,
      devBodyControl: true,
      devAutoRestart: true,
      restartBackoffMs: [0],
      lockDir: tempLockDir(),
      workspaceDir: tempWorkspace(),
      spawnBody: () => bodies[Math.min(spawns++, bodies.length - 1)]!.handle,
      log: () => {},
    })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
    const bodyTool = tools.get('p2_body')
    if (bodyTool === undefined) throw new Error('p2_body was not registered')
    const agent = { id: owner.agentId, session: { id: owner.sessionId, header: { cwd: owner.cwd } } }
    await bodyTool.execute({ action: 'start', host: '127.0.0.1', port: 25575 }, { agent })
    await wait(150)

    const status = await bodyTool.execute({ action: 'status' }, { agent }) as {
      state?: string
      fault?: { lastDisconnect?: { kind?: string; reason?: string } }
    }
    expect(status.state).toBe('faulted')
    expect(status.fault?.lastDisconnect).toMatchObject({
      kind: 'kick',
      reason: 'multiplayer.disconnect.duplicate_login',
    })
  })

  it('starts the body with an explicit p2_body target', async () => {
    const bodies = [createFakeBody('epoch-1')]
    let spawns = 0
    const tools = new Map<string, ToolDefinition>()
    const ctx = {
      commands: { register: () => () => {} },
      tools: {
        register: (definition: ToolDefinition) => {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
      agents: { get: () => undefined },
      effect: (callback: () => unknown) => {
        callback()
        return () => {}
      },
    }
    const plugin = createP2Plugin({
      bodyEntry: 'unused-body.mjs',
      heartbeatMs: 10,
      requestTimeoutMs: 20,
      devBodyControl: true,
      lockDir: tempLockDir(),
      workspaceDir: tempWorkspace(),
      spawnBody: () => bodies[Math.min(spawns++, bodies.length - 1)]!.handle,
      log: () => {},
    })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
    const bodyTool = tools.get('p2_body')
    if (bodyTool === undefined) throw new Error('p2_body was not registered')
    const agent = { id: owner.agentId, session: { id: owner.sessionId, header: { cwd: owner.cwd } } }
    const started = await bodyTool.execute(
      { action: 'start', host: '127.0.0.1', port: 25575 },
      { agent },
    ) as { state?: string; target?: string; status?: { target?: string } }
    expect(started.state).toBe('active')
    expect(started.target).toBe('127.0.0.1:25575')
    expect(started.status?.target).toBe('127.0.0.1:25575')
    await bodyTool.execute({ action: 'stop' }, { agent })
  })

  it('wakes the owner with fault and restart messages', async () => {
    const bodies = [createFakeBody('epoch-1'), createFakeBody('epoch-2')]
    const followups: Array<{
      role: string
      content: Array<{ type: string; text: string }>
      source: { kind: string }
    }> = []
    const definitions: Array<{ handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string }> }> = []
    let spawns = 0
    const ctx = {
      commands: {
        register: (definition: typeof definitions[number]) => {
          definitions.push(definition)
          return () => {}
        },
      },
      agents: {
        get: (id: string) => id === owner.sessionId
          ? { followup: (message: typeof followups[number]) => followups.push(message) }
          : undefined,
      },
      effect: (callback: () => unknown) => {
        callback()
        return () => {}
      },
    }
    const plugin = createP2Plugin({
      bodyEntry: 'unused-body.mjs',
      heartbeatMs: 10,
      requestTimeoutMs: 20,
      devAutoRestart: true,
      restartBackoffMs: [0, 0, 0],
      lockDir: tempLockDir(),
      workspaceDir: tempWorkspace(),
      spawnBody: () => bodies[Math.min(spawns++, bodies.length - 1)]!.handle,
      log: () => {},
    })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
    const agent = { id: owner.agentId, session: { id: owner.sessionId, header: { cwd: owner.cwd } } }
    const missingTarget = await definitions[0]!.handler({ agent, rawInput: ' start' })
    expect(missingTarget.kind).toBe('error')
    const started = await definitions[0]!.handler({ agent, rawInput: ' start 127.0.0.1:25575' })
    expect(started.kind).toBe('success')

    bodies[0]!.setSilent(true)
    await wait(180)
    const texts = followups.map(message => message.content[0]?.text ?? '')
    expect(texts.some(text => text.includes('body faulted'))).toBe(true)
    expect(texts.some(text => text.includes('body restarted'))).toBe(true)
    expect(followups.every(message => message.source.kind === 'p2-runtime')).toBe(true)
    expect(followups.every(message => message.role === 'user')).toBe(true)
  })

  it('includes provider detail in the fault wake', async () => {
    const providerStatus = (): ProviderRuntimeStatus => ({
      connected: false,
      paused: false,
      serverAge: 1,
      idleMs: 0,
      lastDisconnect: {
        at: 1,
        kind: 'kick',
        reason: 'multiplayer.disconnect.duplicate_login',
        eventLoopLagMs: 0,
        serverAge: 1,
        paused: false,
        ageIdleMs: 0,
      },
    })
    const bodies = [createFakeBody('epoch-1', { providerStatus })]
    const followups: Array<{
      role: string
      content: Array<{ type: string; text: string }>
      source: { kind: string }
    }> = []
    const definitions: Array<{ handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string }> }> = []
    let spawns = 0
    const ctx = {
      commands: {
        register: (definition: typeof definitions[number]) => {
          definitions.push(definition)
          return () => {}
        },
      },
      agents: {
        get: (id: string) => id === owner.sessionId
          ? { followup: (message: typeof followups[number]) => followups.push(message) }
          : undefined,
      },
      effect: (callback: () => unknown) => {
        callback()
        return () => {}
      },
    }
    const plugin = createP2Plugin({
      bodyEntry: 'unused-body.mjs',
      heartbeatMs: 10,
      requestTimeoutMs: 20,
      devAutoRestart: true,
      restartBackoffMs: [0],
      lockDir: tempLockDir(),
      workspaceDir: tempWorkspace(),
      spawnBody: () => bodies[Math.min(spawns++, bodies.length - 1)]!.handle,
      log: () => {},
    })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
    const agent = { id: owner.agentId, session: { id: owner.sessionId, header: { cwd: owner.cwd } } }
    const started = await definitions[0]!.handler({ agent, rawInput: ' start 127.0.0.1:25575' })
    expect(started.kind).toBe('success')
    await wait(150)

    const texts = followups.map(message => message.content[0]?.text ?? '')
    expect(texts.some(text => text.includes('body faulted (provider-disconnected)'))).toBe(true)
    expect(texts.some(text => text.includes(
      'detail=provider connection lost (kick: multiplayer.disconnect.duplicate_login)',
    ))).toBe(true)
    expect(texts.some(text => text.includes('Start a new body manually'))).toBe(true)
    expect(texts.some(text => text.includes('body restarted'))).toBe(false)
  })
})



