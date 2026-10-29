import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { BodyServer } from '../src/body/server.ts'
import { BodyManager } from '../src/bridge/process-manager.ts'
import type { BodyHandle } from '../src/bridge/process-manager.ts'
import { createP2Plugin } from '../src/bridge/plugin.ts'
import { BehaviorHost } from '../src/core/host.ts'
import type { GuardEvent, WatchEvent } from '../src/contracts/protocol.ts'
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

function fakeBody(behavior?: BehaviorHost): { handle: BodyHandle; server: BodyServer; runtime: BodyRuntime } {
  const runtime = new BodyRuntime({ body, newEpoch: () => 'epoch-1', ...(behavior === undefined ? {} : { behavior }) })
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

function managerWith(
  fake: { handle: BodyHandle },
  options: { onGuardEvent?: (event: GuardEvent) => void } = {},
): BodyManager {
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
    ...(options.onGuardEvent === undefined ? {} : { onGuardEvent: options.onGuardEvent }),
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
  it('processes guard events once and exposes guard commands', async () => {
    const host = new BehaviorHost({
      bindingId: 'guard-bridge',
      query: () => ({ status: 'ok', value: { health: 6 } }),
      act: { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
    })
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-guard-bridge-'))
    const path = join(dir, 'target.mjs')
    writeFileSync(path, `
      export default {
        id: 'bridge-guard-target', description: '', mode: 'finite', parameters: {}, locals: {},
        root: { kind: 'sequence', id: 'root', children: [] },
        completion: { kind: 'predicate', condition: { kind: 'expr', expr: { kind: 'literal', value: true } } },
      }
    `)
    try {
      const target = await host.check({ sourcePath: path })
      host.activate(target.artifactId)
      host.setGuard({
        condition: { kind: 'health', hpBelow: 10 },
        targetArtifactId: target.artifactId,
        params: {},
        ttlMs: 60_000,
      }, 1_000)
      const fake = fakeBody(host)
      const events: GuardEvent[] = []
      const manager = managerWith(fake, { onGuardEvent: event => events.push(event) })
      await manager.start(owner)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(events.map(event => event.phase)).toContain('armed')

      fake.runtime.tickBehavior(1_000)
      const status = await manager.status()
      expect(status.state).toBe('active')
      if (status.state === 'active') expect(status.status.guards?.[0]?.state).toBe('fired')
      expect(events.map(event => event.phase)).toEqual(expect.arrayContaining(['armed', 'fired', 'started']))

      const count = events.length
      await manager.status()
      expect(events.length).toBe(count)

      const armed = await manager.guardSet({
        condition: { kind: 'health', hpBelow: 5 },
        targetArtifactId: target.artifactId,
        params: {},
        ttlMs: 60_000,
      })
      expect(armed).toMatchObject({ state: 'active', condition: { kind: 'health', hpBelow: 5 } })
      const cleared = await manager.guardClear()
      expect(cleared).toMatchObject({ cleared: 1 })
      const after = await manager.status()
      if (after.state === 'active') expect(after.status.guards).toEqual([])
      await manager.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wakes the owner for each fired guard with a complete user message', async () => {
    const host = new BehaviorHost({
      bindingId: 'guard-wake',
      query: () => ({ status: 'ok', value: { health: 6 } }),
      act: { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
    })
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-guard-wake-'))
    const path = join(dir, 'target.mjs')
    writeFileSync(path, `
      export default {
        id: 'wake-target', description: '', mode: 'finite', parameters: {}, locals: {},
        root: { kind: 'sequence', id: 'root', children: [] },
        completion: { kind: 'predicate', condition: { kind: 'expr', expr: { kind: 'literal', value: true } } },
      }
    `)
    try {
      const target = await host.check({ sourcePath: path })
      host.activate(target.artifactId)
      const guard = {
        condition: { kind: 'health' as const, hpBelow: 10 },
        targetArtifactId: target.artifactId,
        params: {},
        ttlMs: 60_000,
      }
      host.setGuard(guard, 1_000)
      const fake = fakeBody(host)
      const definitions: Definition[] = []
      const tools: Array<Record<string, unknown>> = []
      type WakeMessage = {
        id: string
        role: string
        content: Array<{ type: string; text: string }>
        source: { kind: string }
      }
      const followups: WakeMessage[] = []
      const logs: string[] = []
      let rejectWake = false
      const ctx = {
        commands: { register: (definition: Definition) => { definitions.push(definition); return () => {} } },
        tools: { register: (definition: Record<string, unknown>) => { tools.push(definition); return () => {} } },
        agents: {
          get: (id: string) => id === owner.sessionId
            ? {
              followup: (message: WakeMessage) => {
                if (rejectWake) throw new Error('inbox rejected the message')
                followups.push(message)
              },
            }
            : undefined,
        },
        effect: (callback: () => unknown) => { callback(); return () => {} },
      }
      const plugin = createP2Plugin({
        devBodyControl: true,
        bodyEntry: 'unused-body.mjs',
        spawnBody: () => fake.handle,
        log: line => { logs.push(line) },
      })
      ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
      const bodyTool = tools.find(tool => tool.name === 'p2_body') as {
        execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<unknown>
      }
      const agent = {
        id: owner.agentId,
        session: { id: owner.sessionId, header: { cwd: owner.cwd } },
        ctx: { tools: { register: (definition: Record<string, unknown>) => { tools.push(definition); return () => {} } } },
      }
      await bodyTool.execute({ action: 'start' }, { agent })
      const statusTool = tools.find(tool => tool.name === 'p2_status') as {
        execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<unknown>
      }
      fake.runtime.tickBehavior(1_000)
      await statusTool.execute({}, { agent })
      expect(followups).toHaveLength(1)
      const first = followups[0]!
      expect(first.role).toBe('user')
      expect(typeof first.id).toBe('string')
      expect(first.id.length).toBeGreaterThan(0)
      expect(first.source).toEqual({ kind: 'p2-guard' })
      expect(first.content[0]?.text).toContain('fired')
      await statusTool.execute({}, { agent })
      expect(followups).toHaveLength(1)

      host.setGuard(guard, 2_000)
      fake.runtime.tickBehavior(2_000)
      await statusTool.execute({}, { agent })
      expect(followups).toHaveLength(2)
      expect(followups[1]!.id).not.toBe(first.id)

      rejectWake = true
      host.setGuard(guard, 3_000)
      fake.runtime.tickBehavior(3_000)
      await statusTool.execute({}, { agent })
      expect(followups).toHaveLength(2)
      expect(logs.some(line => line.includes('p2 guard wake failed'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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

  it('cleans up when the hello handshake fails', async () => {
    const [client] = createMemoryTransportPair()
    client.close()
    const handle: BodyHandle = {
      transport: client,
      kill: () => {},
      waitForExit: () => Promise.resolve({ code: 1, signal: null }),
    }
    const manager = new BodyManager({
      bodyEntry: 'unused-body.mjs',
      spawnBody: () => handle,
      log: () => {},
    })
    await expect(manager.start(owner)).rejects.toThrow()
    expect(manager.currentState).toBe('inactive')
  })

  it('sends exactly one snapshot request for a batch observation', async () => {
    const host = new BehaviorHost({
      bindingId: 'snapshot-bridge',
      query: ref => ({
        status: 'ok',
        value: ref.op === 'health' ? { health: 20 } : ref.op === 'position' ? { x: 0, y: 64, z: 0 } : [],
        meta: { source: 'query', scope: ref.op, sampledAt: 0 },
      }),
      act: { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
    })
    const fake = fakeBody(host)
    let snapshotRequests = 0
    const transport = fake.handle.transport
    fake.handle.transport = {
      send: line => {
        if (line.includes('"method":"snapshot"')) snapshotRequests += 1
        transport.send(line)
      },
      onLine: listener => transport.onLine(listener),
      onError: listener => transport.onError(listener),
      onClose: listener => transport.onClose(listener),
      close: () => transport.close(),
    }
    const manager = managerWith(fake)
    await manager.start(owner)
    const result = await manager.snapshot([
      { key: 'health', op: 'health' },
      { key: 'position', op: 'position' },
    ]) as { partial: boolean; parts: unknown[] }
    expect(snapshotRequests).toBe(1)
    expect(result.partial).toBe(false)
    expect(result.parts).toHaveLength(2)
    await manager.stop()
  })

  it('reports a watch event gap when the retained ring skips events', async () => {
    let counter = 0
    const host = new BehaviorHost({
      bindingId: 'watch-gap',
      query: () => ({ status: 'ok', value: { poisoned: true } }),
      act: { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
      policy: {
        call: () => ({ status: 'ok', value: { fire: true, key: `k-${++counter}` } }),
      },
      loadManifest: async () => ({ id: 'watch-predicate', inputs: ['samples', 'now'], outputs: [] }),
    })
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-watch-gap-'))
    const path = join(dir, 'predicate.mjs')
    writeFileSync(path, `
      definePolicy({
        manifest: { id: 'watch-predicate', inputs: ['samples', 'now'], outputs: [] },
        run: () => false,
      })
    `)
    try {
      const predicate = await host.check({ sourcePath: path, artifactKind: 'policy' })
      const fake = fakeBody(host)
      const gaps: Array<[number, number]> = []
      const events: WatchEvent[] = []
      const manager = new BodyManager({
        bodyEntry: 'unused-body.mjs',
        heartbeatMs: 60_000,
        spawnBody: () => fake.handle,
        log: () => {},
        onWatchEvent: event => events.push(event),
        onWatchGap: (from, to) => gaps.push([from, to]),
      })
      await manager.start(owner)
      await manager.watchAdd({
        queries: [{ op: 'health' }],
        predicate: predicate.artifactId,
        cooldownMs: 1_000,
        ttlMs: 600_000,
      })

      const t0 = Date.now()
      fake.runtime.tickBehavior(t0)
      await manager.status()
      expect(events).toHaveLength(1)

      for (let index = 1; index <= 70; index += 1) {
        fake.runtime.tickBehavior(t0 + index * 1_000)
      }
      await manager.status()
      expect(gaps.length).toBeGreaterThan(0)
      expect(gaps[0]?.[0]).toBe(2)
      expect(events.length).toBe(65)
      await manager.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  it('registers a development body tool only when enabled', async () => {
    const fake = fakeBody()
    let spawns = 0
    const definitions: Definition[] = []
    const globalTools: Array<Record<string, unknown>> = []
    const normalTools: Array<Record<string, unknown>> = []
    const disposed: string[] = []
    const ctx = {
      commands: { register: (definition: Definition) => { definitions.push(definition); return () => {} } },
      tools: {
        register: (definition: Record<string, unknown>) => {
          globalTools.push(definition)
          return () => {}
        },
      },
      effect: (callback: () => unknown) => { callback(); return () => {} },
    }
    const plugin = createP2Plugin({
      devBodyControl: true,
      bodyEntry: 'unused-body.mjs',
      spawnBody: () => {
        spawns += 1
        return fake.handle
      },
      log: () => {},
    })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
    expect(definitions).toHaveLength(1)
    expect(globalTools.map(tool => tool.name)).toEqual(['p2_body'])
    expect(spawns).toBe(0)

    const agent = {
      id: owner.agentId,
      session: { id: owner.sessionId, header: { cwd: owner.cwd } },
      ctx: {
        tools: {
          register: (definition: Record<string, unknown>) => {
            normalTools.push(definition)
            const name = String(definition.name)
            return () => { disposed.push(name) }
          },
        },
        effect: (callback: () => unknown) => { callback(); return () => {} },
      },
    }
    const tool = globalTools[0] as {
      execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<Record<string, unknown>>
    }
    expect(await tool.execute({ action: 'status' }, { agent })).toMatchObject({ state: 'inactive' })

    const started = await tool.execute({ action: 'start' }, { agent })
    expect(started).toMatchObject({ action: 'start', state: 'active', epoch: 'epoch-1' })
    expect(spawns).toBe(1)
    expect(normalTools.map(definition => definition.name)).toContain('p2_status')

    const again = await tool.execute({ action: 'start' }, { agent })
    expect(again.epoch).toBe('epoch-1')
    expect(spawns).toBe(1)

    await expect(tool.execute({ action: 'stop' }, {
      agent: { ...agent, session: { id: 'other-session', header: { cwd: owner.cwd } } },
    })).rejects.toThrow(/different session/u)
    const stopped = await tool.execute({ action: 'stop' }, { agent })
    expect(stopped).toMatchObject({ action: 'stop', state: 'inactive' })
    expect(disposed.length).toBeGreaterThan(0)

    const disabledTools: Array<Record<string, unknown>> = []
    const disabled = createP2Plugin({ bodyEntry: 'unused-body.mjs', spawnBody: () => fake.handle, log: () => {} })
    ;(disabled as unknown as { apply(ctx: unknown): void }).apply({
      commands: { register: () => () => {} },
      tools: { register: (definition: Record<string, unknown>) => { disabledTools.push(definition); return () => {} } },
      effect: (callback: () => unknown) => { callback(); return () => {} },
    })
    expect(disabledTools).toHaveLength(0)
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

  it('disposes its owned body on plugin unload without destroying the agent', async () => {
    const fake = fakeBody()
    const disposers: Array<() => unknown> = []
    const definitions: Definition[] = []
    const ctx = {
      commands: { register: (definition: Definition) => { definitions.push(definition); return () => {} } },
      effect: (callback: () => unknown) => {
        const disposer = callback()
        if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
        return () => {}
      },
    }
    const plugin = createP2Plugin({ bodyEntry: 'unused-body.mjs', spawnBody: () => fake.handle, log: () => {} })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
    const agent = { id: owner.agentId, session: { id: owner.sessionId, header: { cwd: owner.cwd } } }
    expect(await (definitions[0] as Definition).handler({ agent, rawInput: ' start' })).toMatchObject({ kind: 'success' })
    const bodyDisposer = disposers.at(-1) as () => Promise<void>
    await bodyDisposer()
    expect(fake.server.isStopped).toBe(true)
    expect(agent.id).toBe(owner.agentId)
  })

  it('registers owner-scoped tools only after start and disposes them on stop', async () => {
    const fake = fakeBody()
    const definitions: Definition[] = []
    const tools: Array<Record<string, unknown>> = []
    const disposed: number[] = []
    let disposerCount = 0
    const ctx = {
      commands: { register: (definition: Definition) => { definitions.push(definition); return () => {} } },
      effect: (callback: () => unknown) => { callback(); return () => {} },
    }
    const plugin = createP2Plugin({ bodyEntry: 'unused-body.mjs', spawnBody: () => fake.handle, log: () => {} })
    ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
    const agent = {
      id: owner.agentId,
      session: { id: owner.sessionId, header: { cwd: owner.cwd } },
      ctx: {
        tools: { register: (definition: Record<string, unknown>) => {
          tools.push(definition)
          disposerCount += 1
          const index = disposerCount
          return () => { disposed.push(index) }
        } },
        effect: (callback: () => unknown) => {
          callback()
          return () => {}
        },
      },
    }
    const command = definitions[0] as Definition
    expect(await command.handler({ agent, rawInput: ' start' })).toMatchObject({ kind: 'success' })
    expect(tools.map(tool => tool.name)).toEqual([
      'p2_status', 'p2_observe', 'p2_snapshot', 'p2_card', 'p2_check', 'p2_activate', 'p2_switch', 'p2_confirm',
      'p2_stop', 'p2_guard', 'p2_events', 'p2_watch', 'p2_rescue', 'p2_command',
    ])
    const status = tools[0] as { execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<unknown> }
    expect(await status.execute({}, { agent })).toBeDefined()
    await expect(status.execute({}, { agent: { ...agent, id: 'other' } })).rejects.toThrow(/different agent/)

    await new Promise(resolve => setTimeout(resolve, 0))
    const events = tools.find(tool => tool.name === 'p2_events') as {
      execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<{ events: unknown[]; gap: boolean }>
    }
    const drained = await events.execute({}, { agent })
    expect(drained.events.length).toBeGreaterThan(0)
    expect(drained.gap).toBe(false)

    expect(await command.handler({ agent, rawInput: ' stop' })).toMatchObject({ kind: 'success' })
    expect(disposed.length).toBeGreaterThan(0)
  })

  it('delivers each watch notification once and wakes the owner', async () => {
    let counter = 0
    const host = new BehaviorHost({
      bindingId: 'watch-bridge',
      query: () => ({ status: 'ok', value: { poisoned: true } }),
      act: { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
      policy: {
        call: () => ({
          status: 'ok',
          value: { fire: true, key: `k-${++counter}`, summary: 'poison detected' },
        }),
      },
      loadManifest: async () => ({ id: 'watch-predicate', inputs: ['samples', 'now'], outputs: [] }),
    })
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-watch-bridge-'))
    const path = join(dir, 'predicate.mjs')
    writeFileSync(path, `
      definePolicy({
        manifest: { id: 'watch-predicate', inputs: ['samples', 'now'], outputs: [] },
        run: () => false,
      })
    `)
    try {
      const predicate = await host.check({ sourcePath: path, artifactKind: 'policy' })
      const fake = fakeBody(host)
      const definitions: Definition[] = []
      const tools: Array<Record<string, unknown>> = []
      const followups: Array<{
        role: string
        content: Array<{ type: string; text: string }>
        source: { kind: string }
      }> = []
      const ctx = {
        commands: { register: (definition: Definition) => { definitions.push(definition); return () => {} } },
        tools: { register: (definition: Record<string, unknown>) => { tools.push(definition); return () => {} } },
        agents: {
          get: (id: string) => id === owner.sessionId
            ? { followup: (message: typeof followups[number]) => followups.push(message) }
            : undefined,
        },
        effect: (callback: () => unknown) => { callback(); return () => {} },
      }
      const plugin = createP2Plugin({ bodyEntry: 'unused-body.mjs', spawnBody: () => fake.handle, log: () => {} })
      ;(plugin as unknown as { apply(ctx: unknown): void }).apply(ctx)
      const agent = {
        id: owner.agentId,
        session: { id: owner.sessionId, header: { cwd: owner.cwd } },
        ctx: { tools: { register: (definition: Record<string, unknown>) => { tools.push(definition); return () => {} } } },
      }
      expect(await (definitions[0] as Definition).handler({ agent, rawInput: ' start' })).toMatchObject({ kind: 'success' })

      const watchTool = tools.find(tool => tool.name === 'p2_watch') as {
        parameters: { properties: Record<string, unknown> }
        execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<unknown>
      }
      const statusTool = tools.find(tool => tool.name === 'p2_status') as {
        execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<unknown>
      }
      expect(Object.keys(watchTool.parameters.properties).sort()).toEqual(
        ['action', 'cooldownMs', 'edge', 'name', 'predicate', 'priority', 'queries', 'ttlMs', 'watchId'].sort(),
      )
      expect((watchTool.parameters.properties.action as { enum: string[] }).enum)
        .toEqual(['add', 'remove', 'list', 'clear'])

      const added = await watchTool.execute({
        action: 'add',
        queries: [{ op: 'health' }],
        predicate: predicate.artifactId,
        cooldownMs: 1_000,
        ttlMs: 60_000,
      }, { agent }) as { id: string; state: string }
      expect(added).toMatchObject({ state: 'active' })

      const startedAt = Date.now()
      fake.runtime.tickBehavior(startedAt)
      await statusTool.execute({}, { agent })
      expect(followups).toHaveLength(1)
      expect(followups[0]?.source).toEqual({ kind: 'p2-watch' })
      expect(followups[0]?.content[0]?.text).toContain(added.id)
      expect(followups[0]?.content[0]?.text).toContain('poison detected')
      expect(followups[0]?.content[0]?.text).toContain('not an instruction')

      // Re-polling the same cursor must not wake the owner again.
      await statusTool.execute({}, { agent })
      expect(followups).toHaveLength(1)

      fake.runtime.tickBehavior(startedAt + 1_000)
      await statusTool.execute({}, { agent })
      expect(followups).toHaveLength(2)

      const eventsTool = tools.find(tool => tool.name === 'p2_events') as {
        execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<{ events: Array<{ kind: string }> }>
      }
      const drained = await eventsTool.execute({}, { agent })
      expect(drained.events.some(event => event.kind === 'watch')).toBe(true)

      const listed = await watchTool.execute({ action: 'list' }, { agent }) as { watches: unknown[] }
      expect(listed.watches).toHaveLength(1)
      expect(await watchTool.execute({ action: 'remove', watchId: added.id }, { agent }))
        .toMatchObject({ removed: 1 })
      const empty = await watchTool.execute({ action: 'list' }, { agent }) as { watches: unknown[] }
      expect(empty.watches).toHaveLength(0)
      await (definitions[0] as Definition).handler({ agent, rawInput: ' stop' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
