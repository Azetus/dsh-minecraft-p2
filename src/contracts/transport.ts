import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'

import { FrameError, LineFramer } from './framing.ts'
import { DEFAULT_MAX_FRAME_BYTES } from './protocol.ts'

export type Unsubscribe = () => void

/** Transport carries complete JSON Lines; framing stays outside the protocol. */
export interface MessageTransport {
  send(line: string): void
  onLine(listener: (line: string) => void): Unsubscribe
  onError(listener: (error: Error) => void): Unsubscribe
  onClose(listener: () => void): Unsubscribe
  close(): void
}

export function createMemoryTransportPair(): [MessageTransport, MessageTransport] {
  const left = new MemoryEndpoint()
  const right = new MemoryEndpoint()
  left.peer = right
  right.peer = left
  return [left, right]
}

class MemoryEndpoint implements MessageTransport {
  peer: MemoryEndpoint | undefined
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private readonly closeListeners = new Set<() => void>()
  private closed = false
  private closeNotified = false

  send(line: string): void {
    const peer = this.peer
    if (this.closed || peer === undefined || peer.closed) return
    for (const listener of peer.lineListeners) listener(line)
  }

  onLine(listener: (line: string) => void): Unsubscribe {
    this.lineListeners.add(listener)
    return () => this.lineListeners.delete(listener)
  }

  onError(listener: (error: Error) => void): Unsubscribe {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onClose(listener: () => void): Unsubscribe {
    this.closeListeners.add(listener)
    if (this.closed) listener()
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.notifyClose()
    this.peer?.remoteClose()
  }

  fail(error: Error): void {
    if (this.closed) return
    for (const listener of this.errorListeners) listener(error)
    this.close()
  }

  private remoteClose(): void {
    this.closed = true
    this.notifyClose()
  }

  private notifyClose(): void {
    if (this.closeNotified) return
    this.closeNotified = true
    for (const listener of this.closeListeners) listener()
  }
}

export function createStdioTransport(
  input: Readable,
  output: Writable,
  maxBytes = DEFAULT_MAX_FRAME_BYTES,
): MessageTransport {
  return new StdioEndpoint(input, output, maxBytes)
}

class StdioEndpoint implements MessageTransport {
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly framer: LineFramer
  private readonly decoder = new StringDecoder('utf8')
  private closed = false
  private closeNotified = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    maxBytes: number,
  ) {
    this.framer = new LineFramer(maxBytes)
    input.on('data', this.handleData)
    input.on('end', this.handleEnd)
    input.on('close', this.handleClose)
    input.on('error', this.handleError)
    output.on('error', this.handleError)
  }

  send(line: string): void {
    if (this.closed) return
    this.output.write(line, 'utf8')
  }

  onLine(listener: (line: string) => void): Unsubscribe {
    this.lineListeners.add(listener)
    return () => this.lineListeners.delete(listener)
  }

  onError(listener: (error: Error) => void): Unsubscribe {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onClose(listener: () => void): Unsubscribe {
    this.closeListeners.add(listener)
    if (this.closed) listener()
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.handleData)
    this.input.off('end', this.handleEnd)
    this.input.off('close', this.handleClose)
    this.input.off('error', this.handleError)
    this.output.off('error', this.handleError)
    this.notifyClose()
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    try {
      this.deliver(this.framer.push(typeof chunk === 'string' ? chunk : this.decoder.write(chunk)))
    } catch (error) {
      this.fail(error)
    }
  }

  private readonly handleEnd = (): void => {
    try {
      this.deliver(this.framer.push(this.decoder.end()))
      this.framer.end()
    } catch (error) {
      this.fail(error)
    } finally {
      this.close()
    }
  }

  private readonly handleClose = (): void => {
    this.close()
  }

  private readonly handleError = (error: Error): void => {
    this.fail(error)
  }

  private deliver(lines: string[]): void {
    for (const line of lines) {
      for (const listener of this.lineListeners) listener(line)
    }
  }

  private fail(error: unknown): void {
    this.emitError(error instanceof Error ? error : new FrameError('FRAME_TRUNCATED', String(error)))
    this.close()
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error)
  }

  private notifyClose(): void {
    if (this.closeNotified) return
    this.closeNotified = true
    for (const listener of this.closeListeners) listener()
  }
}


