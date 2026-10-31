import type { JsonValue } from '../contracts/types.ts'

export type MindEvent = {
  seq: number
  at: number
  kind: string
  data: JsonValue
}

/** Bounded in-memory event ring; seq keeps increasing across drops. */
export class MindEvents {
  private items: MindEvent[] = []
  private nextSeq = 1

  constructor(private readonly capacity = 500) {}

  push(kind: string, at: number, data: JsonValue): MindEvent {
    const event: MindEvent = { seq: this.nextSeq, at, kind, data }
    this.nextSeq += 1
    this.items.push(event)
    if (this.items.length > this.capacity) this.items.shift()
    return event
  }

  since(seq: number, limit = 100): MindEvent[] {
    return this.items.filter(event => event.seq > seq).slice(0, limit)
  }

  lastSeq(): number {
    return this.nextSeq - 1
  }
}
