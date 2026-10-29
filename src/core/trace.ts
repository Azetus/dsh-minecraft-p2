import type {
  TraceEvent,
  TraceKind,
  TraceParams,
  TracePhase,
  TraceResult,
  TraceStats,
} from '../contracts/protocol.ts'
import type { JsonValue } from '../contracts/types.ts'

export type TraceContext = {
  runId?: string
  actId?: string
  opId?: string
  detail?: JsonValue
}

export type TraceToken = {
  kind: TraceKind
  name: string
  startedAt: number
  context: TraceContext
}

export type TraceSinkOptions = {
  /** Retained events; older events are evicted and counted as dropped. */
  capacity?: number
  now?: () => number
}

const DEFAULT_CAPACITY = 2048
const KINDS: readonly TraceKind[] = ['run', 'behavior', 'act', 'op', 'guard', 'watch']

/**
 * Bounded developer trace. Recording is synchronous and allocation-light; the
 * ring never buffers more than `capacity` events, and every API is total (it
 * never throws) so tracing cannot change a run's outcome.
 */
export class TraceSink {
  private readonly events: TraceEvent[] = []
  private readonly capacity: number
  private readonly now: () => number
  private sequence = 0
  private droppedCount = 0

  constructor(options: TraceSinkOptions = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY))
    this.now = options.now ?? Date.now
  }

  /** Start a span; finish it with `finish` to emit a duration. */
  begin(kind: TraceKind, name: string, context: TraceContext = {}): TraceToken {
    return { kind, name, startedAt: this.now(), context }
  }

  finish(token: TraceToken | undefined, phase: Extract<TracePhase, 'end' | 'error'>, detail?: JsonValue): void {
    if (token === undefined) return
    this.push({
      kind: token.kind,
      phase,
      name: token.name,
      at: token.startedAt,
      durationMs: Math.max(0, this.now() - token.startedAt),
      ...token.context,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  /** Record a one-shot event; `durationMs` is optional. */
  record(
    kind: TraceKind,
    phase: TracePhase,
    name: string,
    context: TraceContext & { durationMs?: number } = {},
  ): void {
    const { durationMs, ...rest } = context
    this.push({
      kind,
      phase,
      name,
      at: this.now(),
      ...(durationMs === undefined ? {} : { durationMs: Math.max(0, durationMs) }),
      ...rest,
    })
  }

  read(filter: TraceParams = {}): TraceResult {
    const matching = this.events.filter(event => matches(event, filter))
    const retainedFirst = this.events[0]?.seq
    const gap = filter.sinceSeq !== undefined
      && retainedFirst !== undefined
      && filter.sinceSeq < retainedFirst - 1
    const limited = filter.limit === undefined
      ? matching
      : matching.slice(Math.max(0, matching.length - Math.max(0, Math.floor(filter.limit))))
    return {
      events: limited.map(event => ({ ...event, ...(event.detail === undefined ? {} : { detail: event.detail }) })),
      stats: statsOf(matching),
      dropped: this.droppedCount,
      capacity: this.capacity,
      seq: this.sequence,
      gap,
    }
  }

  get dropped(): number {
    return this.droppedCount
  }

  get size(): number {
    return this.events.length
  }

  clear(): void {
    this.events.length = 0
  }

  private push(input: Omit<TraceEvent, 'seq'>): void {
    this.sequence += 1
    this.events.push({ ...input, seq: this.sequence })
    while (this.events.length > this.capacity) {
      this.events.shift()
      this.droppedCount += 1
    }
  }
}

function matches(event: TraceEvent, filter: TraceParams): boolean {
  if (filter.kind !== undefined && event.kind !== filter.kind) return false
  if (filter.runId !== undefined && event.runId !== filter.runId) return false
  if (filter.sinceSeq !== undefined && event.seq <= filter.sinceSeq) return false
  if (filter.act !== undefined && (event.kind !== 'act' || event.name !== filter.act)) return false
  if (filter.op !== undefined && (event.kind !== 'op' || event.name !== filter.op)) return false
  return true
}

function statsOf(events: TraceEvent[]): Partial<Record<TraceKind, TraceStats>> {
  const result: Partial<Record<TraceKind, TraceStats>> = {}
  for (const kind of KINDS) {
    const durations = events
      .filter(event => event.kind === kind && event.durationMs !== undefined)
      .map(event => event.durationMs as number)
      .sort((left, right) => left - right)
    if (durations.length === 0) continue
    result[kind] = {
      count: durations.length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations[durations.length - 1] as number,
    }
  }
  return result
}

/** Nearest-rank percentile over a sorted array. */
function percentile(sorted: number[], rank: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1))
  return sorted[index] as number
}
