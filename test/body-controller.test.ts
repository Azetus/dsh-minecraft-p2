/**
 * Body wiring for the P2Controller: mode exclusivity, strategy install,
 * commitment completion and protocol routing.
 *
 * Category: cross-module contract. Uses fake ActPort/QueryPort; no game.
 */

import { describe, expect, it } from 'vitest'

import { BodyController } from '../src/body/controller-host.ts'
import { BodyRuntime } from '../src/body/runtime.ts'
import { ArtifactHost } from '../src/core/artifact-host.ts'
import type { ActHandle, ActPort, ActRefLike, QueryOutcome, QueryPort, ReleaseStatus } from '../src/core/node-runtime.ts'
import type { StrategyArtifact } from '../src/contracts/artifacts.ts'
import type { JsonValue } from '../src/contracts/types.ts'
import {
  PROTOCOL_VERSION,
  bodyManifestDigest,
  p2Error,
} from '../src/contracts/index.ts'
import type { BodyInfo, BodyManifest, RequestEnvelope } from '../src/contracts/index.ts'

type FakeAction = {
  ref: ActRefLike
  args: Record<string, JsonValue>
  identity: { runId: string; actInstanceId: string; generation: number } | undefined
  outcome: ReturnType<ActHandle['poll']>
  stopCalls: number
}

class FakeActPort implements ActPort {
  readonly actions: FakeAction[] = []
  readonly stopRequests: Array<{ now: number; runId: string | undefined }> = []
  releaseStatus: ReleaseStatus = 'released'

  start(ref: ActRefLike, args: Record<string, JsonValue>, identity?: FakeAction['identity']): ActHandle {
    const action: FakeAction = { ref, args, identity, outcome: { status: 'running' }, stopCalls: 0 }
    this.actions.push(action)
    return {
      poll: () => action.outcome,
      stop: () => {
        action.stopCalls += 1
        if (action.outcome.status === 'running') action.outcome = { status: 'cancelled' }
      },
    }
  }

  stopRun(now: number, runId?: string): void {
    this.stopRequests.push({ now, runId })
  }

  pollRelease(): ReleaseStatus {
    return this.releaseStatus
  }
}

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

const owner = { sessionId: 's', agentId: 'a', cwd: process.cwd() }

function request(method: string, params: RequestEnvelope['params']): RequestEnvelope {
  return { protocol: 1, requestId: `req-${method}`, method, params, bodyEpoch: 'epoch-1' }
}

function artifactWith(code: string, facts: string[], acts: string[] = [], resolved: Record<string, string> = {}): StrategyArtifact {
  const id = /id: '([^']+)'/u.exec(code)?.[1] ?? 'test-strategy'
  return {
    kind: 'strategy',
    definitionId: id,
    version: '1',
    slot: 'S2',
    facts,
    acts,
    resolvedActs: resolved,
    code,
    manifest: {
      schemaVersion: 1,
      kind: 'strategy',
      definitionId: id,
      sourceDigest: 's',
      codeDigest: null,
      buildToolVersion: 'test',
      bindingId: 'b',
      dependencies: [],
    },
    artifactId: `strategy-${id}`,
    artifactDigest: 'a',
    bindingId: 'b',
    sourceDigest: 's',
  }
}

function harness(options: { inventory?: number; artifact?: StrategyArtifact; code?: string } = {}): {
  world: { inventory: number; time: number }
  act: FakeActPort
  controller: BodyController
  tick: (ms?: number) => void
} {
  const world = { inventory: options.inventory ?? 1, time: 1000 }
  const act = new FakeActPort()
  const query: QueryPort = (ref): QueryOutcome => {
    const meta = { source: 'query' as const, scope: 'mineflayer.test', sampledAt: world.time, validUntil: world.time + 1000 }
    switch (ref.op) {
      case 'position':
        return { status: 'ok', value: { x: 0, y: 64, z: 0, dimension: 'overworld', inWater: false }, meta }
      case 'health':
        return { status: 'ok', value: { health: 20, food: 20, oxygen: 20 }, meta }
      case 'inventory':
        return { status: 'ok', value: world.inventory === 0 ? [] : [{ name: 'stone', count: world.inventory }], meta }
      case 'blocks':
        return { status: 'ok', value: [], meta }
      case 'entities':
        return { status: 'ok', value: [], meta }
      default:
        return { status: 'failed', error: p2Error('UNKNOWN_OP', 'validation', `unknown ${ref.op}`, { module: 'test' }) }
    }
  }
  const controller = new BodyController({
    act,
    query,
    strategySource: id => (options.artifact?.artifactId === id ? options.artifact : undefined),
    now: () => world.time,
  })
  return {
    world,
    act,
    controller,
    tick: (ms = 100) => {
      world.time += ms
      controller.tick()
    },
  }
}

