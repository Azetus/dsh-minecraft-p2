import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { BehaviorHost } from '../src/core/host.ts'
import type { ActPort, QueryPort, ReleaseStatus } from '../src/core/node-runtime.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const query: QueryPort = () => ({ status: 'ok', value: null })
const act: ActPort = { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) }

function source(name: string, body: string): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-host-'))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

const external = `
export default {
  id: 'external-a', description: 'external', mode: 'finite', parameters: {}, locals: {},
  root: { kind: 'sequence', id: 'a-root', children: [] },
  completion: { kind: 'externalConfirmation', description: 'player ack' },
}
`

const predicate = `
export default {
  id: 'predicate-b', description: 'predicate', mode: 'finite', parameters: {}, locals: {},
  root: { kind: 'sequence', id: 'b-root', children: [] },
  completion: { kind: 'predicate', condition: { kind: 'expr', expr: { kind: 'literal', value: true } } },
}
`

const waiting = `
export default {
  id: 'waiting-c', description: 'wait', mode: 'finite', parameters: {}, locals: {},
  root: { kind: 'wait', id: 'settle-node', durationMs: 5000 },
  completion: { kind: 'externalConfirmation', description: 'never happens during the test' },
}
`

const jsObservation = `
defineBehavior({
  manifest: { id: 'obs-js', mode: 'finite', parameters: {} },
  *run(ctx) { yield ctx.progress({ n: 1 }); return ctx.succeed({ ok: true }) },
})
`

function releasableAct(): { act: ActPort; release: (state: ReleaseStatus) => void } {
  let state: ReleaseStatus = 'stopping'
  return {
    act: {
      start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }),
      stopRun: () => {},
      pollRelease: () => state,
    },
    release: next => { state = next },
  }
}

describe('BehaviorHost workflow', () => {
  it('checks, activates, switches, confirms and retires with one active run', async () => {
    const host = new BehaviorHost({ bindingId: 'binding-1', query, act })
    const a = await host.check({ sourcePath: source('a.mjs', external) })
    const b = await host.check({ sourcePath: source('b.mjs', predicate) })
    host.activate(a.artifactId)
    host.activate(b.artifactId)

    const first = host.switch({ artifactId: a.artifactId, params: {}, commandId: 'switch-a' })
    expect(first.accepted).toBe(true)
    expect(host.status().activeRun?.artifactId).toBe(a.artifactId)
    expect(host.tick()).toBe('blocked')
    const pending = host.status().pendingConfirmation
    expect(pending).not.toBeNull()

    const confirmed = host.confirm({
      runId: first.runId as string,
      confirmationId: pending?.id as string,
      owner: 'host',
      source: 'test',
      decision: 'confirm',
      commandId: 'confirm-a',
    })
    expect(confirmed.outcome).toBe('confirmed')
    expect(host.tick()).toBe('succeeded')
    expect(host.status().activeRun).toBeNull()
    expect(host.status().lastRun).toMatchObject({ runId: first.runId, status: 'succeeded' })

    const second = host.switch({ artifactId: b.artifactId, params: {}, commandId: 'switch-b' })
    expect(second.accepted).toBe(true)
    expect(host.tick()).toBe('succeeded')
    expect(host.status().pendingConfirmation).toBeNull()

    host.retire(b.artifactId)
    const retired = host.switch({ artifactId: b.artifactId, params: {}, commandId: 'switch-retired' })
    expect(retired.accepted).toBe(false)
    expect(retired.status).toBe('rejected')
  })

  it('stops the old run before accepting a switch and rejects unknown artifacts', async () => {
    const host = new BehaviorHost({ bindingId: 'binding-1', query, act })
    const a = await host.check({ sourcePath: source('a.mjs', external) })
    host.activate(a.artifactId)
    const first = host.switch({ artifactId: a.artifactId, params: {}, commandId: 'one' })
    host.tick()
    const second = host.switch({ artifactId: a.artifactId, params: {}, commandId: 'two' })
    expect(second.accepted).toBe(true)
    expect(second.runId).not.toBe(first.runId)
    expect(host.status().lastRun).toMatchObject({ runId: first.runId, status: 'cancelled' })

    const missing = host.switch({ artifactId: 'p2:behavior:missing', params: {}, commandId: 'missing' })
    expect(missing.accepted).toBe(false)
    expect(missing.error?.code).toBe('ARTIFACT_NOT_ACTIVE')
  })

  it('reports progress, evidence and observation fields through status', async () => {
    const host = new BehaviorHost({ bindingId: 'binding-1', query, act })
    const artifact = await host.check({ sourcePath: source('obs.mjs', jsObservation), format: 'js' })
    host.activate(artifact.artifactId)
    const run = host.switch({ artifactId: artifact.artifactId, params: {}, commandId: 'obs' })
    expect(host.tick(0)).toBe('succeeded')
    const status = host.status()
    expect(status.lastRun).toMatchObject({
      runId: run.runId,
      status: 'succeeded',
      progress: { n: 1 },
      evidence: { ok: true },
    })
    expect(status.currentStep).toBeNull()
    expect(status.stepCount).toBe(2)
    expect(status.cleanupState).toBe('none')
    expect(status.controlHealth).toBe('ok')
    expect(status.switchState).toBe('none')
  })

  it('requires a checker credential before activation', async () => {
    const host = new BehaviorHost({ bindingId: 'binding-1', query, act })
    expect(() => host.activate('p2:behavior:unknown')).toThrow(/credential/)
  })

  it('clears active act/node/target once the run is terminal', async () => {
    const waiting = `
export default {
  id: 'waiting-c', description: 'wait', mode: 'finite', parameters: {}, locals: {},
  root: { kind: 'wait', id: 'settle-node', durationMs: 5000 },
  completion: { kind: 'predicate', condition: { kind: 'expr', expr: { kind: 'literal', value: false } } },
}
`
    const host = new BehaviorHost({ bindingId: 'binding-1', query, act })
    const artifact = await host.check({ sourcePath: source('waiting.mjs', waiting) })
    host.activate(artifact.artifactId)
    const run = host.switch({ artifactId: artifact.artifactId, params: {}, commandId: 'wait-run' })
    host.tick()
    expect(host.status().waiting).toBe('wait')
    host.stop(run.runId as string)
    host.tick()
    const status = host.status()
    expect(status.activeRun).toBeNull()
    expect(status.activeAct).toBeNull()
    expect(status.activeNode).toBeNull()
    expect(status.activeTarget).toBeNull()
    expect(status.waiting).toBeNull()
  })
})

