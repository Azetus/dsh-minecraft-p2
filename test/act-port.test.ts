import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { RunnerActPort } from '../src/core/act-port.ts'
import { DeclaredOpBroker } from '../src/core/op-broker.ts'
import { RunnerClient } from '../src/core/runner-client.ts'
import type { ActHandle, ActPoll } from '../src/core/node-runtime.ts'
import type { JsonValue } from '../src/contracts/types.ts'

const runnerEntry = join(process.cwd(), 'lib', 'runner.js')
const hasRunner = existsSync(runnerEntry)

const MOVE_ACT = `
defineAct({
  manifest: { id: 'it-move', queryOps: [], controlOps: ['moveTo', 'stop'] },
  create: function () {
    var handle = null
    return {
      start: function (ctx) { handle = ctx.control('moveTo', { x: 1, z: 2 }); return { kind: 'running' } },
      update: function (ctx, input) {
        for (var i = 0; i < input.handles.length; i += 1) {
          if (input.handles[i].id === handle) {
            if (input.handles[i].status === 'ok') return { kind: 'complete', result: { reached: true } }
            return { kind: 'failed', error: input.handles[i].error }
          }
        }
        return { kind: 'running' }
      },
      stop: function (ctx) { ctx.control('stop', {}); return { kind: 'running' } },
      cleanup: function () { return { kind: 'complete' } },
    }
  },
})
`

const LOOP_ACT = `
defineAct({
  manifest: { id: 'it-loop', queryOps: [], controlOps: [] },
  create: function () {
    return {
      start: function () { return { kind: 'running' } },
      update: function () { return { kind: 'running' } },
      stop: function () { return { kind: 'running' } },
      cleanup: function () { return { kind: 'complete' } },
    }
  },
})
`

const UNDECLARED_ACT = `
defineAct({
  manifest: { id: 'it-undeclared', queryOps: [], controlOps: [] },
  create: function () {
    var handle = null
    return {
      start: function (ctx) { handle = ctx.control('dig', { x: 0, y: 0, z: 0 }); return { kind: 'running' } },
      update: function (ctx, input) {
        for (var i = 0; i < input.handles.length; i += 1) {
          if (input.handles[i].status === 'failed') return { kind: 'failed', error: input.handles[i].error }
        }
        return { kind: 'running' }
      },
      stop: function () { return { kind: 'running' } },
      cleanup: function () { return { kind: 'complete' } },
    }
  },
})
`

class SlowHandle implements ActHandle {
  private ticks = 0
  stop(): void {
    this.ticks = 99
  }

  poll(): ActPoll {
    this.ticks += 1
    if (this.ticks < 3) return { status: 'running' }
    return { status: 'succeeded', result: { ok: true } }
  }
}

function broker(): DeclaredOpBroker {
  return new DeclaredOpBroker({
    start: () => new SlowHandle(),
    query: () => ({ status: 'ok', value: [], meta: { source: 'query', scope: 'test', sampledAt: 0 } }),
  })
}

async function waitFor<T>(fn: () => T | undefined, label: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = fn()
    if (value !== undefined) return value
    await sleep(10)
  }
  throw new Error(`${label} timed out`)
}

describe.skipIf(!hasRunner)('runner act port', () => {
  it('completes an act after the op result arrives', async () => {
    const sources = new Map<string, { artifactId: string; definitionId: string; code: string; ops: { query: string[]; control: string[] } }>()
    sources.set('act:move', {
      artifactId: 'act:move',
      definitionId: 'it-move',
      code: MOVE_ACT,
      ops: { query: [], control: ['moveTo', 'stop'] },
    })
    let port: RunnerActPort | undefined
    const client = new RunnerClient({ entry: runnerEntry, onOp: event => port?.handleOp(event) })
    try {
      port = new RunnerActPort(client, broker(), artifactId => sources.get(artifactId))
      const handle = port.start({ definitionId: 'it-move', artifactId: 'act:move' }, {})
      const final = await waitFor(() => {
        const result = handle.poll()
        return result.status === 'running' ? undefined : result
      }, 'act completion')
      expect(final.status).toBe('succeeded')
      expect(final.status === 'succeeded' ? final.result : undefined).toEqual({ reached: true })
    } finally {
      port?.dispose()
      client.dispose()
    }
  })

  it('cancels a running act and reports it as cancelled', async () => {
    const sources = new Map<string, { artifactId: string; definitionId: string; code: string; ops: { query: string[]; control: string[] } }>()
    sources.set('act:loop', {
      artifactId: 'act:loop',
      definitionId: 'it-loop',
      code: LOOP_ACT,
      ops: { query: [], control: [] },
    })
    let port: RunnerActPort | undefined
    const client = new RunnerClient({ entry: runnerEntry, onOp: event => port?.handleOp(event) })
    try {
      port = new RunnerActPort(client, broker(), artifactId => sources.get(artifactId))
      const handle = port.start({ definitionId: 'it-loop', artifactId: 'act:loop' }, {})
      await sleep(80)
      handle.stop()
      const final = await waitFor(() => {
        const result = handle.poll()
        return result.status === 'running' ? undefined : result
      }, 'act cancellation')
      expect(final.status).toBe('cancelled')
    } finally {
      port?.dispose()
      client.dispose()
    }
  })

  it('fails closed when the act submits an undeclared op', async () => {
    const sources = new Map<string, { artifactId: string; definitionId: string; code: string; ops: { query: string[]; control: string[] } }>()
    sources.set('act:undeclared', {
      artifactId: 'act:undeclared',
      definitionId: 'it-undeclared',
      code: UNDECLARED_ACT,
      ops: { query: [], control: [] },
    })
    let port: RunnerActPort | undefined
    const client = new RunnerClient({ entry: runnerEntry, onOp: event => port?.handleOp(event) })
    try {
      port = new RunnerActPort(client, broker(), artifactId => sources.get(artifactId))
      const handle = port.start({ definitionId: 'it-undeclared', artifactId: 'act:undeclared' }, {})
      const final = await waitFor(() => {
        const result = handle.poll()
        return result.status === 'running' ? undefined : result
      }, 'undeclared op failure')
      expect(final.status).toBe('failed')
      expect(final.status === 'failed' ? final.error.code : undefined).toBe('OP_NOT_DECLARED')
    } finally {
      port?.dispose()
      client.dispose()
    }
  })

  it('runs a policy through the same runner', async () => {
    const client = new RunnerClient({ entry: runnerEntry, onOp: () => {} })
    try {
      await client.load('policy', 'policy:pick', `
        definePolicy({
          manifest: { id: 'it-policy', inputs: ['items'], outputs: ['best'] },
          run: function (inputs) {
            var best = null
            for (var i = 0; i < inputs.items.length; i += 1) {
              if (best === null || inputs.items[i].d < best.d) best = inputs.items[i]
            }
            return { best: best }
          },
        })
      `)
      const value = await client.runPolicy('policy:pick', { items: [{ id: 'a', d: 3 }, { id: 'b', d: 1 }] } as JsonValue)
      expect(value).toEqual({ best: { id: 'b', d: 1 } })
    } finally {
      client.dispose()
    }
  })
})
