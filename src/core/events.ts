import type { JsonValue } from '../contracts/types.ts'

export type RuntimeEvent = {
  eventId: string
  seq: number
  kind: string
  data: JsonValue
}

export type EventDrain = {
  events: RuntimeEvent[]
  gap: boolean
}

/** Bounded current-epoch event buffer with id dedup and explicit gap reporting. */
export class EventQueue {
  private readonly events: RuntimeEvent[] = []
  private readonly seen = new Set<string>()
  private readonly max: number
  private dropped = 0
  private gap = false
  private nextSeq = 1

  constructor(max = 256) {
    this.max = max
  }

  get droppedCount(): number {
    return this.dropped
  }

  push(event: RuntimeEvent): 'accepted' | 'duplicate' | 'gap' {
    if (this.seen.has(event.eventId)) return 'duplicate'
    if (event.seq < this.nextSeq || this.events.some(existing => existing.seq === event.seq)) {
      this.dropped += 1
      this.gap = true
      return 'gap'
    }
    this.seen.add(event.eventId)
    this.events.push(event)
    this.nextSeq = Math.max(this.nextSeq, event.seq + 1)
    if (this.events.length > this.max) {
      const removed = this.events.shift()
      if (removed !== undefined) this.seen.delete(removed.eventId)
      this.dropped += 1
      this.gap = true
    }
    return 'accepted'
  }

  drain(): EventDrain {
    const events = this.events.splice(0)
    const gap = this.gap
    this.gap = false
    this.seen.clear()
    return { events, gap }
  }
}
