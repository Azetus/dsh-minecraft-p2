import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import {
  ErrorCodes,
  FrameError,
  LineFramer,
  METHODS,
  createMemoryTransportPair,
  createStdioTransport,
  decodeJsonLine,
  encodeJsonLine,
  isOwnerContext,
  p2Error,
} from '../src/contracts/index.ts'

describe('LineFramer', () => {
  it('splits chunks and merges frames independent of chunk boundaries', () => {
    const framer = new LineFramer()
    expect(framer.push('{"a":1')).toEqual([])
    expect(framer.push('}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
    expect(framer.pendingBytes).toBe(0)
  })

  it('accepts CRLF and rejects an unterminated final frame', () => {
    const framer = new LineFramer()
    expect(framer.push('{"a":1}\r\n')).toEqual(['{"a":1}'])
    expect(() => {
      framer.push('{"b":2}')
      framer.end()
    }).toThrow(FrameError)
  })

  it('rejects oversized frames before and after a newline', () => {
    expect(() => new LineFramer(8).push('123456789')).toThrow(/exceeds/)
    expect(() => new LineFramer(8).push('123456789\n')).toThrow(/exceeds/)
  })

  it('round-trips JSON and rejects invalid JSON', () => {
    expect(encodeJsonLine({ a: 1 })).toBe('{"a":1}\n')
    expect(decodeJsonLine('{"a":1}')).toEqual({ a: 1 })
    expect(() => decodeJsonLine('{')).toThrow(/valid JSON/)
  })
})

describe('memory transport', () => {
  it('delivers complete lines and closes both endpoints', () => {
    const [left, right] = createMemoryTransportPair()
    const received: string[] = []
    let closed = 0
    right.onLine(line => received.push(line))
    right.onClose(() => { closed += 1 })

    left.send('one\n')
    left.send('two\n')
    expect(received).toEqual(['one\n', 'two\n'])

    left.close()
    expect(closed).toBe(1)
    left.send('after\n')
    expect(received).toHaveLength(2)
  })
})

describe('stdio transport', () => {
  it('handles split frames, merged frames, and UTF-8 split across chunks', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const received: string[] = []
    const transport = createStdioTransport(input, output)
    transport.onLine(line => received.push(line))

    input.write('{"a"')
    input.write(':1}\n{"b":2}\n')
    const bytes = Buffer.from('{"m":"你"}\n')
    input.write(bytes.subarray(0, 8))
    input.write(bytes.subarray(8))
    await new Promise(resolve => setImmediate(resolve))

    expect(received).toEqual(['{"a":1}', '{"b":2}', '{"m":"你"}'])
  })

  it('writes sent lines to the output stream', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', chunk => { text += chunk.toString() })
    const transport = createStdioTransport(input, output)

    transport.send('{"ok":true}\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(text).toBe('{"ok":true}\n')
  })

  it('reports truncated input and closes', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const errors: Error[] = []
    let closed = false
    const transport = createStdioTransport(input, output)
    transport.onError(error => errors.push(error))
    transport.onClose(() => { closed = true })

    input.end('{"a":1}')
    await new Promise(resolve => setImmediate(resolve))

    expect(errors).toHaveLength(1)
    expect((errors[0] as FrameError).code).toBe('FRAME_TRUNCATED')
    expect(closed).toBe(true)
  })
})

describe('protocol vocabulary', () => {
  it('keeps method names unique and complete for M1', () => {
    expect(new Set(METHODS).size).toBe(METHODS.length)
    expect(METHODS).toEqual([
      'hello',
      'heartbeat',
      'describe',
      'status',
      'world.observe',
      'world.entities',
      'blueprint.preview',
      'chat.poll',
      'chat.say',
      'perception.poll',
      'mind.order',
      'mind.duty',
      'mind.baseActivity',
      'mind.policy',
      'mind.orders',
      'mind.cancel',
      'mind.report',
      'mind.events',
      'shutdown',
    ])

  })

  it('builds structured errors and validates owners', () => {
    const error = p2Error(ErrorCodes.INVALID_MESSAGE, 'validation', 'bad')
    expect(error.retry).toBe('never')
    expect(error.category).toBe('validation')
    expect(isOwnerContext({ sessionId: 's', agentId: 'a', cwd: 'C:/p' })).toBe(true)
    expect(isOwnerContext({ sessionId: 's' })).toBe(false)
  })
})




