import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { BehaviorHost } from '../src/core/host.ts'
import { MultiBindingHost } from '../src/core/multi-host.ts'
import type { ActPort, QueryPort } from '../src/core/node-runtime.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const query: QueryPort = () => ({ status: 'ok', value: null })
const act: ActPort = { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) }

function source(id: string): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-multi-'))
  dirs.push(dir)
  const path = join(dir, `${id}.mjs`)
  writeFileSync(path, `
export default {
  id: '${id}', description: 'multi', mode: 'finite', parameters: {}, locals: {},
  root: { kind: 'sequence', id: '${id}-root', children: [] },
  completion: { kind: 'externalConfirmation', description: 'ack' },
}
`)
  return path
}

describe('MultiBindingHost', () => {
  it('keeps H1 running while H2 is checked/activated, then switches explicitly', async () => {
    const h1 = new BehaviorHost({ bindingId: 'h1', owner: 'owner-h1', query, act })
    const h2 = new BehaviorHost({ bindingId: 'h2', owner: 'owner-h2', query, act })
    const multi = new MultiBindingHost()
    multi.add('h1', h1)
    multi.add('h2', h2)

    const a1 = await multi.check('h1', { sourcePath: source('h1-behavior') })
    const a2 = await multi.check('h2', { sourcePath: source('h2-behavior') })
    multi.activate('h1', a1.artifactId)
    multi.activate('h2', a2.artifactId)

    const first = multi.switch({ bindingId: 'h1', artifactId: a1.artifactId, params: {}, commandId: 's1' })
    expect(first.accepted).toBe(true)
    expect(multi.tick()).toBe('blocked')
    expect(multi.status()?.bindingId).toBe('h1')
    expect(h1.status().activeRun?.runId).toBe(first.runId)

    // Checking/activating H2 must not change the running H1 binding.
    expect(multi.status()?.bindingId).toBe('h1')
    expect(h1.status().activeRun?.runId).toBe(first.runId)

    const second = multi.switch({ bindingId: 'h2', artifactId: a2.artifactId, params: {}, commandId: 's2' })
    expect(second.accepted).toBe(true)
    expect(multi.activeBindingId()).toBe('h2')
    expect(h1.status().activeRun).toBeNull()
    expect(multi.tick()).toBe('blocked')

    const pending = multi.status()?.pendingConfirmation
    const confirmed = multi.confirm({
      runId: second.runId as string,
      confirmationId: pending?.id as string,
      owner: 'owner-h2',
      source: 'test',
      decision: 'confirm',
      commandId: 'confirm-h2',
    })
    expect(confirmed.outcome).toBe('confirmed')
  })

  it('rejects switching to a binding that was not registered', () => {
    const multi = new MultiBindingHost()
    const result = multi.switch({ bindingId: 'missing', artifactId: 'x', params: {}, commandId: 'x' })
    expect(result.accepted).toBe(false)
    expect(result.error?.code).toBe('BINDING_NOT_FOUND')
  })
})
