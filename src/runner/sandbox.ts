import vm from 'node:vm'

import type { JsonValue } from '../contracts/types.ts'
import {
  RUNNER_BEHAVIOR_STEP_TIMEOUT_MS,
  RUNNER_HOOK_TIMEOUT_MS,
  RUNNER_LOAD_TIMEOUT_MS,
  RUNNER_POLICY_TIMEOUT_MS,
} from './protocol.ts'
import type { RunnerBehaviorResult, RunnerHookResult } from './protocol.ts'

export type SandboxEmit = {
  op(kind: 'query' | 'control', name: string, args: JsonValue): number
  log(message: string): void
  now(): number
}

const BOOTSTRAP_BEHAVIOR = `
'use strict';
globalThis.__p2module = undefined;
globalThis.__p2gen = undefined;
globalThis.defineBehavior = function (m) {
  if (globalThis.__p2module !== undefined) throw new Error('defineBehavior called twice');
  globalThis.__p2module = m;
};
globalThis.__p2behaviorStart = function (paramsJson, runId) {
  if (globalThis.__p2module === undefined) throw new Error('no behavior module was defined');
  if (typeof globalThis.__p2module.run !== 'function') throw new Error('behavior has no run function');
  var params = JSON.parse(paramsJson);
  var ctx = Object.freeze({
    params: Object.freeze(params),
    runId: runId,
    now: function () { return __p2now(); },
    query: function (op, args) { return { type: 'query', op: op, args: args === undefined ? {} : args }; },
    act: function (ref, args) { return { type: 'act', ref: ref, args: args === undefined ? {} : args }; },
    decide: function (ref, inputs) { return { type: 'decide', ref: ref, inputs: inputs === undefined ? {} : inputs }; },
    wait: function (durationMs) { return { type: 'wait', durationMs: durationMs }; },
    progress: function (value) { return { type: 'progress', value: value }; },
    log: function (message) { return { type: 'log', message: String(message) }; },
    succeed: function (evidence) { return { type: 'succeed', evidence: evidence }; },
    fail: function (code, message) { return { type: 'fail', code: code, message: message }; },
    fresh: function (snapshot, maxAgeMs) {
      var meta = snapshot && snapshot.meta;
      var validUntil = meta && meta.validUntil;
      if (typeof validUntil !== 'number' || __p2now() > validUntil) throw { code: 'STALE_OBSERVATION', category: 'runtime', message: 'observation is stale', source: { module: 'runner.behavior' }, retry: 'never' };
      if (typeof maxAgeMs === 'number' && typeof meta.sampledAt === 'number' && __p2now() - meta.sampledAt > maxAgeMs) throw { code: 'STALE_OBSERVATION', category: 'runtime', message: 'observation is stale', source: { module: 'runner.behavior' }, retry: 'never' };
      return snapshot.value;
    }
  });
  globalThis.__p2gen = globalThis.__p2module.run(ctx);
  if (globalThis.__p2gen === null || typeof globalThis.__p2gen !== 'object' || typeof globalThis.__p2gen.next !== 'function') {
    throw new Error('run(ctx) must return a generator');
  }
  return 'ok';
};
globalThis.__p2behaviorStep = function (inputJson, thrown) {
  if (globalThis.__p2gen === undefined) throw new Error('behavior has not started');
  var input = inputJson === '' ? undefined : JSON.parse(inputJson);
  var result;
  try {
    result = thrown ? globalThis.__p2gen.throw(input) : globalThis.__p2gen.next(input);
  } catch (error) {
    return JSON.stringify({ kind: 'threw', error: __p2error(error) });
  }
  if (result.done) return JSON.stringify(result.value === undefined ? { kind: 'done' } : { kind: 'done', value: result.value });
  return JSON.stringify({ kind: 'yield', command: result.value });
};
globalThis.__p2behaviorStop = function () {
  if (globalThis.__p2gen === undefined) return JSON.stringify({ kind: 'stopped' });
  var result = globalThis.__p2gen.return(undefined);
  return JSON.stringify(result.done ? { kind: 'stopped' } : { kind: 'stopped', yielded: true });
};
globalThis.__p2error = function (error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return {
      code: error.code,
      category: typeof error.category === 'string' ? error.category : 'runtime',
      message: error.message,
      source: error.source !== undefined ? error.source : { module: 'runner.behavior' },
      retry: typeof error.retry === 'string' ? error.retry : 'never'
    };
  }
  return {
    code: 'BEHAVIOR_SCRIPT_ERROR',
    category: 'runtime',
    message: error instanceof Error ? error.message : String(error),
    source: { module: 'runner.behavior' },
    retry: 'never'
  };
};
globalThis.__p2behaviorInspect = function () {
  if (globalThis.__p2module === undefined) return JSON.stringify({ manifest: null, generator: false });
  return JSON.stringify({
    manifest: globalThis.__p2module.manifest === undefined ? null : globalThis.__p2module.manifest,
    generator: typeof globalThis.__p2module.run === 'function' && Object.prototype.toString.call(globalThis.__p2module.run) === '[object GeneratorFunction]'
  });
};
`

