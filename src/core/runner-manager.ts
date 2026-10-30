import { RunnerClient } from './runner-client.ts'
import type { RunnerClientOptions, RunnerOpEvent } from './runner-client.ts'

export type RunnerManagerOptions = {
  /** Absolute path to the built runner entry (lib/runner.js). */
  entry: string
  nodePath?: string
  requestTimeoutMs?: number
  heartbeatMs?: number
  onOp: (event: RunnerOpEvent) => void
  onLog?: (line: string) => void
  /** Called once per exit, before the next `ensure()` may create a replacement. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

/**
 * Owns the sandbox runner process for one body. A crashed or interrupted runner
 * is replaced lazily on the next operation; the caller must have failed its
 * in-flight run and cleared per-process caches in `onExit`.
 */
export class RunnerManager {
  private client: RunnerClient | undefined
  private generationValue = 0
  private disposed = false

  constructor(private readonly options: RunnerManagerOptions) {}

  get current(): RunnerClient | undefined {
    return this.client
  }

  get generation(): number {
    return this.generationValue
  }

  get isRunning(): boolean {
    return this.client !== undefined && !this.client.isClosed
  }

  /** Return the live client, spawning a replacement after an exit. */
  ensure(): RunnerClient {
    if (this.disposed) throw new Error('runner manager is disposed')
    if (this.client !== undefined && !this.client.isClosed) return this.client
    const clientOptions: RunnerClientOptions = {
      entry: this.options.entry,
      ...(this.options.nodePath === undefined ? {} : { nodePath: this.options.nodePath }),
      ...(this.options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.options.requestTimeoutMs }),
      ...(this.options.heartbeatMs === undefined ? {} : { heartbeatMs: this.options.heartbeatMs }),
      onOp: event => this.options.onOp(event),
      ...(this.options.onLog === undefined ? {} : { onLog: line => this.options.onLog?.(line) }),
      onExit: (code, signal) => {
        if (this.client === client) this.client = undefined
        this.options.onExit?.(code, signal)
      },
    }
    const client = new RunnerClient(clientOptions)
    this.client = client
    this.generationValue += 1
    return client
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.client?.dispose()
    this.client = undefined
  }
}