describe('BehaviorHost stop and takeover', () => {
  async function pair(act: ActPort): Promise<{ host: BehaviorHost; oldArtifact: string; nextArtifact: string }> {
    const host = new BehaviorHost({ bindingId: 'binding-1', query, act })
    const oldOne = await host.check({ sourcePath: source('waiting-switch.mjs', waiting) })
    const nextOne = await host.check({ sourcePath: source('next-switch.mjs', predicate) })
    host.activate(oldOne.artifactId)
    host.activate(nextOne.artifactId)
    return { host, oldArtifact: oldOne.artifactId, nextArtifact: nextOne.artifactId }
  }

  it('queues a switch until the old run proves release', async () => {
    const control = releasableAct()
    const { host, oldArtifact, nextArtifact } = await pair(control.act)
    const first = host.switch({ artifactId: oldArtifact, params: {}, commandId: 'old' })
    expect(host.tick(0)).toBe('running')

    const second = host.switch({ artifactId: nextArtifact, params: {}, commandId: 'next' })
    expect(second.accepted).toBe(true)
    expect(second.status).toBe('stopping')
    expect(second.runId).toBe(first.runId)
    expect(host.status().activeRun?.artifactId).toBe(oldArtifact)
    expect(host.status().switchState).toBe('queued')
    expect(host.status().cleanupState).toBe('running')

    control.release('released')
    host.tick(10)
    expect(host.status().lastRun).toMatchObject({ runId: first.runId, status: 'cancelled' })
    expect(host.status().activeRun?.artifactId).toBe(nextArtifact)
    expect(host.tick(11)).toBe('succeeded')
  })

  it('does not take over while release is unconfirmed', async () => {
    const control = releasableAct()
    control.release('unconfirmed')
    const { host, oldArtifact, nextArtifact } = await pair(control.act)
    host.switch({ artifactId: oldArtifact, params: {}, commandId: 'old' })
    host.tick(0)

    const second = host.switch({ artifactId: nextArtifact, params: {}, commandId: 'next' })
    expect(second.accepted).toBe(false)
    expect(second.status).toBe('superseded')
    expect(second.error?.code).toBe('STOP_UNCONFIRMED')
    expect(host.status().activeRun?.artifactId).toBe(oldArtifact)

    control.release('released')
    host.tick(10)
    expect(host.status().activeRun).toBeNull()

    const takeover = host.switch({ artifactId: nextArtifact, params: {}, commandId: 'after-release' })
    expect(takeover.accepted).toBe(true)
    expect(host.tick(11)).toBe('succeeded')
  })

  it('clears a pending switch when the old run is stopped by the user', async () => {
    const control = releasableAct()
    const { host, oldArtifact, nextArtifact } = await pair(control.act)
    const first = host.switch({ artifactId: oldArtifact, params: {}, commandId: 'old' })
    host.tick(0)

    host.switch({ artifactId: nextArtifact, params: {}, commandId: 'next' })
    host.stop(first.runId as string)
    control.release('released')
    host.tick(10)
    expect(host.status().activeRun).toBeNull()
  })
})