const BOOTSTRAP = (kind: 'act' | 'policy'): string => `
'use strict';
globalThis.__p2kind = ${JSON.stringify(kind)};
globalThis.__p2module = undefined;
globalThis.__p2instance = undefined;
globalThis.defineAct = function (m) {
  if (globalThis.__p2kind !== 'act') throw new Error('defineAct is not available in a policy');
  if (globalThis.__p2module !== undefined) throw new Error('defineAct called twice');
  globalThis.__p2module = m;
};
globalThis.definePolicy = function (m) {
  if (globalThis.__p2kind !== 'policy') throw new Error('definePolicy is not available in an act');
  if (globalThis.__p2module !== undefined) throw new Error('definePolicy called twice');
  globalThis.__p2module = m;
};
globalThis.__p2ctx = Object.freeze({
  query: function (name, args) { return __p2op('query', name, args); },
  control: function (name, args) { return __p2op('control', name, args); },
  now: function () { return __p2now(); },
  log: function (message) { __p2log(String(message)); }
});
globalThis.__p2dispatch = function (phase, payloadJson) {
  var mod = globalThis.__p2module;
  if (mod === undefined) throw new Error('no module was defined');
  var payload = payloadJson === '' ? undefined : JSON.parse(payloadJson);
  if (phase === 'create') {
    if (typeof mod.create !== 'function') throw new Error('act module has no create function');
    globalThis.__p2instance = mod.create(payload);
    return JSON.stringify({ kind: 'running' });
  }
  if (phase === 'run') {
    if (typeof mod.run !== 'function') throw new Error('policy module has no run function');
    return JSON.stringify({ value: mod.run(payload) });
  }
  var inst = globalThis.__p2instance;
  if (inst === undefined || inst === null) throw new Error('act instance is not created');
  var result;
  if (phase === 'start') result = inst.start(__p2ctx);
  else if (phase === 'update') result = inst.update(__p2ctx, payload);
  else if (phase === 'stop') result = inst.stop(__p2ctx, payload);
  else if (phase === 'cleanup') result = inst.cleanup ? inst.cleanup(__p2ctx, payload) : { kind: 'complete' };
  else throw new Error('unknown phase ' + phase);
  return JSON.stringify(result);
};
`

export class SandboxError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SandboxError'
    this.code = code
  }
}

/** One isolated JavaScript context holding exactly one loaded artifact. */
export class Sandbox {
  private context: vm.Context | undefined
  private kind: 'act' | 'policy' | 'behavior' | undefined
  private broken = false

  constructor(private readonly emit: SandboxEmit) {}

