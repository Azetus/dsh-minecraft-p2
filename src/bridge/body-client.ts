import {
  ErrorCodes,
  encodeJsonLine,
  p2Error,
} from '../contracts/index.ts'
import type {
  DescribeResult,
  HelloResult,
  JsonValue,
  MessageTransport,
  OwnerContext,
  P2Error,
  RequestEnvelope,
  ResponseEnvelope,
} from '../contracts/index.ts'

export class BodyClientError extends Error {
  readonly error: P2Error

  constructor(error: P2Error) {
    super(error.message)
    this.name = 'BodyClientError'
    this.error = error
  }
}

type Pending = {
  resolve: (value: JsonValue) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type BodyClientOptions = {
  timeoutMs?: number
  log?: (line: string) => void
}

/** Request/response client for one body process. Events are not used yet. */
export class BodyClient {
  private readonly pending = new Map<string, Pending>()
  private readonly offLine: () => void
  private readonly offClose: () => void
  private readonly timeoutMs: number
  private readonly log: (line: string) => void
  private requestSeq = 0
  private epoch: string | undefined
  private closed = false

  constructor(
    private readonly transport: MessageTransport,
    options: BodyClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5000
    this.log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
    this.offLine = transport.onLine(line => this.handleLine(line))
    this.offClose = transport.onClose(() => {
      this.closed = true
      this.failAll('body connection closed')
    })
  }

  get bodyEpoch(): string | undefined {
    return this.epoch
  }

  async hello(protocols: number[], owner: OwnerContext): Promise<HelloResult> {
    const result = await this.send('hello', {
      protocols,
      owner,
    }, { requireEpoch: false })
    const hello = result as unknown as HelloResult
    this.epoch = hello.bodyEpoch
    return hello
  }

  request(method: string, params: JsonValue): Promise<JsonValue> {
    return this.send(method, params, { requireEpoch: true })
  }

  async describe(): Promise<DescribeResult> {
    return await this.request('describe', {}) as unknown as DescribeResult
  }

  shutdown(): Promise<JsonValue> {
    return this.send('shutdown', {}, { requireEpoch: true })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.offLine()
    this.offClose()
    this.failAll('body client closed')
  }

  private send(
    method: string,
    params: JsonValue,
    options: { requireEpoch: boolean },
  ): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new Error('body client is closed'))
    if (options.requireEpoch && this.epoch === undefined) {
      return Promise.reject(new BodyClientError(p2Error(
        ErrorCodes.NOT_INITIALIZED,
        'validation',
        'body client has no epoch; call hello first',
        { module: 'bridge.client' },
      )))
    }

    const requestId = `p2-${++this.requestSeq}`
    const request: RequestEnvelope = {
      protocol: 1,
      requestId,
      method,
      params,
      ...(options.requireEpoch && this.epoch !== undefined ? { bodyEpoch: this.epoch } : {}),
    }

    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new BodyClientError(p2Error(
          'REQUEST_TIMEOUT',
          'timeout',
          `body request timed out: ${method}`,
          { module: 'bridge.client' },
          { method },
        )))
      }, this.timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      this.transport.send(encodeJsonLine(request))
    })
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.log('bridge: received invalid JSON from body')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const response = parsed as Partial<ResponseEnvelope>
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) {
      this.log(`bridge: response for unknown requestId ${response.requestId}`)
      return
    }
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.error !== undefined) {
      pending.reject(new BodyClientError(response.error))
      return
    }
    pending.resolve(response.result ?? null)
  }

  private failAll(message: string): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId)
      clearTimeout(pending.timer)
      pending.reject(new BodyClientError(p2Error(
        ErrorCodes.INTERNAL_ERROR,
        'transport',
        message,
        { module: 'bridge.client' },
      )))
    }
  }
}
