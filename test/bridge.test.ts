import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { BodyServer } from '../src/body/server.ts'
import { BodyManager } from '../src/bridge/process-manager.ts'
import type { BodyHandle } from '../src/bridge/process-manager.ts'
import { createP2Plugin } from '../src/bridge/plugin.ts'
import {
  PROTOCOL_VERSION,
  bodyManifestDigest,
  createMemoryTransportPair,
} from '../src/contracts/index.ts'
import type {
  BodyInfo,
  BodyManifest,
} from '../src/contracts/index.ts'

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

const owner = {
  sessionId: 'session-1',
  agentId: 'agent-1',
  cwd: process.cwd(),
}

function fakeBody(): { handle: BodyHandle; server: BodyServer; runtime: BodyRuntime } {
  const runtime = new BodyRuntime({ body, newEpoch: () => 'epoch-1' })
  const [client, serverTransport] = createMemoryTransportPair()
  const server = new BodyServer(runtime, serverTransport)
  server.start()
  let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    resolveExit = resolve
  })
  server.onClose(() => resolveExit({ code: 0, signal: null }))
  const handle: BodyHandle = {
    transport: client,
    kill: () => server.stop(),
    waitForExit: () => exit,
  }
  return { handle, server, runtime }
}

function managerWith(fake: { handle: BodyHandle }): BodyManager {
  let starts = 0
  return new BodyManager({
    bodyEntry: 'unused-body.mjs',
    heartbeatMs: 60_000,
    stopTimeoutMs: 500,
    spawnBody: () => {
      starts += 1
      return fake.handle
    },
    log: () => {},
  })
}

type Invocation = {
  agent: { id: string; session: { id: string; header: { cwd?: string } } }
  rawInput: string
}
type Definition = {
  name: string
  handler: (invocation: Invocation) => Promise<{ kind: string; text: string }> | { kind: string; text: string }
}
type Result = { kind: string; text: string }

describe('BodyManager', () => {
  it('starts one body, reports status, and stops it', async () => {
    const fake = fakeBody()
    const manager = managerWith(fake)
    const started = await manager.start(owner)
    expect(started.epoch).toBe('epoch-1')
    expect(manager.currentState).toBe('active')

    const again = await manager.start(owner)
    expect(again.epoch).toBe(started.epoch)

    const status = await manager.status()
    expect(status.state).toBe('active')

    const stopped = await manager.stop()
    expect(stopped.state).toBe('inactive')
    expect(manager.currentState).toBe('inactive')
  })

  it('marks an unexpected exit as faulted', async () => {
    const fake = fakeBody()
    const manager = managerWith(fake)
    await manager.start(owner)
    fake.server.stop()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(manager.currentState).toBe('faulted')
  })
})

describe('P2 commands', () => {
  it('registers /p2, does not spawn on load, and handles start/status/stop', async () => {
    const fake = fakeBody()
    let spawns = 0

    const definitions: Definition[] = []
    const disposers: Array<() => void> = []
    const ctx = {
      commands: {
        register(definition: Definition): () => void {
          definitions.push(definition)
          return () => {}
        },
      },
      effect(callback: () => unknown): () => void {
        const disposer = callback()
        if (typeof disposer === 'function') disposers.push(disposer as () => void)
        return () => {}
      },
    }
    const plugin = createP2Plugin({
      bodyEntry: 'unused-body.mjs',
      spawnBody: () => {
        spawns += 1
        return fake.handle
      },
      log: () => {},
    })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
    expect(definitions).toHaveLength(1)
    expect(spawns).toBe(0)

    const command = definitions[0] as Definition
    const agent = { id: owner.agentId, session: { id: owner.sessionId, header: { cwd: owner.cwd } } }
    const start = await command.handler({ agent, rawInput: ' start' })
    expect(start.kind).toBe('success')
    expect(spawns).toBe(1)

    const status = await command.handler({ agent, rawInput: ' status' })
    expect(status.kind).toBe('success')
    expect(status.text).toContain('P2 body active')

    const stop = await command.handler({ agent, rawInput: ' stop' })
    expect(stop.kind).toBe('success')

    const setup = await command.handler({ agent, rawInput: ' setup' })
    expect(setup.kind).toBe('success')
    const unknown = await command.handler({ agent, rawInput: ' wat' })
    expect(unknown.kind).toBe('error')

    expect(disposers.length).toBeGreaterThan(0)
  })

  it('rejects start without a project cwd', async () => {
    const fake = fakeBody()
    const definitions: Definition[] = []
    const plugin = createP2Plugin({ bodyEntry: 'unused-body.mjs', spawnBody: () => fake.handle, log: () => {} })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply({
      commands: { register: (definition: Definition) => { definitions.push(definition); return () => {} } },
      effect: (callback: () => unknown) => { callback(); return () => {} },
    })
    const result = await (definitions[0] as Definition).handler({
      agent: { id: 'a', session: { id: 's', header: {} } },
      rawInput: ' start',
    })
    expect(result.kind).toBe('error')
  })
})
