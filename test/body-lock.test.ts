import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BodyLockStore } from '../src/bridge/body-lock.ts'

const dirs: string[] = []

function lockDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-lock-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const target = { host: '127.0.0.1', port: 25575 }
const meta = { ownerSessionId: 'session-1', agentId: 'agent-1', bridgePid: 111 }

describe('body lock', () => {
  it('lets one owner claim a target and releases it explicitly', async () => {
    const store = new BodyLockStore({ dir: lockDir(), isPidAlive: () => true, terminatePid: () => {} })
    const first = await store.acquire(target, meta)
    if (!('handle' in first)) throw new Error('expected the first claim to win')

    const second = await store.acquire(target, { ...meta, ownerSessionId: 'session-2' })
    expect('conflict' in second && second.conflict.lock.ownerSessionId).toBe('session-1')
    expect(await store.list()).toHaveLength(1)

    await first.handle.release()
    const third = await store.acquire(target, { ...meta, ownerSessionId: 'session-2' })
    expect('handle' in third && third.handle.info.ownerSessionId).toBe('session-2')
    await (third as { handle: { release(): Promise<void> } }).handle.release()
  })

  it('takes over a stale heartbeat without deleting the new claim', async () => {
    let now = 1_000
    const store = new BodyLockStore({
      dir: lockDir(),
      now: () => now,
      staleMs: 1_000,
      isPidAlive: () => true,
      terminatePid: () => {},
    })
    const first = await store.acquire(target, meta)
    if (!('handle' in first)) throw new Error('expected the first claim to win')
    now += 5_000

    const second = await store.acquire(target, { ...meta, ownerSessionId: 'session-2' })
    if (!('handle' in second)) throw new Error('expected the stale claim to be replaced')
    expect(second.handle.info.ownerSessionId).toBe('session-2')

    // The old handle must not unlink the new lock.
    await first.handle.release()
    expect((await store.inspect(target))?.ownerSessionId).toBe('session-2')
    await second.handle.release()
  })

  it('asks a stale orphan body to exit before taking the lock', async () => {
    let now = 1_000
    let bodyAlive = true
    const terminated: number[] = []
    const store = new BodyLockStore({
      dir: lockDir(),
      now: () => now,
      staleMs: 1_000,
      bodyExitGraceMs: 20,
      isPidAlive: pid => pid === 222 ? bodyAlive : false,
      terminatePid: pid => {
        terminated.push(pid)
        bodyAlive = false
      },
    })
    const first = await store.acquire(target, meta)
    if (!('handle' in first)) throw new Error('expected the first claim to win')
    await first.handle.update({ bodyPid: 222, bodyEpoch: 'epoch-1' })
    now += 5_000

    const second = await store.acquire(target, { ...meta, ownerSessionId: 'session-2' })
    expect('handle' in second).toBe(true)
    expect(terminated).toEqual([222])
    await (second as { handle: { release(): Promise<void> } }).handle.release()
  })
})
