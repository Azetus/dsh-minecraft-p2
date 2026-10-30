import { DEFAULT_MAX_FRAME_BYTES } from './protocol.ts'

export class FrameError extends Error {
  readonly code: 'FRAME_TOO_LARGE' | 'FRAME_TRUNCATED' | 'FRAME_INVALID_JSON'

  constructor(code: 'FRAME_TOO_LARGE' | 'FRAME_TRUNCATED' | 'FRAME_INVALID_JSON', message: string) {
    super(message)
    this.name = 'FrameError'
    this.code = code
  }
}

/**
 * Split UTF-8 text into JSON Lines without assuming chunk boundaries.
 * `end` rejects an unterminated frame; callers own the connection policy.
 */
export class LineFramer {
  private buffer = ''
  private readonly maxBytes: number

  constructor(maxBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be positive')
    this.maxBytes = maxBytes
  }

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      let line = this.buffer.slice(0, newline)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.buffer = this.buffer.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > this.maxBytes) {
        throw new FrameError('FRAME_TOO_LARGE', `frame exceeds ${this.maxBytes} bytes`)
      }
      lines.push(line)
      newline = this.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBytes) {
      throw new FrameError('FRAME_TOO_LARGE', `frame exceeds ${this.maxBytes} bytes`)
    }
    return lines
  }

  end(): void {
    if (this.buffer.length > 0) {
      throw new FrameError('FRAME_TRUNCATED', 'connection closed with an unterminated frame')
    }
  }

  get pendingBytes(): number {
    return Buffer.byteLength(this.buffer, 'utf8')
  }
}

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

export function decodeJsonLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    throw new FrameError('FRAME_INVALID_JSON', 'frame is not valid JSON')
  }
}


