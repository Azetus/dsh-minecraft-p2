import { afterEach, describe, expect, it, vi } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import type { BodyInfo, RequestEnvelope } from '../src/contracts/index.ts'
import type { BodyEvent, BodyApi } from '../src/body/api.ts'

/**
 * Category: cross-module contract (M4 dialogue transport).
 * Protects: chat is buffered by the body and exposed to the Agent through
 * poll/say; the body itself does not parse or act on chat text.
 */

const body: BodyInfo = {
  manifest: {
    schemaVersion: 1,
    bodyVersion: '0.1.0',
    protocolVersion: 1,
    entry: 'body.mjs',
    files: { 'body.mjs': 'a'.repeat(64) },
  },
  manifestDigest: 'b'.repeat(64),
  bindingId: null,

  provider: null,
}

function fakePort(): { port: BodyApi; chat(payload: unknown): void; emit(event: BodyEvent, payload: unknown): void; says: string[] } {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const says: string[] = []
  const port = {
    on: (event: BodyEvent, cb: (payload: unknown) => void) => {
      const list = listeners.get(event) ?? []
      list.push(cb)
      listeners.set(event, list)
    },
    say: (text: string) => { says.push(text) },
  } as unknown as BodyApi
  return {
    port,
    says,
    chat: payload => {
      for (const cb of listeners.get('chat') ?? []) cb(payload)
    },
    emit: (event, payload) => {
      for (const cb of listeners.get(event) ?? []) cb(payload)
    },
  }
}

function runtimeWith(port: BodyApi): BodyRuntime {
  return new BodyRuntime({
    body,
    owner: { sessionId: 's1', agentId: 'a1', cwd: 'C:/p2' },
    now: () => 100,
    game: port,
  })
}

function request(method: string, params: Record<string, unknown> = {}): RequestEnvelope {
  return { protocol: 1, requestId: 'r1', method, params: params as never }
}

describe('body chat transport', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('buffers chat and exposes it through chat.poll', async () => {
    const fake = fakePort()
    const runtime = runtimeWith(fake.port)
    fake.chat({ username: 'Human_Player', message: '你好' })
    fake.chat({ username: 'Human_Player', message: '在吗' })

    const first = await runtime.handleRequestAsync(request('chat.poll', { afterSeq: 0 }))
    expect(first.result).toMatchObject({
      messages: [
        { seq: 1, username: 'Human_Player', message: '你好' },
        { seq: 2, username: 'Human_Player', message: '在吗' },
      ],
      seq: 2,
    })
    const second = await runtime.handleRequestAsync(request('chat.poll', { afterSeq: 2 }))
    expect(second.result).toMatchObject({ messages: [], seq: 2 })
  })

  it('sends chat through chat.say without a write token', async () => {
    const fake = fakePort()
    const runtime = runtimeWith(fake.port)
    const result = await runtime.handleRequestAsync(request('chat.say', { text: '收到' }))
    expect(result.result).toEqual({ sent: true })
    expect(fake.says).toEqual(['收到'])
  })

  it('rejects an empty chat reply', async () => {
    const fake = fakePort()
    const runtime = runtimeWith(fake.port)
    const result = await runtime.handleRequestAsync(request('chat.say', { text: ' ' }))
    expect(result.error?.code).toBe('INVALID_MESSAGE')
  })

  it('turns damage into perception notices', async () => {
    const fake = fakePort()
    const runtime = runtimeWith(fake.port)
    fake.emit('damaged', { health: 8 })
    fake.emit('damaged', { health: 3 })
    fake.emit('died', {})
    const result = await runtime.handleRequestAsync(request('perception.poll', { afterSeq: 0 }))
    expect(result.result).toMatchObject({
      notices: [
        { kind: 'damaged', severity: 'warning', summary: 'health ? -> 8' },
        { kind: 'damaged', severity: 'critical', summary: 'health 8 -> 3' },
        { kind: 'died', severity: 'critical' },
      ],
    })
  })

  it('notices a hostile entering eight blocks', async () => {
    vi.useFakeTimers()
    const fake = fakePort()
    const port = fake.port as unknown as Record<string, unknown>
    port.self = () => ({
      pos: { x: 0.5, y: 64, z: 0.5 },
      yaw: 0,
      pitch: 0,
      health: 20,
      food: 20,
      onGround: true,
      inWater: false,
      inLava: false,
    })
    port.entities = () => [{
      id: 'e1',
      name: 'zombie',
      position: { x: 3, y: 64, z: 0 },
      type: 'hostile',
    }]
    const runtime = runtimeWith(fake.port)
    vi.advanceTimersByTime(500)
    const result = await runtime.handleRequestAsync(request('perception.poll', { afterSeq: 0 }))
    expect(result.result).toMatchObject({
      notices: [{ kind: 'hostile-near', severity: 'critical' }],
    })
  })
})