const IDLE = `defineStrategy({ manifest: { id: 'idle', version: '1', slot: 'S2', facts: ['inventory'] }, evaluate() { return { kind: 'idle' } } })`
const COMPLETE = `defineStrategy({ manifest: { id: 'finish', version: '1', slot: 'S2', facts: ['inventory'] }, evaluate() { return { kind: 'candidate-complete', evidence: ['inventory'] } } })`
const DIG = `defineStrategy({ manifest: { id: 'dig', version: '1', slot: 'S2', facts: ['inventory'], acts: ['dig'] }, evaluate() { return { kind: 'propose', intent: 'dig:1,64,2', act: 'dig', args: { x: 1, y: 64, z: 2 } } } })`
const ALWAYS = `defineStrategy({ manifest: { id: 'always', version: '1', slot: 'S2', facts: [], acts: ['noop'] }, evaluate() { return { kind: 'propose', intent: 'noop', act: 'noop', args: {} } } })`

describe('BodyController wiring', () => {
  it('enables and disables the single control mode', () => {
    const { controller } = harness()
    expect(controller.status().mode).toBe('off')
    expect(controller.enable(1000).mode).toBe('active')
    expect(controller.engaged).toBe(true)
    expect(controller.status().enabledAt).toBe(1000)
    expect(controller.disable(1100).mode).toBe('off')
    expect(controller.engaged).toBe(false)
  })

  it('installs an activated strategy artifact and validates its facts', () => {
    const artifact = artifactWith(IDLE, ['inventory'])
    const { controller } = harness({ artifact })
    controller.enable(1000)
    expect(controller.install({ artifactId: artifact.artifactId }, 1100)).toMatchObject({
      key: 'idle',
      status: 'installed',
      installedVersion: '1',
      activeVersion: '1',
    })
    expect(controller.status().strategies).toHaveLength(1)

    const unknown = artifactWith(IDLE.replace("'idle'", "'idle2'"), ['not-a-fact'])
    expect(() => controller.install({ artifactId: unknown.artifactId }, 1200)).toThrowError(/not activated/u)

    const badFact = { ...artifactWith(IDLE, ['not-a-fact']), artifactId: 'strategy-bad-fact' }
    const second = new BodyController({
      act: new FakeActPort(),
      query: () => ({ status: 'ok', value: null }),
      strategySource: id => (id === badFact.artifactId ? badFact : undefined),
      now: () => 1000,
    })
    second.enable(1000)
    expect(() => second.install({ artifactId: badFact.artifactId }, 1100)).toThrowError(/unregistered facts/u)
  })

  it('completes a commitment only through evidence after cleanup', () => {
    const artifact = artifactWith(COMPLETE, ['inventory'])
    const { controller, tick } = harness({ artifact, inventory: 1 })
    controller.enable(1000)
    controller.install({ artifactId: artifact.artifactId }, 1000)
    const commitment = controller.commit({
      id: 'mine-1',
      goal: 'have one stone',
      strategyKey: 'finish',
      post: { kind: 'count-at-least', factKey: 'inventory', item: 'stone', count: 1 } as JsonValue,
      baselineKeys: ['inventory'],
    }, 1000)
    expect(commitment.state).toBe('active')

    tick()
    const status = controller.status()
    expect(status.commitments[0]?.state).toBe('succeeded')
    expect(controller.events({ sinceSeq: 0 }).events.some(event => event.kind === 'commitment-succeeded')).toBe(true)
  })

  it('dispatches a proposed act with controller identity', () => {
    const artifact = artifactWith(DIG, ['inventory'], ['dig'], { dig: 'act-dig-9' })
    const { controller, act, tick } = harness({ artifact })
    controller.enable(1000)
    controller.install({ artifactId: artifact.artifactId }, 1000)
    controller.commit({
      id: 'dig-goal',
      goal: 'dig',
      strategyKey: 'dig',
      post: { kind: 'count-at-least', factKey: 'inventory', item: 'stone', count: 1 } as JsonValue,
      baselineKeys: ['inventory'],
    }, 1000)

    tick()
    expect(act.actions).toHaveLength(1)
    expect(act.actions[0]).toMatchObject({
      ref: { definitionId: 'act-dig-9', artifactId: 'act-dig-9' },
      args: { x: 1, y: 64, z: 2 },
      identity: { runId: 'controller', actInstanceId: 'controller-act-1', generation: 1 },
    })
    expect(controller.status().action).toMatchObject({ intent: 'dig:1,64,2', slot: 'S2' })
  })

  it('stops dispatching immediately when disabled, even if the strategy keeps proposing', () => {
    const artifact = artifactWith(ALWAYS, [], ['noop'], { noop: 'act-noop' })
    const { controller, act, tick } = harness({ artifact })
    controller.enable(1000)
    controller.install({ artifactId: artifact.artifactId }, 1000)
    controller.commit({
      id: 'always-goal',
      goal: 'always propose',
      strategyKey: 'always',
      post: { kind: 'standing' },
      baselineKeys: [],
    }, 1000)
    tick()
    tick()
    expect(act.actions.length).toBeGreaterThan(0)

    controller.disable()
    const frozen = act.actions.length
    for (let index = 0; index < 6; index += 1) tick()
    expect(act.actions.length).toBe(frozen)
    expect(controller.status().mode).toBe('off')
  })

  it('cancels the commitment and stops the lease when disabled', () => {
    const artifact = artifactWith(DIG, ['inventory'], ['dig'], { dig: 'act-dig-9' })
    const { controller, act, tick } = harness({ artifact })
    controller.enable(1000)
    controller.install({ artifactId: artifact.artifactId }, 1000)
    controller.commit({
      goal: 'dig',
      strategyKey: 'dig',
      post: { kind: 'count-at-least', factKey: 'inventory', item: 'stone', count: 1 } as JsonValue,
      baselineKeys: ['inventory'],
    }, 1000)
    tick()
    expect(act.actions).toHaveLength(1)

    const disabling = controller.disable(1200)
    expect(disabling.mode).toBe('disabling')
    expect(controller.status().commitments.every(entry => entry.state !== 'active')).toBe(true)
    expect(act.stopRequests.length).toBeGreaterThan(0)
    tick()
    expect(controller.status().mode).toBe('off')
  })

  it('rejects commits for uninstalled strategies or malformed post conditions', () => {
    const { controller } = harness()
    controller.enable(1000)
    expect(() => controller.commit({
      goal: 'x',
      strategyKey: 'missing',
      post: { kind: 'standing' } as JsonValue,
    }, 1100)).toThrowError(/not installed/u)
  })

  it('routes controller commands through the body protocol and refuses behavior switches', async () => {
    const artifact = artifactWith(IDLE, ['inventory'])
    const { controller } = harness({ artifact })
    const host = new ArtifactHost({
      bindingId: 'b',
      query: () => ({ status: 'ok', value: null }),
      act: new FakeActPort(),
    })
    const runtime = new BodyRuntime({
      body,
      host,
      controller,
      newEpoch: () => 'epoch-1',
      now: () => 1000,
    })
    runtime.handleRequest(request('hello', {
      protocols: [PROTOCOL_VERSION],
      owner,
    }))
    const otherOwner = runtime.handleRequest(request('hello', {
      protocols: [PROTOCOL_VERSION],
      owner: { ...owner, sessionId: 'other-session' },
    }))
    expect(otherOwner.error?.code).toBe('INVALID_OWNER')
    expect('activeRun' in runtime.status()).toBe(false)
    expect('guards' in runtime.status()).toBe(false)

    const enabled = runtime.handleRequest(request('controller.enable', {}))
    expect(enabled.error).toBeUndefined()
    expect((enabled.result as { mode: string }).mode).toBe('active')
    expect(runtime.status().controller?.mode).toBe('active')

    const installed = runtime.handleRequest(request('controller.install', { artifactId: artifact.artifactId }))
    expect(installed.error).toBeUndefined()

    const unknown = await runtime.handleRequestAsync({ ...request('switch', { artifactId: 'x' }), commandId: 'cmd-switch' })
    expect(unknown.error?.code).toBe('UNKNOWN_METHOD')

    const disabled = runtime.handleRequest(request('controller.disable', {}))
    expect(disabled.error).toBeUndefined()
  })
})





