import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import type { BodyInfo, RequestEnvelope } from '../src/contracts/index.ts'
import type { ClientEvent, ClientPort } from '../src/port/index.ts'

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
  capabilities: [],
  provider: null,
}

function fakePort(): { port: ClientPort; chat(payload: unknown): void; says: string[] } {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const says: string[] = []
  const port = {
    on: (event: ClientEvent, cb: (payload: unknown) => void) => {
      const list = listeners.get(event) ?? []
      list.push(cb)
      listeners.set(event, list)
    },
    say: (text: string) => { says.push(text) },
  } as unknown as ClientPort
  return {
    port,
    says,
    chat: payload => {
      for (const cb of listeners.get('chat') ?? []) cb(payload)
    },
  }
}

function runtimeWith(port: ClientPort): BodyRuntime {
  return new BodyRuntime({
    body,
    owner: { sessionId: 's1', agentId: 'a1', cwd: 'C:/p2' },
    now: () => 100,
    port,
  })
}

function request(method: string, params: Record<string, unknown> = {}): RequestEnvelope {
  return { protocol: 1, requestId: 'r1', method, params: params as never }
}

describe('body chat transport', () => {
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
})
