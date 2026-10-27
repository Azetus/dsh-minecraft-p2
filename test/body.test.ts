import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import { BodyServer } from '../src/body/server.ts'
import {
  ErrorCodes,
  METHODS,
  PROTOCOL_VERSION,
  bodyManifestDigest,
  createMemoryTransportPair,
  encodeJsonLine,
} from '../src/contracts/index.ts'
import type {
  BodyInfo,
  BodyManifest,
  HelloResult,
  RequestEnvelope,
  ResponseEnvelope,
  StatusResult,
} from '../src/contracts/index.ts'

const manifest: BodyManifest = {
  schemaVersion: 1,
  bodyVersion: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  entry: 'body.mjs',
  files: { 'body.mjs': 'a'.repeat(64) },
}

const body: BodyInfo = {
  manifest,
  manifestDigest: bodyManifestDigest(manifest),
  bindingId: null,
  capabilities: [],
  provider: null,
}

const owner = {
  sessionId: 'session-1',
  agentId: 'agent-1',
  cwd: process.cwd(),
}

function runtime(): BodyRuntime {
  return new BodyRuntime({
    body,
    newEpoch: () => 'epoch-1',
  })
}

function request(
  method: string,
  params: RequestEnvelope['params'],
  extra: Partial<RequestEnvelope> = {},
): RequestEnvelope {
  return {
    protocol: 1,
    requestId: `req-${method}`,
    method,
    params,
    ...(method === 'hello' ? {} : { bodyEpoch: 'epoch-1' }),
    ...extra,
  }
}

function expectResult(response: ResponseEnvelope): Record<string, unknown> {
  expect(response.error).toBeUndefined()
  return response.result as Record<string, unknown>
}

function hello(rt: BodyRuntime, sessionId = owner.sessionId): ResponseEnvelope {
  return rt.handleRequest(request('hello', {
    protocols: [PROTOCOL_VERSION],
    owner: { ...owner, sessionId },
  }))
}

describe('BodyRuntime', () => {
  it('bootstraps hello and keeps the first owner stable', () => {
    const rt = runtime()
    const first = expectResult(hello(rt)) as unknown as HelloResult
    expect(first.bodyEpoch).toBe('epoch-1')
    expect(first.owner.sessionId).toBe('session-1')

    const repeated = expectResult(hello(rt)) as unknown as HelloResult
    expect(repeated.bodyEpoch).toBe('epoch-1')
    expect(repeated.owner.sessionId).toBe('session-1')

    const other = hello(rt, 'session-2')
    expect(other.error?.code).toBe(ErrorCodes.INVALID_OWNER)
  })

  it('rejects requests before hello and stale epochs', () => {
    const rt = runtime()
    const before = rt.handleRequest(request('status', {}))
    expect(before.error?.code).toBe(ErrorCodes.NOT_INITIALIZED)

    hello(rt)
    const stale = rt.handleRequest(request('status', {}, { bodyEpoch: 'old-epoch' }))
    expect(stale.error?.code).toBe(ErrorCodes.STALE_EPOCH)
  })

  it('accepts heartbeat, describe, and status after hello', () => {
    const rt = runtime()
    hello(rt)
    const heartbeat = expectResult(rt.handleRequest(request('heartbeat', { seq: 1 })))
    expect(heartbeat).toEqual({ seq: 1, alive: true })

    const describe = expectResult(rt.handleRequest(request('describe', {})))
    expect(describe.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(describe.bindingId).toBeNull()

    const status = expectResult(rt.handleRequest(request('status', {}))) as unknown as StatusResult
    expect(status.owner?.sessionId).toBe('session-1')
    expect(status.activeRun).toBeNull()
  })

  it('records stop commands and rejects duplicate command ids across methods', () => {
    const rt = runtime()
    hello(rt)
    const stop = rt.handleRequest(request('stop', {}, { commandId: 'cmd-1' }))
    expect(expectResult(stop)).toEqual({ accepted: true, runId: null })

    const get = rt.handleRequest(request('command.get', { commandId: 'cmd-1' }))
    expect(expectResult(get).state).toBe('completed')

    const duplicate = rt.handleRequest(request('shutdown', {}, { commandId: 'cmd-1' }))
    expect(duplicate.error?.code).toBe(ErrorCodes.DUPLICATE_COMMAND)
  })

  it('shuts down after a shutdown command and rejects later work', () => {
    const rt = runtime()
    hello(rt)
    const shutdown = rt.handleRequest(request('shutdown', {}, { commandId: 'cmd-2' }))
    expect(expectResult(shutdown)).toEqual({ closing: true })
    expect(rt.isClosing).toBe(true)
    const later = rt.handleRequest(request('status', {}))
    expect(later.error?.code).toBe(ErrorCodes.SHUTTING_DOWN)
  })

  it('handles every method in METHODS through the switch', () => {
    for (const method of METHODS) {
      const rt = runtime()
      hello(rt)
      let params: RequestEnvelope['params'] = {}
      let extra: Partial<RequestEnvelope> = {}
      if (method === 'heartbeat') params = { seq: 1 }
      if (method === 'stop' || method === 'shutdown') extra = { commandId: `cmd-${method}` }
      if (method === 'command.get') {
        rt.handleRequest(request('stop', {}, { commandId: 'known' }))
        params = { commandId: 'known' }
      }
      const response = rt.handleRequest(request(method, params, extra))
      expect(response.error?.code).not.toBe(ErrorCodes.UNKNOWN_METHOD)
    }
  })

  it('returns structured errors for malformed params', () => {
    const rt = runtime()
    expect(rt.handleRequest(request('hello', {})).error?.code).toBe(ErrorCodes.INVALID_MESSAGE)
    hello(rt)
    expect(rt.handleRequest(request('heartbeat', { seq: -1 })).error?.code)
      .toBe(ErrorCodes.INVALID_MESSAGE)
    expect(rt.handleRequest(request('status', {}, { commandId: 'x' })).error).toBeUndefined()
  })
})

describe('BodyServer', () => {
  it('serves hello/describe over a transport and closes on shutdown', async () => {
    const [client, bodySide] = createMemoryTransportPair()
    const rt = runtime()
    const server = new BodyServer(rt, bodySide)
    const responses: ResponseEnvelope[] = []
    let closed = false
    client.onLine(line => responses.push(JSON.parse(line) as ResponseEnvelope))
    client.onClose(() => { closed = true })
    server.start()

    client.send(encodeJsonLine(request('hello', {
      protocols: [PROTOCOL_VERSION],
      owner,
    })))
    expect(responses).toHaveLength(1)
    expect(responses[0]?.error).toBeUndefined()

    client.send(encodeJsonLine(request('shutdown', {}, { commandId: 'bye' })))
    expect(responses).toHaveLength(2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closed).toBe(true)
    expect(server.isStopped).toBe(true)
  })

  it('closes on invalid JSON and logs a diagnostic', () => {
    const [client, bodySide] = createMemoryTransportPair()
    const logs: string[] = []
    const rt = runtime()
    const server = new BodyServer(rt, bodySide, { log: line => logs.push(line) })
    let closed = false
    client.onClose(() => { closed = true })
    server.start()

    client.send('{not json}\n')
    expect(closed).toBe(true)
    expect(server.isStopped).toBe(true)
    expect(logs).toHaveLength(1)
  })
})
