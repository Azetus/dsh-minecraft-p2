import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { formatTarget } from './target.ts'
import type { McTarget } from './target.ts'

/** One machine-local claim on a Minecraft server target. */
export type BodyLockInfo = {
  version: 1
  lockId: string
  host: string
  port: number
  ownerSessionId: string
  agentId: string
  bridgePid: number
  bodyPid?: number
  bodyEpoch?: string
  startedAt: number
  heartbeatAt: number
}

export type BodyLockConflict = {
  lock: BodyLockInfo
  /** A body pid that survived the stale cleanup attempt. */
  staleBodyPid?: number
}

export type BodyLockHandle = {
  readonly info: BodyLockInfo
  update(patch: { bodyPid?: number; bodyEpoch?: string }): Promise<void>
  heartbeat(): Promise<void>
  release(): Promise<void>
}

export type BodyLockStoreOptions = {
  dir?: string
  now?: () => number
  /** A lock without a heartbeat for this long is stale. */
  staleMs?: number
  /** How long to wait for an orphan body pid to exit after SIGTERM. */
  bodyExitGraceMs?: number
  isPidAlive?: (pid: number) => boolean
  terminatePid?: (pid: number) => void
}

export const DEFAULT_BODY_LOCK_DIR = join(homedir(), '.dsh', 'p2', 'body-locks')
export const DEFAULT_LOCK_STALE_MS = 30_000

export class BodyLockConflictError extends Error {
  readonly conflict: BodyLockConflict

  constructor(conflict: BodyLockConflict) {
    const lock = conflict.lock
    super(
      `P2 body is already running at ${formatTarget({ host: lock.host, port: lock.port })} `
      + `(owner session ${lock.ownerSessionId}, since ${new Date(lock.startedAt).toISOString()}); `
      + 'refusing to start a second body',
    )
    this.name = 'BodyLockConflictError'
    this.conflict = conflict
  }
}

/**
 * Cross-process single-body claim keyed by MC target. The file is created with
 * `wx` so two DSH processes cannot both win; a stale bridge pid or heartbeat
 * lets the next start take the lock over after a crash.
 */
export class BodyLockStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly staleMs: number
  private readonly bodyExitGraceMs: number
  private readonly isPidAlive: (pid: number) => boolean
  private readonly terminatePid: (pid: number) => void

  constructor(options: BodyLockStoreOptions = {}) {
    this.dir = options.dir ?? process.env.P2_BODY_LOCK_DIR ?? DEFAULT_BODY_LOCK_DIR
    this.now = options.now ?? Date.now
    this.staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS
    this.bodyExitGraceMs = options.bodyExitGraceMs ?? 1000
    this.isPidAlive = options.isPidAlive ?? pidAlive
    this.terminatePid = options.terminatePid ?? (pid => {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // The pid may already be gone.
      }
    })
  }

  async acquire(
    target: McTarget,
    meta: { ownerSessionId: string; agentId: string; bridgePid: number },
  ): Promise<{ handle: BodyLockHandle } | { conflict: BodyLockConflict }> {
    await mkdir(this.dir, { recursive: true })
    const path = this.pathFor(target)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const info: BodyLockInfo = {
        version: 1,
        lockId: randomUUID(),
        host: target.host,
        port: target.port,
        ownerSessionId: meta.ownerSessionId,
        agentId: meta.agentId,
        bridgePid: meta.bridgePid,
        startedAt: this.now(),
        heartbeatAt: this.now(),
      }
      if (await this.tryCreate(path, info)) return { handle: this.handleFor(path, info) }

      const current = await this.read(path)
      if (current === undefined) continue
      if (!(await this.isStale(current))) {
        return { conflict: { lock: current } }
      }
      const staleBodyPid = await this.clearStale(current)
      if (staleBodyPid !== undefined) return { conflict: { lock: current, staleBodyPid } }
    }
    const current = await this.read(path)
    return current === undefined
      ? { conflict: { lock: this.emptyConflict(target, meta) } }
      : { conflict: { lock: current } }
  }

  /** Read the claim without changing it, for status/observability. */
  async inspect(target: McTarget): Promise<BodyLockInfo | undefined> {
    return await this.read(this.pathFor(target))
  }

  /** Every readable claim in the lock directory. */
  async list(): Promise<BodyLockInfo[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const locks: BodyLockInfo[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const lock = await this.read(join(this.dir, name))
      if (lock !== undefined) locks.push(lock)
    }
    return locks
  }

  private handleFor(path: string, initial: BodyLockInfo): BodyLockHandle {
    const store = this
    const info = { ...initial }
    return {
      get info() {
        return info
      },
      async update(patch) {
        if (patch.bodyPid !== undefined) info.bodyPid = patch.bodyPid
        if (patch.bodyEpoch !== undefined) info.bodyEpoch = patch.bodyEpoch
        info.heartbeatAt = store.now()
        await store.write(path, info)
      },
      async heartbeat() {
        info.heartbeatAt = store.now()
        await store.write(path, info)
      },
      async release() {
        const current = await store.read(path)
        if (current?.lockId !== info.lockId) return
        try {
          await unlink(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      },
    }
  }

  private async tryCreate(path: string, info: BodyLockInfo): Promise<boolean> {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }

  private async read(path: string): Promise<BodyLockInfo | undefined> {
    try {
      const text = await readFile(path, 'utf8')
      const parsed = JSON.parse(text) as Partial<BodyLockInfo>
      if (parsed.version !== 1 || typeof parsed.lockId !== 'string'
        || typeof parsed.host !== 'string' || typeof parsed.port !== 'number'
        || typeof parsed.bridgePid !== 'number' || typeof parsed.startedAt !== 'number'
        || typeof parsed.heartbeatAt !== 'number') return undefined
      return parsed as BodyLockInfo
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  private async write(path: string, info: BodyLockInfo): Promise<void> {
    try {
      await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async isStale(lock: BodyLockInfo): Promise<boolean> {
    if (!this.isPidAlive(lock.bridgePid)) return true
    return this.now() - lock.heartbeatAt > this.staleMs
  }

  /**
   * Remove a stale claim. If the old bridge is gone but its body pid is still
   * alive, ask the body to exit and wait briefly; returning a pid means it
   * survived and the caller must not claim the target yet.
   */
  private async clearStale(lock: BodyLockInfo): Promise<number | undefined> {
    const bodyPid = lock.bodyPid
    if (bodyPid !== undefined && bodyPid !== process.pid && this.isPidAlive(bodyPid)) {
      this.terminatePid(bodyPid)
      const deadline = this.now() + this.bodyExitGraceMs
      while (this.now() < deadline) {
        if (!this.isPidAlive(bodyPid)) break
        await delay(50)
      }
      if (this.isPidAlive(bodyPid)) return bodyPid
    }
    try {
      await unlink(this.pathFor(lock))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return undefined
  }

  private pathFor(target: McTarget): string {
    const key = createHash('sha256')
      .update(`${target.host.toLowerCase()}|${target.port}`)
      .digest('hex')
      .slice(0, 32)
    return join(this.dir, `${key}.json`)
  }

  private emptyConflict(
    target: McTarget,
    meta: { ownerSessionId: string; agentId: string; bridgePid: number },
  ): BodyLockInfo {
    return {
      version: 1,
      lockId: 'unknown',
      host: target.host,
      port: target.port,
      ownerSessionId: meta.ownerSessionId,
      agentId: meta.agentId,
      bridgePid: meta.bridgePid,
      startedAt: this.now(),
      heartbeatAt: this.now(),
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
