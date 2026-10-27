import type { ConfirmInput } from './run.ts'

export type IngressEvent =
  | { seq: number; kind: 'stop' }
  | { seq: number; kind: 'confirm'; input: ConfirmInput }

/** Stable ingress ordering for a single behavior run. */
export class IngressQueue {
  private nextSeq = 1
  private readonly events: IngressEvent[] = []

  enqueue(event: Omit<IngressEvent, 'seq'>): IngressEvent {
    const queued = { ...event, seq: this.nextSeq++ } as IngressEvent
    this.events.push(queued)
    return queued
  }

  get size(): number {
    return this.events.length
  }

  drain(): IngressEvent[] {
    const ordered = [...this.events].sort((left, right) => left.seq - right.seq)
    this.events.length = 0
    return ordered
  }
}
