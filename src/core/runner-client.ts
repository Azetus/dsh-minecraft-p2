import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import type { JsonValue } from '../contracts/types.ts'
import type { RunnerEvent, RunnerRequest } from '../runner/protocol.ts'
import { RUNNER_MAX_PENDING } from '../runner/protocol.ts'

export type RunnerOpEvent = Extract<RunnerEvent, { type: 'op' }>

export type RunnerClientOptions = {
  /** Absolute path to the built runner entry (lib/runner.js). */
  entry: string
  nodePath?: string
  requestTimeoutMs?: number
  /** Periodic liveness ping; 0 disables the timer. */
  heartbeatMs?: number
  onOp: (event: RunnerOpEvent) => void
  onLog?: (line: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

export class RunnerError extends Error {
  readonly code: string
  readonly id: number

  constructor(code: string, message: string, id = 0) {
    super(message)
    this.name = 'RunnerError'
    this.code = code
    this.id = id
  }
}

type Pending = {
  resolve: (event: RunnerEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Distributes over the request union so each variant keeps its own fields. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type RunnerRequestInput = WithoutId<RunnerRequest>

/**
 * One runner child process. Requests are matched by id; operation requests
 * arrive asynchronously and are forwarded to the caller.
 */
export class RunnerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false
  private readonly requestTimeoutMs: number
  private readonly heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: RunnerClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000
    this.child = spawn(options.nodePath ?? process.execPath, [options.entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', line => this.onLine(line))
    const errorLines = createInterface({ input: this.child.stderr, crlfDelay: Infinity })
    errorLines.on('line', line => options.onLog?.(line))
    this.child.once('error', error => this.failAll(error))
    this.child.once('exit', (code, signal) => {
      this.closed = true
      if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
      this.failAll(new RunnerError('RUNNER_EXITED', `runner exited with code ${String(code)}`))
      options.onExit?.(code, signal)
    })
    const heartbeatMs = options.heartbeatMs ?? 1000
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        if (this.closed) return
        void this.ping().catch(() => this.heartbeatFailed())
      }, heartbeatMs)
      this.heartbeat.unref?.()
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  async load(kind: 'act' | 'policy', artifactId: string, code: string): Promise<JsonValue> {
    const event = await this.request({ type: 'load', kind, artifactId, code })
    if (event.type !== 'loaded') throw new RunnerError('RUNNER_PROTOCOL', 'load did not return a manifest')
    return event.manifest
  }

  async actStart(artifactId: string, args: JsonValue): Promise<Extract<RunnerEvent, { type: 'hook' }>['result']> {
    return this.hookRequest({ type: 'act.start', artifactId, args })
  }

  async actUpdate(inputs: JsonValue): Promise<Extract<RunnerEvent, { type: 'hook' }>['result']> {
    return this.hookRequest({ type: 'act.update', inputs })
  }

  async actStop(reason: 'completed' | 'failed' | 'cancelled'): Promise<Extract<RunnerEvent, { type: 'hook' }>['result']> {
    return this.hookRequest({ type: 'act.stop', reason })
  }

  async actCleanup(inputs: JsonValue): Promise<Extract<RunnerEvent, { type: 'hook' }>['result']> {
    return this.hookRequest({ type: 'act.cleanup', inputs })
  }

  async runPolicy(artifactId: string, inputs: JsonValue): Promise<JsonValue> {
    const event = await this.request({ type: 'policy.run', artifactId, inputs })
    if (event.type === 'error') throw new RunnerError(event.code, event.message)
    if (event.type !== 'policyResult') throw new RunnerError('RUNNER_PROTOCOL', 'policy.run returned an unexpected event')
    if (!event.ok) throw new RunnerError(event.error?.code ?? 'POLICY_FAILED', event.error?.message ?? 'policy failed')
    return event.value ?? null
  }

  async ping(): Promise<void> {
    await this.request({ type: 'ping' })
  }

  dispose(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (this.closed) return
    this.closed = true
    try {
      this.child.stdin.write(`${JSON.stringify({ type: 'shutdown', id: this.nextId++ })}\n`)
    } catch {
      // The pipe may already be gone.
    }
    const timer = setTimeout(() => this.kill(), 500)
    timer.unref?.()
    this.killAfterExit()
  }

  kill(): void {
    if (this.child.exitCode !== null) return
    try { this.child.kill() } catch { /* already gone */ }
  }

  private killAfterExit(): void {
    this.child.once('exit', () => clearTimeout(this.hold))
    this.hold = setTimeout(() => this.kill(), 2000)
    this.hold.unref?.()
  }

  private hold: ReturnType<typeof setTimeout> | undefined = undefined

  private async hookRequest(request: RunnerRequestInput): Promise<Extract<RunnerEvent, { type: 'hook' }>['result']> {
    const event = await this.request(request)
    if (event.type === 'hook') return event.result
    if (event.type === 'error') throw new RunnerError(event.code, event.message)
    throw new RunnerError('RUNNER_PROTOCOL', `unexpected runner event: ${event.type}`)
  }

  private request(request: RunnerRequestInput): Promise<RunnerEvent> {
    if (this.closed) return Promise.reject(new RunnerError('RUNNER_EXITED', 'runner is closed'))
    if (this.pending.size >= RUNNER_MAX_PENDING) {
      return Promise.reject(new RunnerError('RUNNER_QUEUE_FULL', 'runner request queue is full'))
    }
    const id = this.nextId++
    return new Promise<RunnerEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RunnerError('RUNNER_TIMEOUT', `runner did not answer ${request.type} in ${this.requestTimeoutMs}ms`, id))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private onLine(line: string): void {
    if (line.trim() === '') return
    let event: RunnerEvent
    try {
      event = JSON.parse(line) as RunnerEvent
    } catch {
      this.options.onLog?.(`invalid runner event: ${line}`)
      return
    }
    if (event.type === 'ready') return
    if (event.type === 'op') {
      this.options.onOp(event)
      return
    }
    const id = 'id' in event ? event.id : 0
    const pending = this.pending.get(id)
    if (pending === undefined) {
      if (event.type === 'error') this.options.onLog?.(`runner error ${event.code}: ${event.message}`)
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(event)
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  /** A missed liveness ping is treated as an unreportable runner exit. */
  private heartbeatFailed(): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.failAll(new RunnerError('RUNNER_UNRESPONSIVE', 'runner did not answer its heartbeat'))
    this.options.onExit?.(null, null)
    this.kill()
  }
}



