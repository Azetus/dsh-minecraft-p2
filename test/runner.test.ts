import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { checkAct, forbiddenToken } from '../src/core/act-checker.ts'
import { BehaviorHost } from '../src/core/host.ts'
import { RunnerClient } from '../src/core/runner-client.ts'
import { Sandbox, SandboxError } from '../src/runner/sandbox.ts'
import type { JsonValue } from '../src/contracts/types.ts'

const MOVE_ACT = `
defineAct({
  manifest: { id: 'test-move', queryOps: [], controlOps: ['moveTo', 'stop'] },
  create: function (args) {
    var handle = null
    return {
      start: function (ctx) { handle = ctx.control('moveTo', { x: args.x, z: args.z }); return { kind: 'running' } },
      update: function (ctx, input) {
        var list = input.handles
        for (var i = 0; i < list.length; i += 1) {
          if (list[i].id === handle && list[i].status === 'ok') return { kind: 'complete', result: { done: true } }
        }
        return { kind: 'running' }
      },
      stop: function () { return { kind: 'running' } },
      cleanup: function () { return { kind: 'complete' } },
    }
  },
})
`

const POLICY = `
definePolicy({
  manifest: { id: 'test-policy', inputs: ['items'], outputs: ['best'] },
  run: function (inputs) {
    var best = null
    for (var i = 0; i < inputs.items.length; i += 1) {
      if (best === null || inputs.items[i].distance < best.distance) best = inputs.items[i]
    }
    return { best: best }
  },
})
`

function sandbox(): { sandbox: Sandbox; ops: Array<{ kind: string; name: string; args: JsonValue }>; calls: number[] } {
  const ops: Array<{ kind: string; name: string; args: JsonValue }> = []
  const calls: number[] = []
  const box = new Sandbox({
    op: (kind, name, args) => {
      const callId = calls.length + 1
      calls.push(callId)
      ops.push({ kind, name, args })
      return callId
    },
    log: () => {},
    now: () => 0,
  })
  return { sandbox: box, ops, calls }
}

describe('runner sandbox', () => {
  it('loads an act, submits ops and completes from an update', () => {
    const { sandbox: box, ops } = sandbox()
    const manifest = box.load('act', MOVE_ACT) as { id: string; controlOps: string[] }
    expect(manifest.id).toBe('test-move')
    expect(manifest.controlOps).toEqual(['moveTo', 'stop'])

    expect(box.start({ x: 3, z: 4 })).toEqual({ kind: 'running' })
    expect(ops).toEqual([{ kind: 'control', name: 'moveTo', args: { x: 3, z: 4 } }])
    expect(box.update({ handles: [] })).toEqual({ kind: 'running' })
    expect(box.update({ handles: [{ id: 1, status: 'ok', value: { reached: true } }] }))
      .toEqual({ kind: 'complete', result: { done: true } })
    expect(box.stop('completed')).toEqual({ kind: 'running' })
    expect(box.cleanup({ handles: [] })).toEqual({ kind: 'complete' })
  })

  it('runs a policy and refuses act hooks', () => {
    const { sandbox: box } = sandbox()
    box.load('policy', POLICY)
    const value = box.runPolicy({ items: [{ distance: 4 }, { distance: 1 }, { distance: 9 }] })
    expect(value).toEqual({ best: { distance: 1 } })
    expect(() => box.start({})).toThrow(SandboxError)
  })

  it('has no host globals and blocks dynamic code generation', () => {
    const { sandbox: box } = sandbox()
    box.load('policy', `
      definePolicy({
        manifest: { id: 'escape', inputs: [], outputs: [] },
        run: function () {
          return {
            process: typeof process,
            require: typeof require,
            globalProcess: typeof globalThis.process,
            functionCtor: (function () {
              try { return String(new Function('return 1')()) } catch (error) { return 'blocked' }
            })(),
            evalResult: (function () {
              try { return String(eval('1 + 1')) } catch (error) { return 'blocked' }
            })(),
          }
        },
      })
    `)
    const value = box.runPolicy(null) as Record<string, string>
    expect(value.process).toBe('undefined')
    expect(value.require).toBe('undefined')
    expect(value.globalProcess).toBe('undefined')
    expect(value.functionCtor).toBe('blocked')
    expect(value.evalResult).toBe('blocked')
  })

  it('interrupts a hook that never returns', () => {
    const { sandbox: box } = sandbox()
    box.load('act', `
      defineAct({
        manifest: { id: 'loop', queryOps: [], controlOps: [] },
        create: function () { return { start: function () { while (true) {} }, update: function () { return { kind: 'running' } } } },
      })
    `)
    expect(() => box.start({})).toThrow(/exceeded 500ms/u)
    expect(box.isBroken).toBe(true)
  })

  it('rejects modules that do not call defineAct', () => {
    const { sandbox: box } = sandbox()
    expect(() => box.load('act', 'var x = 1\n')).toThrow(/must call defineAct/u)
  })
})

