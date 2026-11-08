import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION } from '../src/contracts/index.ts'

const BODY_ENTRY = resolve('lib/body/body.mjs')
const built = existsSync(BODY_ENTRY)

// The body starts provider-unavailable when no target is injected; this test
// must never connect to a real server (a second P2_Bot login would kick the
// live body with duplicate_login).
describe.skipIf(!built)('body process entry', () => {
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
          env: {
            ...process.env,
            P2_JOURNAL_PATH: join(directory, 'journal.jsonl'),
            P2_MC_HOST: '',
            P2_MC_PORT: '',
          },
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

  it('writes one fatal stderr line when startup fails before the server', () => {
    const directory = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-body-'))
    try {
      const result = spawnSync(process.execPath, [BODY_ENTRY], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          P2_JOURNAL_PATH: join(directory, 'journal.jsonl'),
          P2_MC_HOST: '127.0.0.1',
          P2_MC_PORT: '25575',
          // Invalid value: loadProviderConfig throws before any MC connection.
          P2_MC_CONNECT_TIMEOUT_MS: '0',
        },
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('dsh-minecraft-p2 body: fatal:')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

