import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkAct, forbiddenToken } from '../src/core/act-checker.ts'
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
