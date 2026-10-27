import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CommandLedger, DebugLog } from '../src/core/logging.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function tempFile(): { directory: string; path: string } {
  const directory = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-log-'))
  directories.push(directory)
  return { directory, path: join(directory, 'debug.jsonl') }
}

describe('DebugLog', () => {
  it('writes JSON Lines asynchronously and flushes on close', async () => {
    const { path } = tempFile()
    const log = new DebugLog({ filePath: path })
    expect(log.log({ type: 'run/start', runId: 'r1' })).toBe(true)
    expect(log.log({ type: 'run/end', runId: 'r1' })).toBe(true)
    await log.close()
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toEqual({ type: 'run/start', runId: 'r1' })
    expect(log.loggingUnavailable).toBe(false)
  })

  it('drops entries at the bounded buffer and counts them', async () => {
    const { path } = tempFile()
    const log = new DebugLog({ filePath: path, maxBuffer: 1 })
    expect(log.log({ n: 1 })).toBe(true)
    expect(log.log({ n: 2 })).toBe(false)
    expect(log.droppedCount).toBe(1)
    await log.close()
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('rotates the single debug file when the size limit is crossed', async () => {
    const { path } = tempFile()
    const log = new DebugLog({ filePath: path, maxBytes: 20 })
    log.log({ payload: '1234567890' })
    await log.flush()
    log.log({ payload: 'abcdefghij' })
    await log.flush()
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(path)).toBe(true)
  })

  it('marks logging unavailable instead of blocking the caller', async () => {
    const { directory } = tempFile()
    const log = new DebugLog({ filePath: join(directory, 'missing', 'debug.jsonl') })
    log.log({ type: 'bad' })
    await log.close()
    expect(log.loggingUnavailable).toBe(true)
    expect(log.droppedCount).toBeGreaterThan(0)
  })
})

describe('CommandLedger', () => {
  it('deduplicates command ids and bounds memory', () => {
    const ledger = new CommandLedger<{ value: number }>(2)
    expect(ledger.record('a', { value: 1 }).duplicate).toBe(false)
    expect(ledger.record('a', { value: 2 })).toEqual({ value: { value: 1 }, duplicate: true })
    ledger.record('b', { value: 2 })
    ledger.record('c', { value: 3 })
    expect(ledger.size).toBe(2)
    expect(ledger.get('a')).toBeUndefined()
    expect(ledger.get('b')).toEqual({ value: 2 })
  })
})