  load(kind: 'act' | 'policy' | 'behavior', code: string): JsonValue {
    if (this.context !== undefined) throw new SandboxError('SANDBOX_BUSY', 'sandbox already holds an artifact')
    const sandbox = {
      __p2op: (opKind: 'query' | 'control', name: unknown, args: unknown): number => {
        if (typeof name !== 'string' || name.length === 0) throw new Error('operation name must be a non-empty string')
        return this.emit.op(opKind, name, toJson(args))
      },
      __p2log: (message: unknown): void => this.emit.log(String(message)),
      __p2now: (): number => this.emit.now(),
    }
    this.context = vm.createContext(sandbox, {
      name: 'p2-runner',
      codeGeneration: { strings: false, wasm: false },
    })
    this.kind = kind
    if (kind === 'behavior') {
      this.run(BOOTSTRAP_BEHAVIOR, RUNNER_LOAD_TIMEOUT_MS, 'LOAD_FAILED')
      this.run(code, RUNNER_LOAD_TIMEOUT_MS, 'LOAD_FAILED')
      const raw = this.evaluate('__p2behaviorInspect()', RUNNER_LOAD_TIMEOUT_MS, 'LOAD_FAILED')
      const inspected = parseJson(raw, 'LOAD_FAILED') as { manifest?: JsonValue; generator?: unknown }
      if (inspected.manifest === null || typeof inspected.manifest !== 'object' || Array.isArray(inspected.manifest)) {
        throw new SandboxError('INVALID_MANIFEST', 'behavior must call defineBehavior with a manifest object')
      }
      if (inspected.generator !== true) {
        throw new SandboxError('INVALID_MANIFEST', 'behavior run(ctx) must be a synchronous generator function')
      }
      return inspected.manifest
    }
    this.run(BOOTSTRAP(kind), RUNNER_LOAD_TIMEOUT_MS, 'LOAD_FAILED')
    this.run(code, RUNNER_LOAD_TIMEOUT_MS, 'LOAD_FAILED')
    const manifest = this.evaluate('JSON.stringify(__p2module && __p2module.manifest ? __p2module.manifest : null)', RUNNER_LOAD_TIMEOUT_MS, 'LOAD_FAILED')
    const parsed = parseJson(manifest, 'LOAD_FAILED')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SandboxError('INVALID_MANIFEST', 'artifact must call defineAct/definePolicy with a manifest object')
    }
    return parsed
  }

  behaviorStart(params: JsonValue, runId: string): void {
    if (this.kind !== 'behavior') throw new SandboxError('BEHAVIOR_INVALID', 'sandbox does not hold a behavior')
    this.evaluate(
      `__p2behaviorStart(${JSON.stringify(JSON.stringify(params))}, ${JSON.stringify(runId)}); 'ok'`,
      RUNNER_BEHAVIOR_STEP_TIMEOUT_MS,
      'BEHAVIOR_START_FAILED',
    )
  }

  behaviorStep(input: { value?: JsonValue; thrown: boolean }): RunnerBehaviorResult {
    if (this.kind !== 'behavior') throw new SandboxError('BEHAVIOR_INVALID', 'sandbox does not hold a behavior')
    const valueJson = JSON.stringify(input.value)
    const raw = this.evaluate(
      `__p2behaviorStep(${JSON.stringify(valueJson === undefined ? '' : valueJson)}, ${input.thrown ? 'true' : 'false'})`,
      RUNNER_BEHAVIOR_STEP_TIMEOUT_MS,
      'BEHAVIOR_STEP_FAILED',
    )
    return parseBehaviorResult(raw)
  }

  behaviorStop(): RunnerBehaviorResult {
    if (this.kind !== 'behavior') throw new SandboxError('BEHAVIOR_INVALID', 'sandbox does not hold a behavior')
    const raw = this.evaluate('__p2behaviorStop()', RUNNER_BEHAVIOR_STEP_TIMEOUT_MS, 'BEHAVIOR_STOP_FAILED')
    return parseBehaviorResult(raw)
  }

  start(args: JsonValue): RunnerHookResult {
    this.evaluate(`__p2dispatch('create', ${JSON.stringify(JSON.stringify(args))})`, RUNNER_HOOK_TIMEOUT_MS, 'ACT_START_FAILED')
    return this.hook('start', undefined)
  }

  update(inputs: JsonValue): RunnerHookResult {
    return this.hook('update', inputs)
  }

  stop(reason: string): RunnerHookResult {
    return this.hook('stop', reason)
  }

  cleanup(inputs: JsonValue): RunnerHookResult {
    return this.hook('cleanup', inputs)
  }

  runPolicy(inputs: JsonValue): JsonValue {
    if (this.kind !== 'policy') throw new SandboxError('POLICY_INVALID', 'sandbox does not hold a policy')
    const raw = this.evaluate(
      `__p2dispatch('run', ${JSON.stringify(JSON.stringify(inputs ?? null))})`,
      RUNNER_POLICY_TIMEOUT_MS,
      'POLICY_FAILED',
    )
    const parsed = parseJson(raw, 'POLICY_RESULT_INVALID')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !('value' in parsed)) {
      throw new SandboxError('POLICY_RESULT_INVALID', 'policy returned an invalid envelope')
    }
    return (parsed as { value: JsonValue }).value
  }

  get isBroken(): boolean {
    return this.broken
  }

  private hook(phase: 'start' | 'update' | 'stop' | 'cleanup', payload: JsonValue | undefined): RunnerHookResult {
    const raw = this.evaluate(
      `__p2dispatch(${JSON.stringify(phase)}, ${JSON.stringify(payload === undefined ? '' : JSON.stringify(payload))})`,
      RUNNER_HOOK_TIMEOUT_MS,
      phase === 'update' ? 'ACT_UPDATE_FAILED' : `ACT_${phase.toUpperCase()}_FAILED`,
    )
    const parsed = parseJson(raw, 'ACT_HOOK_INVALID')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SandboxError('ACT_HOOK_INVALID', 'act hook must return a HookResult object')
    }
    const result = parsed as { kind?: unknown }
    if (result.kind === 'running') return parsed as RunnerHookResult
    if (result.kind === 'complete') return parsed as RunnerHookResult
    if (result.kind === 'failed') return parsed as RunnerHookResult
    throw new SandboxError('ACT_HOOK_INVALID', 'act hook result kind must be running, complete or failed')
  }

  private evaluate(script: string, timeout: number, code: string): string {
    if (this.context === undefined || this.broken) throw new SandboxError(code, 'sandbox is not usable')
    try {
      const value = vm.runInContext(script, this.context, { timeout, displayErrors: false })
      if (typeof value !== 'string') throw new SandboxError('ACT_HOOK_INVALID', 'sandbox returned a non-string result')
      if (value.length > 64 * 1024) throw new SandboxError('ACT_HOOK_INVALID', 'sandbox result exceeds 64KiB')
      return value
    } catch (error) {
      if (error instanceof SandboxError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/timed out|ERR_SCRIPT_EXECUTION_TIMEOUT/iu.test(message)) {
        this.broken = true
        if (code === 'LOAD_FAILED') throw new SandboxError('LOAD_TIMEOUT', `artifact exceeded ${timeout}ms`)
        if (code.startsWith('BEHAVIOR')) throw new SandboxError('BEHAVIOR_STEP_TIMEOUT', `behavior exceeded ${timeout}ms`)
        throw new SandboxError('ACT_TIMEOUT', `artifact exceeded ${timeout}ms`)
      }
      throw new SandboxError(code, message)
    }
  }

  private run(script: string, timeout: number, code: string): void {
    // The completion value of user code is not meaningful; force a known result.
    this.evaluate(`${script}\n;'ok'`, timeout, code)
  }
}

function parseJson(raw: string, code: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    throw new SandboxError(code, 'artifact returned invalid JSON')
  }
}

function parseBehaviorResult(raw: string): RunnerBehaviorResult {
  const parsed = parseJson(raw, 'BEHAVIOR_RESULT_INVALID')
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SandboxError('BEHAVIOR_RESULT_INVALID', 'behavior returned an invalid envelope')
  }
  const record = parsed as { kind?: unknown }
  if (record.kind !== 'yield' && record.kind !== 'done' && record.kind !== 'threw' && record.kind !== 'stopped') {
    throw new SandboxError('BEHAVIOR_RESULT_INVALID', 'behavior result kind is invalid')
  }
  return parsed as RunnerBehaviorResult
}

function toJson(value: unknown): JsonValue {
  try {
    const encoded = JSON.stringify(value === undefined ? null : value)
    return JSON.parse(encoded) as JsonValue
  } catch {
    throw new Error('operation arguments must be JSON serializable')
  }
}
