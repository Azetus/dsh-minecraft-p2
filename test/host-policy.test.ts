import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BehaviorHost } from '../src/core/host.ts'
import { Sandbox } from '../src/runner/sandbox.ts'
import type { ActHandle, ActPort, PolicyPort, QueryPort } from '../src/core/node-runtime.ts'
import type { JsonValue } from '../src/contracts/types.ts'

const STOP_ACT = `
defineAct({
  manifest: { id: 'stop', queryOps: [], controlOps: ['stop'] },
  create: function () {
    return {
      start: function (ctx) { ctx.control('stop', {}); return { kind: 'complete' } },
      update: function () { return { kind: 'running' } },
    }
  },
})
`

const PICK_POLICY = `
definePolicy({
  manifest: { id: 'pick-nearest', inputs: ['items'], outputs: ['best'] },
  run: function (inputs) { return { best: inputs.items[0] } },
})
`

const BEHAVIOR = `
export default {
  id: 'flow-behavior',
  description: 'act then decide',
  mode: 'finite',
  parameters: {},
  locals: { pick: { type: 'json' } },
  root: {
    kind: 'sequence', id: 'root', children: [
      { kind: 'act', id: 'a', act: { definitionId: 'stop' }, args: {} },
      { kind: 'decide', id: 'd', policy: { definitionId: 'pick-nearest' }, inputs: { items: { kind: 'literal', value: [7, 8] } }, output: 'pick' },
    ],
  },
  completion: {
    kind: 'predicate',
    condition: { kind: 'expr', expr: { kind: 'binary', op: 'neq', left: { kind: 'local', name: 'pick' }, right: { kind: 'literal', value: null } } },
  },
}
`

const noQuery: QueryPort = () => ({ status: 'failed', error: { code: 'NO_QUERY', category: 'validation', message: 'unused', source: { module: 'test' }, retry: 'never' } })
const noAct: ActPort = { start: (): ActHandle => ({ poll: () => ({ status: 'succeeded' }), stop: () => {} }) }
const policy: PolicyPort = { call: () => ({ status: 'ok', value: { best: 7 } }) }

describe('host content artifact flow', () => {
  it('resolves act and policy artifacts for a behavior', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2-host-flow-'))
    try {
      const actPath = join(dir, 'stop.mjs')
      const policyPath = join(dir, 'pick.mjs')
      const behaviorPath = join(dir, 'flow.mjs')
      writeFileSync(actPath, STOP_ACT)
      writeFileSync(policyPath, PICK_POLICY)
      writeFileSync(behaviorPath, BEHAVIOR)

      const loadManifest = async (kind: 'act' | 'policy', code: string): Promise<JsonValue> => {
        const box = new Sandbox({ op: () => 0, log: () => {}, now: () => 0 })
        return box.load(kind, code)
      }
      const host = new BehaviorHost({ bindingId: 'b1', query: noQuery, act: noAct, policy, loadManifest })

      const act = await host.check({ sourcePath: actPath, artifactKind: 'act' })
      host.activate(act.artifactId)

      const checkedPolicy = await host.check({ sourcePath: policyPath, artifactKind: 'policy' })
      expect(() => host.activate(checkedPolicy.artifactId)).toThrow(/not enabled separately/u)

      const behavior = await host.check({ sourcePath: behaviorPath })
      expect(behavior.kind).toBe('behavior')
      host.activate(behavior.artifactId)

      const switched = host.switch({ artifactId: behavior.artifactId, params: {}, commandId: 'c1' })
      expect(switched.accepted).toBe(true)
      host.tick(0)
      const status = host.tick(1)
      expect(status).toBe('succeeded')
      expect(host.status().lastRun?.status).toBe('succeeded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a behavior whose act is not enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2-host-flow-'))
    try {
      const actPath = join(dir, 'stop.mjs')
      const behaviorPath = join(dir, 'flow.mjs')
      writeFileSync(actPath, STOP_ACT)
      writeFileSync(behaviorPath, BEHAVIOR.replace(/policy: \{[^}]*\}/u, "policy: { definitionId: 'pick-nearest' }"))
      const loadManifest = async (kind: 'act' | 'policy', code: string): Promise<JsonValue> => {
        const box = new Sandbox({ op: () => 0, log: () => {}, now: () => 0 })
        return box.load(kind, code)
      }
      const host = new BehaviorHost({ bindingId: 'b1', query: noQuery, act: noAct, policy, loadManifest })
      await host.check({ sourcePath: actPath, artifactKind: 'act' })
      await expect(host.check({ sourcePath: behaviorPath })).rejects.toThrow(/has no enabled artifact/u)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
