import {
  ErrorCodes,
  encodeJsonLine,
  invalidMessageError,
  isRecord,
  p2Error,
} from '../contracts/index.ts'
import type {
  JsonValue,
  MessageTransport,
  RequestEnvelope,
  ResponseEnvelope,
} from '../contracts/index.ts'
import { BodyRuntime } from './runtime.ts'

export type BodyServerOptions = {
  log?: (line: string) => void
}

/** Protocol dispatcher over a MessageTransport; framing stays in the transport. */
export class BodyServer {
  private started = false
  private stopped = false
  private readonly closeListeners = new Set<() => void>()
  private readonly offLine: () => void
  private readonly offError: () => void
  private readonly offClose: () => void
  private leaseTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly runtime: BodyRuntime,
    private readonly transport: MessageTransport,
    private readonly options: BodyServerOptions = {},
  ) {
    this.offLine = transport.onLine(line => this.handleLine(line))
    this.offError = transport.onError(error => {
      this.log(`transport error: ${error.message}`)
      this.stop()
    })
    this.offClose = transport.onClose(() => this.stop())
  }

  get isStopped(): boolean {
    return this.stopped
  }

  start(): void {
    if (this.started) throw new Error('body server already started')
    this.started = true
    const timeout = this.runtime.leaseTimeoutMs
    if (timeout !== undefined) {
      const period = Math.max(100, Math.min(1000, Math.floor(timeout / 2)))
      this.leaseTimer = setInterval(() => {
        if (!this.runtime.checkHeartbeat()) {
          this.log('owner lease expired')
          this.stop()
        }
      }, period)
      this.leaseTimer.unref?.()
    }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    if (this.stopped) listener()
    return () => this.closeListeners.delete(listener)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.leaseTimer !== undefined) clearInterval(this.leaseTimer)
    this.offLine()
    this.offError()
    this.offClose()
    this.transport.close()
    for (const listener of this.closeListeners) listener()
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.log('invalid JSON frame; closing body connection')
      this.stop()
      return
    }

    const request = this.parseEnvelope(parsed)
    if (request === undefined) {
      this.log('invalid request envelope; closing body connection')
      this.stop()
      return
    }
    if ('error' in request) {
      this.send({ protocol: 1, requestId: request.requestId, bodyEpoch: this.runtime.bodyEpoch, error: request.error })
      return
    }

    let response: ResponseEnvelope
    try {
      response = this.runtime.handleRequest(request.value)
    } catch (error) {
      this.log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      response = {
        protocol: 1,
        requestId: request.value.requestId,
        bodyEpoch: this.runtime.bodyEpoch,
        error: p2Error(
          ErrorCodes.INTERNAL_ERROR,
          'runtime',
          error instanceof Error ? error.message : String(error),
          { module: 'body.server' },
        ),
      }
    }

    this.send(response)
    if (this.runtime.isClosing) {
      // Let the response reach the pipe before closing the transport.
      setTimeout(() => this.stop(), 0)
    }
  }

  private parseEnvelope(value: unknown):
    | { value: RequestEnvelope }
    | { requestId: string; error: ReturnType<typeof invalidMessageError> }
    | undefined {
    if (!isRecord(value)) return undefined
    if (value.protocol !== 1
      || typeof value.requestId !== 'string'
      || typeof value.method !== 'string'
      || !isRecord(value.params)
      || (value.bodyEpoch !== undefined && typeof value.bodyEpoch !== 'string')
      || (value.commandId !== undefined && typeof value.commandId !== 'string')) {
      if (typeof value.requestId === 'string') {
        return {
          requestId: value.requestId,
          error: invalidMessageError('request envelope is invalid'),
        }
      }
      return undefined
    }
    return {
      value: {
        protocol: 1,
        requestId: value.requestId,
        method: value.method,
        params: value.params as JsonValue,
        ...(value.bodyEpoch === undefined ? {} : { bodyEpoch: value.bodyEpoch }),
        ...(value.commandId === undefined ? {} : { commandId: value.commandId }),
      },
    }
  }

  private send(response: ResponseEnvelope): void {
    this.transport.send(encodeJsonLine(response))
  }

  private log(line: string): void {
    const output = this.options.log ?? ((text: string) => process.stderr.write(`${text}\n`))
    output(line)
  }
}
