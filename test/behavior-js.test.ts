import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BehaviorArtifact } from '../src/contracts/ir.ts'
import { checkBehaviorJs } from '../src/core/js-checker.ts'
import { JsBehaviorRun } from '../src/core/js-runtime.ts'
import type { ActHandle, ActPoll, ActPort, PolicyPort, QueryOutcome, QueryPort } from '../src/core/node-runtime.ts'

// 类别：状态安全
// 保护对象：RUNTIME §3（每轮 step 预算与推进顺序）、§4（yield/return 语义与单步超时）、
//           §4.1（取消）；BEHAVIOR §1.1 E2/E3；CONTRACTS §3（ctx 命令与终态）。
// 失败模式：同步完成或错误路径递归推进导致栈溢出或绕过预算；作者代码入口（初始化、
//          单步、return() 的 finally）无超时；非法 yield/return 被静默跳过或误判为终态。

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

const SYNC_QUERY: QueryPort = () => ({
  status: 'ok',
  value: null,
  meta: { source: 'query', scope: 'test', sampledAt: 0 },
})

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

function behavior(body: string): string {
  return `defineBehavior({
    manifest: { id: 'js-test', mode: 'continuous', parameters: {} },
    *run(ctx) { ${body} },
  })`
}

type RunOptions = {
  query?: QueryPort
  act?: ActPort
  policy?: PolicyPort
  resolveAct?: (definitionId: string) => string | undefined
  resolvePolicy?: (definitionId: string) => string | undefined
}

function makeRun(artifact: BehaviorArtifact, options: RunOptions = {}): JsBehaviorRun {
  return new JsBehaviorRun({
    runId: 'run-1',
    owner: 'owner',
    artifact,
    params: {},
    query: options.query ?? SYNC_QUERY,
    act: options.act ?? { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) },
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    resolveAct: options.resolveAct ?? (() => undefined),
    resolvePolicy: options.resolvePolicy ?? (() => undefined),
  })
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

describe('non-recursive step budget', () => {
  it('counts synchronous query completions as steps instead of recursing', async () => {
    const artifact = await checked(behavior('while (true) { yield ctx.query("position", {}) }'))
    let calls = 0
    const run = makeRun(artifact, {
      query: () => {
        calls += 1
        return { status: 'ok', value: null, meta: { source: 'query', scope: 'test', sampledAt: 0 } }
      },
    })
    expect(run.tick(0)).toBe('running')
    expect(calls).toBe(100)
    expect(run.tick(1)).toBe('running')
    expect(calls).toBe(200)
  })

  it('counts synchronous policy completions as steps instead of recursing', async () => {
    const artifact = await checked(behavior('while (true) { yield ctx.decide("pick", {}) }'))
    let calls = 0
    const run = makeRun(artifact, {
      policy: {
        call: () => {
          calls += 1
          return { status: 'ok', value: null }
        },
      },
      resolvePolicy: () => 'p2:policy:pick',
    })
    expect(run.tick(0)).toBe('running')
    expect(calls).toBe(100)
  })

  it('turns a synchronous act reference failure into a thrown slot, not recursion', async () => {
    const artifact = await checked(behavior('while (true) { try { yield ctx.act("missing", {}) } catch {} }'))
    let resolutions = 0
    const run = makeRun(artifact, {
      resolveAct: () => {
        resolutions += 1
        return undefined
      },
    })
    expect(run.tick(0)).toBe('running')
    expect(resolutions).toBe(100)
  })

  it('routes progress through the resume slot and shares the same budget', async () => {
    const artifact = await checked(behavior('while (true) { yield ctx.progress({ n: 1 }); yield ctx.query("position", {}) }'))
    let queries = 0
    const run = makeRun(artifact, {
      query: () => {
        queries += 1
        return { status: 'ok', value: null, meta: { source: 'query', scope: 'test', sampledAt: 0 } }
      },
    })
    expect(run.tick(0)).toBe('running')
    expect(queries).toBe(50)
  })
})

describe('author-code timeouts', () => {
  it('fails a step that never yields with BEHAVIOR_STEP_TIMEOUT', async () => {
    const artifact = await checked(behavior('for (;;) {}'))
    const run = makeRun(artifact)
    const started = Date.now()
    expect(run.tick(0)).toBe('failed')
    expect(run.error?.code).toBe('BEHAVIOR_STEP_TIMEOUT')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('bounds a non-generator run() body during initialization', async () => {
    const artifact = await checked(`
      defineBehavior({
        manifest: { id: 'js-init-loop', mode: 'continuous', parameters: {} },
        run(ctx) { for (;;) {} },
      })
    `)
    const started = Date.now()
    const run = makeRun(artifact)
    expect(run.status).toBe('failed')
    expect(run.error?.code).toBe('BEHAVIOR_STEP_TIMEOUT')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('bounds generator.return() cleanup and still reports cancelled', async () => {
    const artifact = await checked(behavior('try { for (;;) { yield ctx.wait(60000) } } finally { for (;;) {} }'))
    const run = makeRun(artifact)
    expect(run.tick(0)).toBe('running')
    const started = Date.now()
    run.stop()
    expect(run.status).toBe('cancelled')
    expect(run.error?.code).toBe('BEHAVIOR_STEP_TIMEOUT')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('yield and return shapes', () => {
  const INVALID_YIELDS: Array<[string, string]> = [
    ['bare yield', 'yield'],
    ['non-object yield', 'yield 42'],
    ['unknown command type', 'yield { type: "bogus" }'],
    ['query without op', 'yield { type: "query", args: {} }'],
    ['query without args', 'yield { type: "query", op: "position" }'],
    ['wait without a number', 'yield { type: "wait", durationMs: "soon" }'],
    ['progress without the command shape', 'yield { type: "progress" }'],
    ['succeed yielded instead of returned', 'yield ctx.succeed({})'],
    ['fail yielded instead of returned', 'yield ctx.fail("NOPE", "nope")'],
  ]

  it.each(INVALID_YIELDS)('rejects %s with BEHAVIOR_INVALID_COMMAND', async (_label, body) => {
    const artifact = await checked(behavior(body))
    const run = makeRun(artifact)
    expect(run.tick(0)).toBe('failed')
    expect(run.error?.code).toBe('BEHAVIOR_INVALID_COMMAND')
  })

  const INVALID_RETURNS: Array<[string, string]> = [
    ['natural return', 'return'],
    ['non-command return', 'return 1'],
    ['command returned instead of yielded', 'return ctx.query("position", {})'],
    ['function returned', 'return ctx.succeed'],
  ]

  it.each(INVALID_RETURNS)('rejects %s with BEHAVIOR_INVALID_RETURN', async (_label, body) => {
    const artifact = await checked(behavior(body))
    const run = makeRun(artifact)
    expect(run.tick(0)).toBe('failed')
    expect(run.error?.code).toBe('BEHAVIOR_INVALID_RETURN')
  })
})
