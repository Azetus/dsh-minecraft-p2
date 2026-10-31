import type { ChatMessage } from '../contracts/protocol.ts'

/**
 * Merge nearby chat messages into one wake. A single message waits one
 * debounce window; a continuous stream is forced out after maxWaitMs so it
 * cannot starve the Agent forever.
 */
export class ChatBatcher {
  private pending: ChatMessage[] = []
  private firstAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly flush: (messages: ChatMessage[]) => void,
    private readonly debounceMs = 1_000,
    private readonly maxWaitMs = 3_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  add(message: ChatMessage): void {
    this.pending.push(message)
    const at = this.now()
    if (this.firstAt === 0) this.firstAt = at
    if (this.timer !== undefined) clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - (at - this.firstAt)))
    this.timer = setTimeout(() => this.flushNow(), wait)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = []
    this.firstAt = 0
  }

  private flushNow(): void {
    this.timer = undefined
    if (this.pending.length === 0) return
    const batch = this.pending.splice(0)
    this.firstAt = 0
    this.flush(batch)
  }
}
