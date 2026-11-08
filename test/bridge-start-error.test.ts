import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BodyManager, createProcessSpawner } from '../src/bridge/process-manager.ts'
import type { BodyExit, BodyHandle } from '../src/bridge/process-manager.ts'
import { createMemoryTransportPair } from '../src/contracts/index.ts'
import type { MessageTransport } from '../src/contracts/index.ts'

/**
 * Category: access consistency (startup diagnostics).
 * Protects: a body that dies before hello reports the last stderr line and exit
 * status instead of only "body connection closed"; the fallback points at the
 * DSH log when no stderr was captured.
 */

const dirs: string[] = []
const owner = { sessionId: 'session-1', agentId: 'agent-1', cwd: process.cwd() }

function tempDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-start-error-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function failingHandle(options: {
  line?: string
  exit?: BodyExit
} = {}): { handle: BodyHandle; close: () => void } {
  const [client, server] = createMemoryTransportPair()
  const transport: MessageTransport = {
    send: line => client.send(line),
    onLine: listener => client.onLine(listener),
    onError: listener => client.onError(listener),
    onClose: listener => client.onClose(listener),
    close: () => client.close(),
  }
  const exit = options.exit ?? { code: 1, signal: null }
  const handle: BodyHandle = {
    transport,
    kill: () => {},
    waitForExit: async () => exit,
    ...(options.line === undefined ? {} : { lastStderrLine: () => options.line }),
    exitInfo: () => exit,
  }
  // Keep the peer referenced so the transport pair stays alive until closed.
  void server
  return {
    handle,
    close: () => client.close(),
  }
}

function managerFor(spawn: () => BodyHandle): BodyManager {
  return new BodyManager({
    bodyEntry: 'unused-body.mjs',
    heartbeatMs: 10,
    requestTimeoutMs: 20,
    stopTimeoutMs: 50,
    lockDir: tempDir(),
    delay: async () => {},
    spawnBody: spawn,
    log: () => {},
  })
}

describe('body start failure diagnostics', () => {
  it('captures the last stderr line and the exit code from a real child', async () => {
    const dir = tempDir()
    const script = join(dir, 'fail.mjs')
    writeFileSync(script, [
      "process.stderr.write('noise line\\n')",
      "process.stderr.write('dsh-minecraft-p2 body: fatal: provider connection failed: Invalid username\\n')",
      'process.exit(3)',
      '',
    ].join('\n'))
    const spawner = createProcessSpawner(() => {})
    const handle = spawner(script, dir)
    const exit = await handle.waitForExit()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(exit).toEqual({ code: 3, signal: null })
    expect(handle.lastStderrLine?.()).toBe('dsh-minecraft-p2 body: fatal: provider connection failed: Invalid username')
    expect(handle.exitInfo?.()).toEqual({ code: 3, signal: null })
  })

  it('reports the captured stderr line and exit status instead of only the transport close', async () => {
    const failing = failingHandle({
      line: 'dsh-minecraft-p2 body: fatal: provider connection failed: Invalid username',
    })
    const manager = managerFor(() => {
      setTimeout(() => failing.close(), 5)
      return failing.handle
    })
    await expect(manager.start(owner, { host: '127.0.0.1', port: 25575 }))
      .rejects.toThrow(/P2 body exited before handshake \(exit 1\): dsh-minecraft-p2 body: fatal: provider connection failed: Invalid username/)
  })

  it('points at the DSH log when the body died without a captured stderr line', async () => {
    const failing = failingHandle({ exit: { code: 1, signal: null } })
    const manager = managerFor(() => {
      setTimeout(() => failing.close(), 5)
      return failing.handle
    })
    await expect(manager.start(owner, { host: '127.0.0.1', port: 25575 }))
      .rejects.toThrow(/P2 body exited before handshake \(exit 1\); check body stderr in the DSH log/)
  })
})
