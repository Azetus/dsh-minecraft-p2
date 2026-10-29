import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BehaviorArtifact } from '../src/contracts/ir.ts'
import type { JsonValue } from '../src/contracts/types.ts'
import { checkBehaviorJs } from '../src/core/js-checker.ts'
import { JsBehaviorRun } from '../src/core/js-runtime.ts'
import type { ActHandle, ActPoll, ActPort, PolicyPort, QueryOutcome, QueryPort, ReleaseStatus } from '../src/core/node-runtime.ts'

// 类别：状态安全
// 保护对象：RUNTIME §3（每轮 step 预算与推进顺序）、§4（yield/return 语义与单步超时）、
//           §4.1（取消）；BEHAVIOR §1.1 E2/E3；CONTRACTS §3（ctx 命令与终态）。
// 失败模式：同步完成或错误路径递归推进导致栈溢出或绕过预算；作者代码入口（初始化、
//          单步、return() 的 finally）无超时；非法 yield/return 被静默跳过或误判为终态。

const CODE = `
defineBehavior({
  manifest: { id: 'js-smoke', mode: 'finite', parameters: { x: { type: 'number', required: true } }, dependencies: { acts: ['move-to'] } },
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
    const result = await checkBehaviorJs({
      sourcePath: path,
      bindingId: 'binding-1',
      resolveDependency: (kind, definitionId) => ({
        artifactId: `p2:${kind}:${definitionId}`,
        digest: `digest-${kind}-${definitionId}`,
      }),
    })
    return result.artifact
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function behavior(body: string, dependencies?: Record<string, string[]>): string {
  return `defineBehavior({
    manifest: { id: 'js-test', mode: 'continuous', parameters: {}${dependencies === undefined ? '' : `, dependencies: ${JSON.stringify(dependencies)}`} },
    *run(ctx) { ${body} },
  })`
}

function rawArtifact(code: string, id = 'js-raw'): BehaviorArtifact {
  return {
    kind: 'behavior',
    format: 'js',
    code,
    definition: {
      id,
      description: id,
      mode: 'continuous',
      parameters: {},
      locals: {},
      root: { kind: 'fail', id: 'raw', code: 'RAW', message: 'raw artifact' },
    },
    manifest: {
      schemaVersion: 1,
      kind: 'behavior',
      definitionId: id,
      sourceDigest: 'source',
      irVersion: 0,
      irDigest: null,
      codeDigest: null,
      buildToolVersion: 'test',
      bindingId: 'binding-1',
      dependencies: [],
    },
    artifactId: `p2:behavior:${id}`,
    artifactDigest: `digest-${id}`,
    bindingId: 'binding-1',
    sourceDigest: 'source',
  }
}

type RunOptions = {
  query?: QueryPort
  act?: ActPort
  policy?: PolicyPort
  allowedActs?: ReadonlySet<string>
  allowedPolicies?: ReadonlySet<string>
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
    ...(options.allowedActs === undefined ? {} : { allowedActs: options.allowedActs }),
    ...(options.allowedPolicies === undefined ? {} : { allowedPolicies: options.allowedPolicies }),
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
    expect(artifact.resolvedDependencies?.acts['move-to']).toBe('p2:act:move-to')
    expect(artifact.manifest.dependencies).toEqual([
      { kind: 'act', id: 'p2:act:move-to', digest: 'digest-act-move-to' },
    ])
  })

  it('rejects non-generators, async functions and timers with positions', async () => {
    await expect(checked("defineBehavior({ manifest: { id: 'bad', mode: 'continuous', parameters: {} }, run(ctx) {} })"))
      .rejects.toThrow(/synchronous generator/u)
    await expect(checked("defineBehavior({ manifest: { id: 'bad', mode: 'continuous', parameters: {} }, async *run(ctx) {} })"))
      .rejects.toThrow(/must not use async/u)
    await expect(checked("defineBehavior({ manifest: { id: 'bad', mode: 'continuous', parameters: {} }, *run(ctx) { setTimeout(() => {}, 1) } })"))
      .rejects.toThrow(/line \d+, column \d+: JS behavior must not use timer/u)
  })

  it('rejects a declared dependency that is not available in the binding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'p2-js-behavior-'))
    const path = join(directory, 'behavior.mjs')
    writeFileSync(path, behavior('return ctx.succeed({})', { acts: ['missing'] }))
    try {
      await expect(checkBehaviorJs({ sourcePath: path, bindingId: 'binding-1' }))
        .rejects.toThrow(/DEPENDENCY_NOT_FOUND|missing/u)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects an act that is not in the declared dependency set at run time', async () => {
    const artifact = await checked(behavior('yield ctx.act("move", {})', { acts: ['move'] }))
    const run = makeRun(artifact, {
      allowedActs: new Set(),
      resolveAct: () => 'p2:act:other',
    })
    expect(run.tick(0)).toBe('failed')
    expect(run.error?.code).toBe('DEPENDENCY_NOT_DECLARED')
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
    const artifact = await checked(behavior('while (true) { yield ctx.decide("pick", {}) }', { policies: ['pick'] }))
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
    const artifact = await checked(behavior('while (true) { try { yield ctx.act("missing", {}) } catch {} }', { acts: ['missing'] }))
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

  it('bounds a non-generator run() body during initialization', () => {
    const artifact = rawArtifact(`
      defineBehavior({
        manifest: { id: 'js-init-loop', mode: 'continuous', parameters: {} },
        run(ctx) { for (;;) {} },
      })
    `, 'js-init-loop')
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

describe('stop revocation and release', () => {
  it('stops the act, keeps the run non-terminal until release, and never resumes the generator', async () => {
    const artifact = await checked(behavior('while (true) { yield ctx.act("move", { x: 1, z: 2 }) }', { acts: ['move'] }))
    let release: ReleaseStatus = 'stopping'
    let stops = 0
    let releaseRequests = 0
    const identities: Array<Record<string, unknown>> = []
    const run = makeRun(artifact, {
      act: {
        start: (_ref, _args, identity) => {
          identities.push(identity as unknown as Record<string, unknown>)
          return { poll: () => ({ status: 'running' }), stop: () => { stops += 1 } }
        },
        stopRun: () => { releaseRequests += 1 },
        pollRelease: () => release,
      },
      resolveAct: () => 'p2:act:move',
    })
    expect(run.tick(0)).toBe('running')
    expect(identities[0]).toMatchObject({ runId: 'run-1', generation: 0 })

    run.stop(100)
    expect(stops).toBe(1)
    expect(releaseRequests).toBe(1)
    expect(run.status).toBe('running')
    expect(run.stopState).toBe('stopping')
    expect(run.tick(200)).toBe('running')
    expect(identities).toHaveLength(1)

    release = 'released'
    expect(run.tick(300)).toBe('cancelled')
    expect(run.allowsTakeover).toBe(true)
  })
})

describe('observation and bounded payloads', () => {
  it('reports currentStep, stepCount, progress and success evidence', async () => {
    const artifact = await checked(behavior(`
      yield ctx.progress({ phase: 'mine' })
      yield ctx.query('position', {})
      yield ctx.act('move-to', { x: 1, z: 2 })
      return ctx.succeed({ mined: 3 })
    `, { acts: ['move-to'] }))
    const act = fakeAct()
    const run = makeRun(artifact, {
      act: { start: () => act.handle },
      resolveAct: () => 'p2:act:move',
    })
    expect(run.tick(0)).toBe('running')
    expect(run.observation()).toMatchObject({
      currentStep: { kind: 'act', ref: 'move-to', op: null, summary: 'act:move-to' },
      stepCount: 3,
      progress: { phase: 'mine' },
      cleanupState: 'none',
      controlHealth: 'ok',
      switchState: 'none',
      logDropped: 0,
    })
    expect(run.tick(1)).toBe('running')
    expect(run.tick(2)).toBe('succeeded')
    const observation = run.observation()
    expect(observation.currentStep).toBeNull()
    expect(observation.evidence).toEqual({ mined: 3 })
    expect(observation.lastError).toBeNull()
  })

  it('rejects oversized or non-serializable progress and evidence', async () => {
    const big = await checked(behavior("yield ctx.progress({ pad: 'x'.repeat(5000) })"))
    const bigRun = makeRun(big)
    expect(bigRun.tick(0)).toBe('failed')
    expect(bigRun.error?.code).toBe('BEHAVIOR_VALUE_TOO_LARGE')

    const cyclic = await checked(behavior('yield ctx.progress(10n)'))
    const cyclicRun = makeRun(cyclic)
    expect(cyclicRun.tick(0)).toBe('failed')
    expect(cyclicRun.error?.code).toBe('BEHAVIOR_VALUE_INVALID')

    const evidence = await checked(behavior("return ctx.succeed({ pad: 'x'.repeat(20000) })"))
    const evidenceRun = makeRun(evidence)
    expect(evidenceRun.tick(0)).toBe('failed')
    expect(evidenceRun.error?.code).toBe('BEHAVIOR_VALUE_TOO_LARGE')
  })

  it('keeps logs in a bounded ring buffer with a dropped counter', async () => {
    const artifact = await checked(behavior("while (true) { yield ctx.log('x'.repeat(4000)) }"))
    const run = makeRun(artifact)
    expect(run.tick(0)).toBe('running')
    const observation = run.observation()
    expect(observation.logCount).toBeLessThanOrEqual(66)
    expect(observation.logDropped).toBeGreaterThan(0)
    expect(observation.currentStep).toMatchObject({ kind: 'log' })
  })
})

describe('runner exit and release proof', () => {
  async function activeRun(releaseState: () => ReleaseStatus): Promise<JsBehaviorRun> {
    const artifact = await checked(behavior('while (true) { yield ctx.act("move", {}) }', { acts: ['move'] }))
    return makeRun(artifact, {
      act: {
        start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }),
        stopRun: () => {},
        pollRelease: releaseState,
      },
      resolveAct: () => 'p2:act:move',
    })
  }

  it('does not take over when a runner crash leaves release unconfirmed', async () => {
    let release: ReleaseStatus = 'unconfirmed'
    const run = await activeRun(() => release)
    expect(run.tick(0)).toBe('running')
    run.runnerExited('runner crashed')
    expect(run.status).toBe('running')
    expect(run.stopState).toBe('stop-unconfirmed')
    expect(run.allowsTakeover).toBe(false)

    release = 'released'
    expect(run.tick(1)).toBe('failed')
    expect(run.error?.code).toBe('RUNNER_EXITED')
    expect(run.allowsTakeover).toBe(true)
  })

  it('fails without blocking takeover when release is confirmed', async () => {
    const run = await activeRun(() => 'released')
    expect(run.tick(0)).toBe('running')
    run.runnerExited('runner crashed')
    expect(run.status).toBe('failed')
    expect(run.error?.code).toBe('RUNNER_EXITED')
    expect(run.allowsTakeover).toBe(true)
  })
})

// 类别：状态安全
// 保护对象：CONTRACTS §4.2（act 句柄：单控制、ACT_IN_FLIGHT、ACT_NOT_FOUND、收尾确认）、
//           BEHAVIOR §3（ctx.act/actWait/actStop 与 status 摘要）、RUNTIME §5（run 终态前释放）。
// 失败模式：多个控制 act 并存；旧句柄在 run 成功后仍生效；停止未确认仍启动新 act；
//           已终态句柄重复等待被误判为仍在运行。

type FakeHandleState = {
  running: boolean
  result: JsonValue | undefined
  stops: number
  stubborn: boolean
}

function controllableAct(options: {
  stubborn?: boolean
  release?: () => ReleaseStatus
} = {}): { port: ActPort; handles: FakeHandleState[]; starts: Array<Record<string, unknown>> } {
  const handles: FakeHandleState[] = []
  const starts: Array<Record<string, unknown>> = []
  return {
    handles,
    starts,
    port: {
      start: (_ref, _args, identity) => {
        starts.push(identity as unknown as Record<string, unknown>)
        const state: FakeHandleState = {
          running: true,
          result: undefined,
          stops: 0,
          stubborn: options.stubborn === true,
        }
        handles.push(state)
        return {
          poll: (): ActPoll => {
            if (state.running) return { status: 'running' }
            if (state.result !== undefined) return { status: 'succeeded', result: state.result }
            return { status: 'cancelled' }
          },
          stop: () => {
            state.stops += 1
            if (!state.stubborn) state.running = false
          },
        }
      },
      stopRun: () => {},
      ...(options.release === undefined ? {} : { pollRelease: options.release }),
    },
  }
}

describe('async act handles', () => {
  it('starts an act asynchronously and resumes it through actWait', async () => {
    const artifact = await checked(behavior(`
      const handle = yield ctx.act('move', { x: 2, z: 3 }, { async: true })
      const out = yield ctx.actWait(handle.actId)
      return ctx.succeed({ out })
    `, { acts: ['move'] }))
    const fake = controllableAct()
    const run = makeRun(artifact, { act: fake.port, resolveAct: id => `p2:act:${id}` })

    expect(run.tick(0)).toBe('running')
    expect(fake.handles).toHaveLength(1)
    expect(fake.starts[0]).toMatchObject({ runId: 'run-1', generation: 0 })
    expect(fake.starts[0]?.actInstanceId).toMatch(/^run-1:act:/u)
    expect(fake.handles[0]!.stops).toBe(0)

    fake.handles[0]!.running = false
    fake.handles[0]!.result = { done: true }
    expect(run.tick(1)).toBe('succeeded')
    expect(run.observation().evidence).toEqual({ out: { done: true } })
  })

  it('stops an in-flight handle and resumes actStop with the release conclusion', async () => {
    const artifact = await checked(behavior(`
      const handle = yield ctx.act('move', {}, { async: true })
      const stopped = yield ctx.actStop(handle.actId)
      return ctx.succeed({ stopped })
    `, { acts: ['move'] }))
    const fake = controllableAct({ release: () => 'released' })
    const run = makeRun(artifact, { act: fake.port, resolveAct: id => `p2:act:${id}` })

    expect(run.tick(0)).toBe('running')
    expect(fake.handles[0]!.stops).toBe(1)
    expect(run.tick(1)).toBe('succeeded')
    expect(run.observation().evidence).toEqual({ stopped: { release: 'released' } })
  })

  it('refuses a second control act and stops the first before a success terminal', async () => {
    const artifact = await checked(behavior(`
      const first = yield ctx.act('move', {}, { async: true })
      try {
        yield ctx.act('dig', {}, { async: true })
      } catch (error) {
        return ctx.succeed({ code: error.code, first: first.actId })
      }
    `, { acts: ['move', 'dig'] }))
    const fake = controllableAct()
    const run = makeRun(artifact, { act: fake.port, resolveAct: id => `p2:act:${id}` })

    expect(run.tick(0)).toBe('running')
    expect(run.status).toBe('running')
    expect(fake.handles).toHaveLength(1)
    expect(fake.handles[0]!.stops).toBe(1)
    expect(run.tick(1)).toBe('succeeded')
    expect(run.observation().evidence).toMatchObject({ code: 'ACT_IN_FLIGHT' })
  })

  it('stops an unfinished handle before reporting success', async () => {
    const artifact = await checked(behavior(`
      yield ctx.act('move', {}, { async: true })
      return ctx.succeed({ ok: true })
    `, { acts: ['move'] }))
    const fake = controllableAct()
    const run = makeRun(artifact, { act: fake.port, resolveAct: id => `p2:act:${id}` })

    expect(run.tick(0)).toBe('running')
    expect(fake.handles[0]!.stops).toBe(1)
    expect(run.tick(1)).toBe('succeeded')
    expect(run.observation().evidence).toEqual({ ok: true })
  })

  it('blocks new control acts after an unconfirmed stop and never reports success', async () => {
    const artifact = await checked(behavior(`
      const handle = yield ctx.act('move', {}, { async: true })
      const stopped = yield ctx.actStop(handle.actId)
      yield ctx.progress({ release: stopped.release })
      try {
        yield ctx.act('dig', {}, { async: true })
      } catch (error) {
        return ctx.succeed({ code: error.code })
      }
    `, { acts: ['move', 'dig'] }))
    const fake = controllableAct({ release: () => 'unconfirmed' })
    const run = makeRun(artifact, { act: fake.port, resolveAct: id => `p2:act:${id}` })

    expect(run.tick(0)).toBe('running')
    expect(run.tick(1)).toBe('failed')
    expect(run.error?.code).toBe('STOP_UNCONFIRMED')
    expect(run.observation().progress).toEqual({ release: 'unconfirmed' })
    expect(fake.handles).toHaveLength(1)
  })

  it('rejects actWait for a handle the run does not own', async () => {
    const artifact = await checked(behavior(`
      try { yield ctx.actWait('missing') } catch (error) { return ctx.succeed({ code: error.code }) }
    `))
    const run = makeRun(artifact)
    expect(run.tick(0)).toBe('succeeded')
    expect(run.observation().evidence).toEqual({ code: 'ACT_NOT_FOUND' })
  })

  it('exposes the active handle summary in the observation', async () => {
    const artifact = await checked(behavior(`
      const handle = yield ctx.act('move', {}, { async: true })
      yield ctx.wait(1000)
      return ctx.succeed({ id: handle.actId })
    `, { acts: ['move'] }))
    const fake = controllableAct()
    const run = makeRun(artifact, { act: fake.port, resolveAct: id => `p2:act:${id}` })

    expect(run.tick(0)).toBe('running')
    const summary = run.observation().activeActHandle
    expect(summary).toMatchObject({ definitionId: 'move', artifactId: 'p2:act:move', state: 'running' })
    expect(summary?.actId).toMatch(/^run-1:act:/u)
    run.stop(1)
  })
})
