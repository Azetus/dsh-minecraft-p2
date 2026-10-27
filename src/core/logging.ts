import { appendFile, rename, rm, stat } from 'node:fs/promises'

import type { JsonValue } from '../contracts/types.ts'

export type DebugLogEntry = Record<string, JsonValue>

export type DebugLogOptions = {
  filePath: string
  maxBuffer?: number
  maxBytes?: number
}

/** Asynchronous JSONL debug sink with a bounded queue and one rotated file. */
export class DebugLog {
  private readonly filePath: string
  private readonly maxBuffer: number
  private readonly maxBytes: number
  private queue: DebugLogEntry[] = []
  private dropped = 0
  private unavailable = false
  private flushPromise: Promise<void> | undefined
  private scheduled = false

  constructor(options: DebugLogOptions) {
    this.filePath = options.filePath
    this.maxBuffer = options.maxBuffer ?? 1000
    this.maxBytes = options.maxBytes ?? 1_000_000
  }

  get droppedCount(): number {
    return this.dropped
  }

  get loggingUnavailable(): boolean {
    return this.unavailable
  }

  get pending(): number {
    return this.queue.length
  }

  log(entry: DebugLogEntry): boolean {
    if (this.unavailable) {
      this.dropped += 1
      return false
    }
    if (this.queue.length >= this.maxBuffer) {
      this.dropped += 1
      return false
    }
    this.queue.push(entry)
    if (!this.scheduled) {
      this.scheduled = true
      setImmediate(() => {
        this.scheduled = false
        void this.flush()
      })
    }
    return true
  }

  flush(): Promise<void> {
    if (this.flushPromise !== undefined) return this.flushPromise
    this.flushPromise = this.drain().finally(() => {
      this.flushPromise = undefined
    })
    return this.flushPromise
  }

  async close(): Promise<void> {
    await this.flush()
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, 100)
      const text = batch.map(entry => `${JSON.stringify(entry)}\n`).join('')
      try {
        await this.rotateIfNeeded(Buffer.byteLength(text))
        await appendFile(this.filePath, text, 'utf8')
      } catch {
        this.unavailable = true
        this.dropped += this.queue.length + batch.length
        this.queue = []
        return
      }
    }
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size = 0
    try {
      size = (await stat(this.filePath)).size
    } catch {
      size = 0
    }
    if (size === 0 || size + incomingBytes <= this.maxBytes) return
    await rm(`${this.filePath}.1`, { force: true })
    await rename(this.filePath, `${this.filePath}.1`)
  }
}

export type LedgerEntry<T> = {
  value: T
  sequence: number
}

/** In-memory command dedup; M1 deliberately does not survive a restart. */
export class CommandLedger<T = JsonValue> {
  private readonly entries = new Map<string, LedgerEntry<T>>()
  private sequence = 0
  private readonly maxEntries: number

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries
  }

  get size(): number {
    return this.entries.size
  }

  record(commandId: string, value: T): { value: T; duplicate: boolean } {
    const existing = this.entries.get(commandId)
    if (existing !== undefined) return { value: existing.value, duplicate: true }
    this.sequence += 1
    this.entries.set(commandId, { value, sequence: this.sequence })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return { value, duplicate: false }
  }

  get(commandId: string): T | undefined {
    return this.entries.get(commandId)?.value
  }
}
