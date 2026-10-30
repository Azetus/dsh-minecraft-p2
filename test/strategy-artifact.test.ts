/**
 * Strategy artifact contract: check, load, evaluate, adapt (M4 wiring).
 *
 * Category: cross-module contract. Protects the strategy manifest/verdict
 * shapes, the "pure JSON in/out" boundary and the mapping onto controller
 * identity (act resolution, checkpoint, evidence).
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkStrategyJs } from '../src/core/strategy-checker.ts'
import { StrategyRuntime } from '../src/core/strategy-runtime.ts'
import { createArtifactStrategy } from '../src/controller/artifact-strategy.ts'
import type { StrategyArtifact } from '../src/contracts/ir.ts'
import type { FactSet } from '../src/controller/observation.ts'
import type { StrategyContext } from '../src/controller/strategy.ts'
import { ActionMemory } from '../src/controller/memory.ts'

const SOURCE = `
defineStrategy({
  manifest: { id: 'idle-strategy', version: '1', slot: 'S2', facts: ['inventory'] },
  evaluate(ctx) {
    return { kind: 'idle' }
  },
})
`

async function writeStrategy(name: string, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'p2-strategy-'))
  const path = join(directory, name)
  await writeFile(path, source, 'utf8')
  return path
}

const RESOLVE_DIG = (): { artifactId: string; digest: string } => ({ artifactId: 'act-dig-1', digest: 'd'.repeat(64) })

describe('strategy artifact checker', () => {
  it('checks a valid strategy and resolves act dependencies', async () => {
    const path = await writeStrategy('idle.strategy.js', SOURCE.replace("facts: ['inventory']", "facts: ['inventory'], acts: ['dig']"))
    const result = await checkStrategyJs({ sourcePath: path, bindingId: 'binding-1', resolveAct: RESOLVE_DIG })
    expect(result.artifact).toMatchObject({
      kind: 'strategy',
      definitionId: 'idle-strategy',
      version: '1',
      slot: 'S2',
      facts: ['inventory'],
      acts: ['dig'],
      resolvedActs: { dig: 'act-dig-1' },
    })
    expect(result.artifact.manifest.dependencies).toEqual([{ kind: 'act', id: 'act-dig-1', digest: 'd'.repeat(64) }])
    expect(result.credential).toMatchObject({ bindingId: 'binding-1', network: false })
  })

  it('rejects S0 without a hazard class and missing act dependencies', async () => {
    const s0 = await writeStrategy('s0.strategy.js', SOURCE.replace("slot: 'S2'", "slot: 'S0'"))
    await expect(checkStrategyJs({ sourcePath: s0, bindingId: 'b' })).rejects.toMatchObject({
      code: 'INVALID_STRATEGY_MANIFEST',
    })

    const withAct = await writeStrategy('act.strategy.js', SOURCE.replace("facts: ['inventory']", "facts: ['inventory'], acts: ['missing']"))
    await expect(checkStrategyJs({ sourcePath: withAct, bindingId: 'b' })).rejects.toMatchObject({
      code: 'DEPENDENCY_NOT_FOUND',
    })
  })

  it('rejects forbidden syntax and async evaluation', async () => {
    const forbidden = await writeStrategy('bad.strategy.js', SOURCE.replace('return { kind: \'idle\' }', 'return { kind: eval("1") }'))
    await expect(checkStrategyJs({ sourcePath: forbidden, bindingId: 'b' })).rejects.toMatchObject({
      code: 'FORBIDDEN_SYNTAX',
    })

    const asyncSource = `
      defineStrategy({
        manifest: { id: 'async', version: '1', slot: 'S2', facts: [] },
        async evaluate() { return { kind: 'idle' } },
      })
    `
    const asyncPath = await writeStrategy('async.strategy.js', asyncSource)
    await expect(checkStrategyJs({ sourcePath: asyncPath, bindingId: 'b' })).rejects.toMatchObject({
      code: 'INVALID_STRATEGY_MANIFEST',
    })
  })
})

describe('strategy runtime and adapter', () => {
  it('evaluates strategy code with JSON input and no host handles', async () => {
    const path = await writeStrategy('idle.strategy.js', SOURCE)
    const checked = await checkStrategyJs({ sourcePath: path, bindingId: 'b' })
    const runtime = new StrategyRuntime()
    const loaded = runtime.load(checked.artifact)
    expect(loaded.evaluate({ now: 1 })).toEqual({ kind: 'idle' })
  })

  it('fails closed on a timeout or an async verdict', async () => {
    const loop = await writeStrategy('loop.strategy.js', `
      defineStrategy({
        manifest: { id: 'loop', version: '1', slot: 'S2', facts: [] },
        evaluate(ctx) { void ctx; while (true) {} },
      })
    `)
    const loopArtifact = (await checkStrategyJs({ sourcePath: loop, bindingId: 'b' })).artifact
    const runtime = new StrategyRuntime({ timeoutMs: 20 })
    const loaded = runtime.load(loopArtifact)
    expect(() => loaded.evaluate({ now: 1 })).toThrowError(/timed out/u)

    const asyncRuntime = new StrategyRuntime()
    const asyncArtifact = {
      ...loopArtifact,
      code: `
        defineStrategy({
          manifest: { id: 'promise', version: '1', slot: 'S2', facts: [] },
          evaluate() { return Promise.resolve({ kind: 'idle' }) },
        })
      `,
    }
    expect(() => asyncRuntime.load(asyncArtifact).evaluate({ now: 1 })).toThrowError(/synchronous/u)
  })

  it('maps verdicts onto controller identity, checkpoint and evidence', async () => {
    const artifact: StrategyArtifact = {
      kind: 'strategy',
      definitionId: 'adapter',
      version: '1',
      slot: 'S2',
      facts: ['inventory'],
      acts: ['dig'],
      resolvedActs: { dig: 'act-dig-9' },
      code: '',
      manifest: {
        schemaVersion: 1,
        kind: 'strategy',
        definitionId: 'adapter',
        sourceDigest: 's',
        irVersion: 0,
        irDigest: null,
        codeDigest: null,
        buildToolVersion: 'test',
        bindingId: 'b',
        dependencies: [],
      },
      artifactId: 'strategy-adapter',
      artifactDigest: 'a',
      bindingId: 'b',
      sourceDigest: 's',
    }
    const saved: unknown[] = []
    const requests: unknown[] = []
    const factSet: FactSet = {
      values: { inventory: [{ name: 'stone', count: 2 }] },
      facts: {
        inventory: {
          key: 'inventory',
          value: [{ name: 'stone', count: 2 }],
          known: true,
          sampledAt: 10,
          validUntil: 1000,
          scope: 'body',
          evidenceId: 'ev-1',
        },
      },
      known: ['inventory'],
      unknown: [],
      reasons: {},
      coherent: true,
      coherenceGapMs: 0,
    }
    const context: StrategyContext = {
      now: 100,
      slot: 'S2',
      phase: 'normal',
      attemptId: 'attempt-1',
      facts: () => factSet,
      memory: new ActionMemory({ now: () => 100 }),
      request: (intent, act, args = {}) => {
        const request = { act, args, intent, slot: 'S2' as const, holder: 'S2:adapter', attemptId: 'attempt-1' }
        requests.push(request)
        return request
      },
      propose: () => ({ kind: 'idle' }),
      diagnostic: (code, message, detail) => ({ code, message, at: 100, ...(detail === undefined ? {} : { detail }) }),
      saveCheckpoint: patch => { saved.push(patch) },
      evidence: key => ({
        factKey: key,
        evidenceId: 'ev-1',
        sampledAt: 10,
        validUntil: 1000,
        scope: 'body',
        value: factSet.values[key] ?? null,
      }),
    }

    const propose = createArtifactStrategy({
      artifact,
      evaluate: () => ({ kind: 'propose', intent: 'dig:1,2,3', act: 'dig', args: { x: 1 }, checkpoint: { target: 'a' } }),
    }).evaluate(context)
    expect(propose).toMatchObject({ kind: 'propose', intent: 'dig:1,2,3' })
    expect(requests[0]).toMatchObject({ act: 'act-dig-9', intent: 'dig:1,2,3' })
    expect(saved).toEqual([{ target: 'a' }])

    const complete = createArtifactStrategy({
      artifact,
      evaluate: () => ({ kind: 'candidate-complete', evidence: ['inventory'] }),
    }).evaluate(context)
    expect(complete).toMatchObject({
      kind: 'candidate-complete',
      evidence: [{ factKey: 'inventory', evidenceId: 'ev-1' }],
    })

    const undeclared = createArtifactStrategy({
      artifact,
      evaluate: () => ({ kind: 'propose', intent: 'dig', act: 'explode' }),
    }).evaluate(context)
    expect(undeclared).toMatchObject({ kind: 'blocked' })
    expect(undeclared.kind === 'blocked' ? undeclared.diagnostics[0]?.code : undefined).toBe('ACT_UNDECLARED')
  })
})

