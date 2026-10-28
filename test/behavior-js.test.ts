import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BehaviorArtifact } from '../src/contracts/ir.ts'
import { checkBehaviorJs } from '../src/core/js-checker.ts'
import { JsBehaviorRun } from '../src/core/js-runtime.ts'
import type { ActHandle, ActPoll, QueryOutcome } from '../src/core/node-runtime.ts'

const CODE = `
defineBehavior({
  manifest: { id: 'js-smoke', mode: 'finite', parameters: { x: { type: 'number', required: true } } },
  *run(ctx) {
    const pos = yield ctx.query('position', {})
    yield ctx.act('move-to', { x: ctx.params.x, z: pos.value.z })
    return ctx.succeed({ done: true })
  },
})
`

async function checked(code: string): Promise<BehaviorArtifact> {
  const directory = mkdtempSync(join(tmpdir(), 'p2-js-behavior-'))
  const path = join(directory, 'behavior.mjs')
  writeFileSync(path, code)
  try {
    const result = await checkBehaviorJs({ sourcePath: path, bindingId: 'binding-1' })
    return result.artifact
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function fakeAct(): { started: Array<Record<string, unknown>>; handle: ActHandle } {
  const started: Array<Record<string, unknown>> = []
  let polls = 0
  const handle: ActHandle = {
    poll: (): ActPoll => {
      polls += 1
      return polls < 2 ? { status: 'running' } : { status: 'succeeded', result: { ok: true } }
    },
    stop: () => {},
  }
  return {
    started,
    handle,
  }
}

describe('JS behavior check and run', () => {
  it('checks a defineBehavior module and builds a behavior artifact', async () => {
    const artifact = await checked(CODE)
    expect(artifact.kind).toBe('behavior')
    expect(artifact.format).toBe('js')
    expect(artifact.definition.id).toBe('js-smoke')
    expect(artifact.definition.mode).toBe('finite')
    expect(artifact.code).toContain('defineBehavior')
  })

  it('rejects forbidden host access', async () => {
    await expect(checked("defineBehavior({ manifest: { id: 'bad', mode: 'continuous', parameters: {} }, *run(ctx) { return process.exit(1) } })"))
      .rejects.toThrow(/must not use process/u)
  })

  it('runs a generator through query and act ports', async () => {
    const artifact = await checked(CODE)
    const started: string[] = []
    const act = fakeAct()
    const run = new JsBehaviorRun({
      runId: 'run-1',
      owner: 'owner',
      artifact,
      params: { x: 4 },
      query: (): QueryOutcome => ({ status: 'ok', value: { x: 1, y: 64, z: 2 }, meta: { source: 'query', scope: 'test', sampledAt: 0 } }),
      act: {
        start: (ref, args) => {
          started.push(typeof ref === 'string' ? ref : ref.definitionId)
          void args
          return act.handle
        },
      },
      resolveAct: () => 'p2:act:move',
      resolvePolicy: () => undefined,
    })
    expect(run.tick(0)).toBe('running')
    expect(started).toEqual(['move-to'])
    expect(run.describe().activeAct).toBe('move-to')
    expect(run.tick(1)).toBe('running')
    expect(run.tick(2)).toBe('succeeded')
  })

  it('cancels a waiting generator', async () => {
    const artifact = await checked(`
      defineBehavior({
        manifest: { id: 'js-wait', mode: 'continuous', parameters: {} },
        *run() { while (true) { yield { type: 'wait', durationMs: 10000 } } },
      })
    `)
    const run = new JsBehaviorRun({
      runId: 'run-2',
      owner: 'owner',
      artifact,
      params: {},
      query: (): QueryOutcome => ({ status: 'ok', value: null }),
      act: { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
      resolveAct: () => undefined,
      resolvePolicy: () => undefined,
    })
    expect(run.tick(0), JSON.stringify(run.error)).toBe('running')
    run.stop()
    expect(run.status).toBe('cancelled')
  })
})

void (null as unknown as JsBehaviorRun)
