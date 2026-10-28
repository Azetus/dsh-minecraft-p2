import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { BehaviorHost } from '../src/core/host.ts'
import type { ActPort, QueryPort } from '../src/core/node-runtime.ts'

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
