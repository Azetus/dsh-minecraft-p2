import type { JsonValue, LocalSlot, ValueMeta } from '../contracts/types.ts'

/** A mutable local frame owned by one behavior instance or subtree call. */
export class LocalFrame {
  private readonly values: Map<string, LocalSlot>

  constructor(
    initial: Map<string, JsonValue> | Iterable<[string, JsonValue]> = [],
    meta: ValueMeta = { source: 'initial', scope: 'frame', sampledAt: 0 },
  ) {
    this.values = new Map()
    const entries = initial instanceof Map ? [...initial.entries()] : [...initial]
    for (const [name, value] of entries) this.values.set(name, { value, meta })
  }

  has(name: string): boolean {
    return this.values.has(name)
  }

  get(name: string): JsonValue | undefined {
    return this.values.get(name)?.value
  }

  getSlot(name: string): LocalSlot | undefined {
    return this.values.get(name)
  }

  set(name: string, value: JsonValue, meta?: ValueMeta): void {
    this.values.set(name, {
      value,
      meta: meta ?? { source: 'assign', scope: 'frame', sampledAt: 0 },
    })
  }

  setSlot(name: string, slot: LocalSlot): void {
    this.values.set(name, slot)
  }

  entries(): Array<[string, JsonValue]> {
    return [...this.values.entries()].map(([name, slot]) => [name, slot.value])
  }

  slotEntries(): Array<[string, LocalSlot]> {
    return [...this.values.entries()]
  }

  clone(): LocalFrame {
    const copy = new LocalFrame()
    for (const [name, slot] of this.values) copy.setSlot(name, slot)
    return copy
  }
}

export function frameFrom(
  locals: Record<string, { initial?: JsonValue }>,
  scope = 'behavior',
): LocalFrame {
  const values = new Map<string, JsonValue>()
  for (const [name, spec] of Object.entries(locals)) {
    if (spec.initial !== undefined) values.set(name, spec.initial)
  }
  return new LocalFrame(values, { source: 'initial', scope, sampledAt: 0 })
}
