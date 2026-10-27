import type { JsonValue } from '../contracts/types.ts'

/** A mutable local frame owned by one behavior instance or subtree call. */
export class LocalFrame {
  private readonly values: Map<string, JsonValue>

  constructor(initial: Map<string, JsonValue> | Iterable<[string, JsonValue]> = []) {
    this.values = initial instanceof Map ? new Map(initial) : new Map(initial)
  }

  has(name: string): boolean {
    return this.values.has(name)
  }

  get(name: string): JsonValue | undefined {
    return this.values.get(name)
  }

  set(name: string, value: JsonValue): void {
    this.values.set(name, value)
  }

  entries(): Array<[string, JsonValue]> {
    return [...this.values.entries()]
  }

  clone(): LocalFrame {
    return new LocalFrame(this.values)
  }
}

export function frameFrom(
  locals: Record<string, { initial?: JsonValue }>,
): LocalFrame {
  const values = new Map<string, JsonValue>()
  for (const [name, spec] of Object.entries(locals)) {
    if (spec.initial !== undefined) values.set(name, spec.initial)
  }
  return new LocalFrame(values)
}