describe('runner sandbox behavior role', () => {
  const BEHAVIOR = `
    defineBehavior({
      manifest: { id: 'test-behavior', mode: 'continuous', parameters: { n: { type: 'number' } } },
      *run(ctx) {
        const pos = yield ctx.query('position', {})
        yield ctx.progress({ n: ctx.params.n })
        if (pos.value && pos.value.x === 1) return ctx.succeed({ ok: true })
        return ctx.fail('NO_TARGET', 'no target')
      },
    })
  `

  it('loads a behavior and steps its generator across requests', () => {
    const { sandbox: box, ops } = sandbox()
    const manifest = box.load('behavior', BEHAVIOR) as { id: string }
    expect(manifest.id).toBe('test-behavior')
    box.behaviorStart({ n: 2 }, 'run-1')
    expect(box.behaviorStep({ thrown: false })).toEqual({
      kind: 'yield',
      command: { type: 'query', op: 'position', args: {} },
    })
    expect(ops).toEqual([])
    expect(box.behaviorStep({ value: { value: { x: 1 }, meta: {} }, thrown: false })).toEqual({
      kind: 'yield',
      command: { type: 'progress', value: { n: 2 } },
    })
    expect(box.behaviorStep({ thrown: false })).toEqual({
      kind: 'done',
      value: { type: 'succeed', evidence: { ok: true } },
    })
  })

  it('returns thrown author errors and rejects non-generator modules', () => {
    const { sandbox: box } = sandbox()
    expect(() => box.load('behavior', `
      defineBehavior({ manifest: { id: 'bad', mode: 'continuous', parameters: {} }, run() {} })
    `)).toThrow(/synchronous generator/u)

    const { sandbox: throwing } = sandbox()
    throwing.load('behavior', `
      defineBehavior({
        manifest: { id: 'throws', mode: 'continuous', parameters: {} },
        *run() { throw { code: 'CUSTOM_FAIL', category: 'runtime', message: 'boom', source: { module: 'test' }, retry: 'never' } },
      })
    `)
    throwing.behaviorStart({}, 'run-1')
    expect(throwing.behaviorStep({ thrown: false })).toMatchObject({
      kind: 'threw',
      error: { code: 'CUSTOM_FAIL', message: 'boom' },
    })
  })
})

