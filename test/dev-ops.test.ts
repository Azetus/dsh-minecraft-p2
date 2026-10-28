import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Bot } from 'mineflayer'

import { DevOpsHost, createCompositeOpSource, devCapabilities } from '../src/body/dev-ops.ts'
import { DeclaredOpBroker } from '../src/core/op-broker.ts'
import type { OpSource } from '../src/core/op-broker.ts'
import type { ActHandle, ActPoll } from '../src/core/node-runtime.ts'
import { operationContract, requireOperation, setExternalOperations } from '../src/operation/index.ts'

const dirs: string[] = []
const hosts: DevOpsHost[] = []

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose()
  setExternalOperations([])
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeModule(source: string): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-devops-'))
  dirs.push(dir)
  const path = join(dir, 'dev-ops.mjs')
  writeFileSync(path, source)
  return path
}

const MODULE = `
export const operations = [
  {
    id: 'dev-scan',
    kind: 'query',
    query: () => ({ status: 'ok', value: { scanned: true } }),
  },
  {
    id: 'dev-dig',
    kind: 'control',
    effects: 'active',
    stop: 'poll',
    capabilities: ['dig'],
    start: () => ({ poll: () => ({ status: 'succeeded', result: { done: true } }), stop: () => {} }),
  },
]
`

function fakeBot(): Bot {
  return Object.assign(new EventEmitter(), { username: 'dev' }) as unknown as Bot
}

function baseSource(): OpSource & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    capabilities: ['look'],
    query: (op: string) => {
      calls.push(`query:${op}`)
      return { status: 'ok', value: { op } }
    },
    start: (op: string): ActHandle => {
      calls.push(`start:${op}`)
      return { poll: (): ActPoll => ({ status: 'succeeded' }), stop: () => {} }
    },
  }
}

describe('developer operation hook', () => {
  it('loads a module, registers its contracts and exposes them by kind', async () => {
    const path = writeModule(MODULE)
    const host = await DevOpsHost.create(path, fakeBot())
    hosts.push(host)

    expect(host.info()).toMatchObject({
      enabled: true,
      generation: 1,
      operations: ['dev-dig', 'dev-scan'],
      lastError: null,
    })
    expect(operationContract('dev-scan')).toMatchObject({ kind: 'query', effects: 'none', stop: 'none' })
    expect(requireOperation('dev-dig', 'control', 'test').effects).toBe('active')
    expect(() => requireOperation('dev-scan', 'control', 'test')).toThrow(/is query, not control/u)
    expect(devCapabilities(host)).toEqual(['dig'])
  })

  it('reloads on demand and keeps the previous generation when the new file is invalid', async () => {
    const path = writeModule(MODULE)
    const host = await DevOpsHost.create(path, fakeBot())
    hosts.push(host)
    expect(host.info().generation).toBe(1)

    writeFileSync(path, `
export const operations = [
  { id: 'dev-only-later', kind: 'query', query: () => ({ status: 'ok', value: 1 }) },
]
`)
    await host.reload()
    expect(host.info()).toMatchObject({ generation: 2, operations: ['dev-only-later'] })
    expect(operationContract('dev-scan')).toBeUndefined()

    writeFileSync(path, 'export const operations = [{ id: "broken", kind: "control" }]')
    await host.reload()
    expect(host.info().lastError).toContain('no start function')
    expect(host.info().operations).toEqual(['dev-only-later'])
  })

  it('routes developer operations through the composite source', async () => {
    const path = writeModule(MODULE)
    const host = await DevOpsHost.create(path, fakeBot())
    hosts.push(host)
    const base = baseSource()
    const broker = new DeclaredOpBroker(createCompositeOpSource(base, host, fakeBot()))

    expect(broker.query('dev-scan', {})).toMatchObject({ status: 'ok', value: { scanned: true } })
    expect(broker.start('dev-dig', {}).poll()).toMatchObject({ status: 'succeeded' })
    expect(broker.query('position', {})).toMatchObject({ status: 'ok', value: { op: 'position' } })
    expect(base.calls).toEqual(['query:position'])
  })

  it('reports a load error without registering anything', async () => {
    const path = writeModule('throw new Error("boom")')
    const host = await DevOpsHost.create(path, fakeBot())
    hosts.push(host)
    expect(host.info()).toMatchObject({ operations: [], lastError: expect.stringContaining('boom') })
    expect(operationContract('dev-scan')).toBeUndefined()
  })
})
