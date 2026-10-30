import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkPolicy } from '../src/core/policy-checker.ts'
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
