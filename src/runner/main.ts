import { createInterface } from 'node:readline'

import type { JsonValue } from '../contracts/types.ts'
import { Sandbox, SandboxError } from './sandbox.ts'
import type { RunnerEvent, RunnerHookResult, RunnerRequest } from './protocol.ts'

type Loaded = { kind: 'act' | 'policy' | 'behavior'; sandbox: Sandbox; manifest: JsonValue }

const loaded = new Map<string, Loaded>()
let current: string | undefined
let currentBehavior: { runId: string; actInstanceId: string; generation: number; artifactId: string } | undefined
let nextOpId = 1

function send(event: RunnerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function fail(id: number, error: unknown): void {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const code = sandboxError?.code ?? 'RUNNER_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  send({ type: 'error', id, code, message })
  if (code === 'ACT_TIMEOUT' || code === 'LOAD_TIMEOUT' || code === 'BEHAVIOR_STEP_TIMEOUT') {
    // A terminated vm context cannot be reused; the body must rebuild the runner.
    process.exitCode = 1
    // Let the error frame reach the body before the process exits.
    setImmediate(() => process.exit(1))
  }
}

function hookFailure(error: unknown): RunnerHookResult {
  const sandboxError = error instanceof SandboxError ? error : undefined
  return {
    kind: 'failed',
    error: {
      code: sandboxError?.code ?? 'ACT_HOOK_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

function ownsBehavior(runId: string, generation: number): boolean {
  return currentBehavior !== undefined
    && currentBehavior.runId === runId
    && currentBehavior.generation === generation
}

function handle(request: RunnerRequest): void {
  switch (request.type) {
    case 'load': {
      const cached = loaded.get(request.artifactId)
      if (cached !== undefined) {
        send({ type: 'loaded', id: request.id, manifest: cached.manifest })
        return
      }
      try {
        const sandbox = new Sandbox({
          op: (kind, name, args) => {
            const callId = nextOpId++
            send({ type: 'op', callId, kind, name, args })
            return callId
          },
          log: message => process.stderr.write(`[runner] ${message}\n`),
          now: () => Date.now(),
        })
        const manifest = sandbox.load(request.kind, request.code)
        loaded.set(request.artifactId, { kind: request.kind, sandbox, manifest })
        send({ type: 'loaded', id: request.id, manifest })
      } catch (error) {
        fail(request.id, error)
      }
      return
    }
    case 'act.start': {
      const entry = loaded.get(request.artifactId)
      if (entry === undefined || entry.kind !== 'act') {
        send({ type: 'error', id: request.id, code: 'ACT_NOT_LOADED', message: `act is not loaded: ${request.artifactId}` })
        return
      }
      current = request.artifactId
      try {
        send({ type: 'hook', id: request.id, result: entry.sandbox.start(request.args) })
      } catch (error) {
        send({ type: 'hook', id: request.id, result: hookFailure(error) })
      }
      return
    }
    case 'act.update': {
      const entry = current === undefined ? undefined : loaded.get(current)
      if (entry === undefined) {
        send({ type: 'error', id: request.id, code: 'ACT_NOT_RUNNING', message: 'no active act' })
        return
      }
      try {
        send({ type: 'hook', id: request.id, result: entry.sandbox.update(request.inputs) })
      } catch (error) {
        send({ type: 'hook', id: request.id, result: hookFailure(error) })
      }
      return
    }
    case 'act.stop': {
      const entry = current === undefined ? undefined : loaded.get(current)
      if (entry === undefined) {
        send({ type: 'hook', id: request.id, result: { kind: 'complete' } })
        return
      }
      try {
        send({ type: 'hook', id: request.id, result: entry.sandbox.stop(request.reason) })
      } catch (error) {
        send({ type: 'hook', id: request.id, result: hookFailure(error) })
      }
      return
    }
    case 'act.cleanup': {
      const entry = current === undefined ? undefined : loaded.get(current)
      if (entry === undefined) {
        send({ type: 'hook', id: request.id, result: { kind: 'complete' } })
        return
      }
      try {
        send({ type: 'hook', id: request.id, result: entry.sandbox.cleanup(request.inputs) })
      } catch (error) {
        send({ type: 'hook', id: request.id, result: hookFailure(error) })
      }
      return
    }
    case 'policy.run': {
      const entry = loaded.get(request.artifactId)
      if (entry === undefined || entry.kind !== 'policy') {
        send({ type: 'error', id: request.id, code: 'POLICY_NOT_LOADED', message: `policy is not loaded: ${request.artifactId}` })
        return
      }
      try {
        const value = entry.sandbox.runPolicy(request.inputs)
        send({ type: 'policyResult', id: request.id, ok: true, value })
      } catch (error) {
        const sandboxError = error instanceof SandboxError ? error : undefined
        send({
          type: 'policyResult',
          id: request.id,
          ok: false,
          error: {
            code: sandboxError?.code ?? 'POLICY_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
      return
    }
    case 'behavior.start': {
      const entry = loaded.get(request.artifactId)
      if (entry === undefined || entry.kind !== 'behavior') {
        send({ type: 'error', id: request.id, code: 'BEHAVIOR_NOT_LOADED', message: `behavior is not loaded: ${request.artifactId}` })
        return
      }
      if (currentBehavior !== undefined) {
        send({ type: 'error', id: request.id, code: 'BEHAVIOR_BUSY', message: 'another behavior is active' })
        return
      }
      try {
        entry.sandbox.behaviorStart(request.params, request.runId)
        currentBehavior = {
          runId: request.runId,
          actInstanceId: request.actInstanceId,
          generation: request.generation,
          artifactId: request.artifactId,
        }
        send({
          type: 'behaviorResult',
          id: request.id,
          runId: request.runId,
          generation: request.generation,
          result: { kind: 'started' },
        })
      } catch (error) {
        fail(request.id, error)
      }
      return
    }
    case 'behavior.resume': {
      if (!ownsBehavior(request.runId, request.generation)) {
        send({ type: 'error', id: request.id, code: 'STALE_BEHAVIOR', message: 'behavior step does not belong to the active run' })
        return
      }
      const entry = currentBehavior === undefined ? undefined : loaded.get(currentBehavior.artifactId)
      if (entry === undefined) {
        send({ type: 'error', id: request.id, code: 'BEHAVIOR_NOT_RUNNING', message: 'no active behavior' })
        return
      }
      try {
        const result = entry.sandbox.behaviorStep({
          ...(request.input.value === undefined ? {} : { value: request.input.value }),
          thrown: request.input.thrown,
        })
        // A finished or uncaught-throwing generator can never be resumed; free
        // the behavior slot so the next switch is not rejected as busy.
        if (result.kind === 'done' || result.kind === 'threw') currentBehavior = undefined
        send({ type: 'behaviorResult', id: request.id, runId: request.runId, generation: request.generation, result })
      } catch (error) {
        fail(request.id, error)
      }
      return
    }
    case 'behavior.stop': {
      if (currentBehavior === undefined) {
        // The generator already completed; stop is idempotent.
        send({ type: 'behaviorResult', id: request.id, runId: request.runId, generation: request.generation, result: { kind: 'stopped' } })
        return
      }
      if (currentBehavior.runId !== request.runId) {
        send({ type: 'error', id: request.id, code: 'STALE_BEHAVIOR', message: 'behavior stop does not belong to the active run' })
        return
      }
      const entry = loaded.get(currentBehavior.artifactId)
      currentBehavior = undefined
      if (entry === undefined) {
        send({ type: 'behaviorResult', id: request.id, runId: request.runId, generation: request.generation, result: { kind: 'stopped' } })
        return
      }
      try {
        const result = entry.sandbox.behaviorStop()
        send({ type: 'behaviorResult', id: request.id, runId: request.runId, generation: request.generation, result })
      } catch (error) {
        fail(request.id, error)
      }
      return
    }
    case 'ping': {
      send({ type: 'done', id: request.id })
      return
    }
    case 'shutdown': {
      send({ type: 'done', id: request.id })
      process.exit(0)
    }
  }
}

send({ type: 'ready' })

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  if (line.trim() === '') return
  let request: RunnerRequest
  try {
    request = JSON.parse(line) as RunnerRequest
  } catch {
    send({ type: 'error', id: 0, code: 'RUNNER_PROTOCOL', message: 'invalid JSON request' })
    return
  }
  handle(request)
})
lines.on('close', () => process.exit(0))
