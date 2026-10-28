import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkPolicy } from '../src/core/policy-checker.ts'
import { BehaviorExecutor } from '../src/core/executor.ts'
import type { ActPort, ActHandle, PolicyOutcome, PolicyPort, QueryPort } from '../src/core/node-runtime.ts'
import type { BehaviorDefinition } from '../src/contracts/ir.ts'
import type { JsonValue } from '../src/contracts/types.ts'
import { Sandbox } from '../src/runner/sandbox.ts'

const POLICY = `
definePolicy({
  manifest: { id: 'pick-nearest', inputs: ['items'], outputs: ['best'] },
  run: function (inputs) {
    var best = null
    for (var i = 0; i < inputs.items.length; i += 1) {
      if (best === null || inputs.items[i].distance < best.distance) best = inputs.items[i]
    }
    return { best: best }
  },
})
`

const noAct: ActPort = { start: (): ActHandle => ({ poll: () => ({ status: 'running' }), stop: () => {} }) }
const noQuery: QueryPort = () => ({ status: 'failed', error: { code: 'NO_QUERY', category: 'validation', message: 'unused', source: { module: 'test' }, retry: 'never' } })

function definition(): BehaviorDefinition {
  return {
    id: 'decide-behavior',
    description: 'test',
    mode: 'finite',
    parameters: {},
    locals: { items: { type: 'json', initial: [{ id: 'a', distance: 5 }, { id: 'b', distance: 2 }] }, pick: { type: 'json' } },
    root: {
      kind: 'sequence',
      id: 'root',
      children: [
        {
          kind: 'decide',
          id: 'pick',
          policy: { definitionId: 'pick-nearest', artifactId: 'p2:policy:test' },
          inputs: { items: { kind: 'local', name: 'items' } },
          output: 'pick',
        },
      ],
    },
    completion: { kind: 'predicate', condition: { kind: 'expr', expr: { kind: 'binary', op: 'neq', left: { kind: 'local', name: 'pick' }, right: { kind: 'literal', value: null } } } },
  }
}

function pendingPolicy(value: () => JsonValue, polls: number): PolicyPort {
  return {
    call: () => {
      let remaining = polls
      const poll = (): PolicyOutcome => {
        remaining -= 1
        return remaining > 0 ? { status: 'pending', poll } : { status: 'ok', value: value() }
      }
      return poll()
    },
  }
}

function stalled(): PolicyOutcome {
  const poll = (): PolicyOutcome => ({ status: 'pending', poll })
  return poll()
}

describe('decide node', () => {
  it('waits for the policy result without blocking cancellation', () => {
    const executor = new BehaviorExecutor({
      definition: definition(),
      params: {},
      query: noQuery,
      act: noAct,
      policy: pendingPolicy(() => ({ best: { id: 'b' } }), 2),
    })
    expect(executor.tick(0)).toBe('running')
    expect(executor.tick(1)).toBe('succeeded')
    expect(executor.frame.get('pick')).toEqual({ best: { id: 'b' } })
    expect(executor.frame.getSlot('pick')?.meta.source).toBe('policy')
  })

  it('fails the node when the policy fails', () => {
    const executor = new BehaviorExecutor({
      definition: definition(),
      params: {},
      query: noQuery,
      act: noAct,
      policy: { call: () => ({ status: 'failed', error: { code: 'POLICY_TIMEOUT', category: 'timeout', message: 'late', source: { module: 'test' }, retry: 'never' } }) },
    })
    expect(executor.tick(0)).toBe('failed')
    expect(executor.currentError?.code).toBe('POLICY_TIMEOUT')
  })

  it('cancels while the policy is pending', () => {
    const executor = new BehaviorExecutor({
      definition: definition(),
      params: {},
      query: noQuery,
      act: noAct,
      policy: { call: () => stalled() },
    })
    expect(executor.tick(0)).toBe('running')
    executor.stop()
    expect(executor.tick(1)).toBe('cancelled')
  })
})

describe('policy checker', () => {
  const loadManifest = async (code: string): Promise<JsonValue> => {
    const box = new Sandbox({ op: () => 0, log: () => {}, now: () => 0 })
    return box.load('policy', code)
  }

  function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'p2-policy-check-'))
    return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  it('produces a policy artifact without operations', async () => {
    await withDir(async dir => {
      const path = join(dir, 'pick.mjs')
      writeFileSync(path, POLICY)
      const checked = await checkPolicy({ sourcePath: path, bindingId: 'b1', loadManifest })
      expect(checked.artifact.kind).toBe('policy')
      expect(checked.artifact.definitionId).toBe('pick-nearest')
      expect(checked.artifact.manifest.kind).toBe('policy')
      expect(checked.artifact.manifest.ops).toBeUndefined()
    })
  })

  it('rejects forbidden syntax and bad manifests', async () => {
    await withDir(async dir => {
      const bad = join(dir, 'bad.mjs')
      writeFileSync(bad, 'var fs = require("fs")\n')
      await expect(checkPolicy({ sourcePath: bad, bindingId: 'b1', loadManifest })).rejects.toThrow(/must not use require/u)

      const missing = join(dir, 'missing.mjs')
      writeFileSync(missing, 'definePolicy({ manifest: { id: "x" }, run: function () { return 1 } })')
      await expect(checkPolicy({ sourcePath: missing, bindingId: 'b1', loadManifest })).rejects.toThrow(/inputs must be an array/u)
    })
  })
})
