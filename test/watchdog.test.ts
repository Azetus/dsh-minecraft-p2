import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { BodyServer } from '../src/body/server.ts'
import { BodyManager } from '../src/bridge/process-manager.ts'
import type { BodyFault, BodyHandle, RestartInfo } from '../src/bridge/process-manager.ts'
import { createP2Plugin } from '../src/bridge/plugin.ts'
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

type FakeBody = {
  handle: BodyHandle
  server: BodyServer
  runtime: BodyRuntime
  setSilent(value: boolean): void
  readonly killTreeCalls: number
}

function createFakeBody(epoch: string): FakeBody {
  const runtime = new BodyRuntime({ body, newEpoch: () => epoch })
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
      kill: () => server.stop(),
      killTree: () => {
        killTreeCalls += 1
        server.stop()
      },
      waitForExit: () => exit,
    },
  }
}

type ManagerHarness = {
  manager: BodyManager
  spawns: number
  faults: BodyFault[]
  restarts: RestartInfo[]
}

function createManager(
  bodies: FakeBody[],
  options: { autoRestart?: boolean; maxRestarts?: number; windowMs?: number } = {},
): ManagerHarness {
  const faults: BodyFault[] = []
  const restarts: RestartInfo[] = []
  const harness: ManagerHarness = {
    spawns: 0,
    faults,
    restarts,
    manager: undefined as unknown as BodyManager,
  }
  harness.manager = new BodyManager({
    bodyEntry: 'unused-body.mjs',
    heartbeatMs: 10,
    requestTimeoutMs: 20,
    stopTimeoutMs: 50,
    autoRestart: {
      enabled: options.autoRestart ?? true,
      maxRestarts: options.maxRestarts ?? 3,
      windowMs: options.windowMs ?? 5_000,
      backoffMs: [0, 0, 0],
    },
    delay: async () => {},
    spawnBody: () => {
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
      guardsCleared: true,
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
      spawnBody: () => bodies[Math.min(spawns++, bodies.length - 1)]!.handle,
      log: () => {},
    })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
    const agent = { id: owner.agentId, session: { id: owner.sessionId, header: { cwd: owner.cwd } } }
    const started = await definitions[0]!.handler({ agent, rawInput: ' start' })
    expect(started.kind).toBe('success')

    bodies[0]!.setSilent(true)
    await wait(180)
    const texts = followups.map(message => message.content[0]?.text ?? '')
    expect(texts.some(text => text.includes('body faulted'))).toBe(true)
    expect(texts.some(text => text.includes('body restarted'))).toBe(true)
    expect(followups.every(message => message.source.kind === 'p2-runtime')).toBe(true)
    expect(followups.every(message => message.role === 'user')).toBe(true)
  })
})
