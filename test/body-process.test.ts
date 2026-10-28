import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION } from '../src/contracts/index.ts'

const BODY_ENTRY = resolve('lib/body/body.mjs')
const built = existsSync(BODY_ENTRY)

function canConnect(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolve(false) })
  })
}

const providerAvailable = await canConnect('127.0.0.1', 25575)

describe.skipIf(!built || !providerAvailable)('body process entry', () => {
  it('reads hello from stdin and writes one JSON line to stdout', () => {
    const directory = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-body-'))
    const input = join(directory, 'in.jsonl')
    const output = join(directory, 'out.jsonl')
    try {
      writeFileSync(input, `${JSON.stringify({
        protocol: 1,
        requestId: 'req-1',
        method: 'hello',
        params: {
          protocols: [PROTOCOL_VERSION],
          owner: { sessionId: 'session-1', agentId: 'agent-1', cwd: process.cwd() },
        },
      })}\n`)

      const inputFd = openSync(input, 'r')
      const outputFd = openSync(output, 'w')
      let result
      try {
        result = spawnSync(process.execPath, [BODY_ENTRY], {
          cwd: process.cwd(),
          stdio: [inputFd, outputFd, 'ignore'],
          timeout: 5000,
        })
      } finally {
        closeSync(inputFd)
        closeSync(outputFd)
      }

      expect(result.status).toBe(0)
      const lines = readFileSync(output, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const response = JSON.parse(lines[0] as string) as {
        result?: { bodyEpoch?: string; owner?: { sessionId?: string } }
        error?: unknown
      }
      expect(response.error).toBeUndefined()
      expect(response.result?.bodyEpoch).toBeTypeOf('string')
      expect(response.result?.owner?.sessionId).toBe('session-1')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