describe('act checker', () => {
  function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'p2-act-check-'))
    return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  const loadManifest = async (code: string): Promise<JsonValue> => {
    const box = new Sandbox({ op: () => 0, log: () => {}, now: () => 0 })
    return box.load('act', code)
  }

  it('produces an immutable act artifact with declared operations', async () => {
    await withDir(async dir => {
      const path = join(dir, 'move.mjs')
      writeFileSync(path, MOVE_ACT)
      const checked = await checkAct({ sourcePath: path, bindingId: 'b1', loadManifest })
      expect(checked.artifact.kind).toBe('act')
      expect(checked.artifact.definitionId).toBe('test-move')
      expect(checked.artifact.ops).toEqual({ query: [], control: ['moveTo', 'stop'] })
      expect(checked.artifact.manifest.codeDigest).toMatch(/^sha256:/u)
    })
  })

  it('rejects imports, unknown operations and kind mismatches', async () => {
    await withDir(async dir => {
      const imports = join(dir, 'imports.mjs')
      writeFileSync(imports, "import fs from 'node:fs'\n")
      await expect(checkAct({ sourcePath: imports, bindingId: 'b1', loadManifest })).rejects.toThrow(/must not use import/u)

      const unknown = join(dir, 'unknown.mjs')
      writeFileSync(unknown, MOVE_ACT.replace("['moveTo', 'stop']", "['teleport']"))
      await expect(checkAct({ sourcePath: unknown, bindingId: 'b1', loadManifest })).rejects.toThrow(/unknown operation/u)

      const mismatch = join(dir, 'mismatch.mjs')
      writeFileSync(mismatch, MOVE_ACT.replace("queryOps: []", "queryOps: ['moveTo']"))
      await expect(checkAct({ sourcePath: mismatch, bindingId: 'b1', loadManifest })).rejects.toThrow(/is control, not query/u)
    })
  })

  it('detects forbidden tokens before executing the code', () => {
    expect(forbiddenToken('var x = require("fs")')).toBe('require')
    expect(forbiddenToken('ctx.control("moveTo", {})')).toBeUndefined()
  })
})

describe('runner process behavior binding', () => {
  const CODE = `
    defineBehavior({
      manifest: { id: 'process-behavior', mode: 'continuous', parameters: {} },
      *run(ctx) {
        const pos = yield ctx.query('position', {})
        return ctx.succeed({ x: pos.value.x })
      },
    })
  `

  it('binds messages to runId/generation and rejects stale steps', async () => {
    const entry = fileURLToPath(new URL('../lib/runner.js', import.meta.url))
    const client = new RunnerClient({ entry, onOp: () => {} })
    try {
      await client.load('behavior', 'p2:behavior:process', CODE)
      await client.behaviorStart('p2:behavior:process', 'run-1', 'act-1', 0, {})
      expect(await client.behaviorResume('run-1', 0, { thrown: false })).toEqual({
        kind: 'yield',
        command: { type: 'query', op: 'position', args: {} },
      })
      await expect(client.behaviorResume('run-1', 1, { thrown: false }))
        .rejects.toMatchObject({ code: 'STALE_BEHAVIOR' })
      expect(await client.behaviorResume('run-1', 0, { value: { value: { x: 7 }, meta: {} }, thrown: false }))
        .toEqual({ kind: 'done', value: { type: 'succeed', evidence: { x: 7 } } })
      expect(await client.behaviorStop('run-1', 0)).toEqual({ kind: 'stopped' })
    } finally {
      client.dispose()
    }
  })
})

describe('body host with sandbox behavior driver', () => {
  it('checks and runs author code entirely in the runner process', async () => {
    const entry = fileURLToPath(new URL('../lib/runner.js', import.meta.url))
    const client = new RunnerClient({ entry, onOp: () => {} })
    const host = new BehaviorHost({
      bindingId: 'binding-runner',
      query: () => ({ status: 'ok', value: { x: 7 }, meta: { source: 'query', scope: 'test', sampledAt: 0 } }),
      act: { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
      behaviorRunner: client,
      loadBehaviorManifest: (code, artifactId) => client.load('behavior', artifactId, code),
    })
    const directory = mkdtempSync(join(tmpdir(), 'p2-runner-behavior-'))
    const path = join(directory, 'behavior.mjs')
    writeFileSync(path, `
      defineBehavior({
        manifest: { id: 'runner-behavior', mode: 'finite', parameters: {} },
        *run(ctx) {
          const pos = yield ctx.query('position', {})
          return ctx.succeed({ x: pos.value.x })
        },
      })
    `)
    try {
      const checked = await host.check({ sourcePath: path, format: 'js' })
      host.activate(checked.artifactId)
      host.switch({ artifactId: checked.artifactId, params: {}, commandId: 'runner-switch' })
      for (let index = 0; index < 50 && host.status().lastRun === null; index += 1) {
        host.tick(index)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const status = host.status()
      expect(status.lastRun).toMatchObject({ status: 'succeeded', evidence: { x: 7 } })
    } finally {
      host.dispose()
      client.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
