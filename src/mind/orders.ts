import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { parseConflictPolicy, parseMaterialPolicy } from './policy.ts'

export const ORDER_VERBS = [
  'shelter',
  'build',
  'bed',
  'tools',
  'mine_copper',
  'smelt',
  'gather',
  'eat',
  'sleep',
  'go',
  'follow',
  'hold',
  'wander',
] as const

export type OrderVerb = (typeof ORDER_VERBS)[number]

export type Order = {
  id: string
  verb: OrderVerb
  params?: Record<string, JsonValue>
  constraints?: JsonValue
  budget?: { maxTicks?: number; maxDeaths?: number }
  blueprint?: JsonValue
  /** Agent-authored execution policy; unknown keys are rejected. */
  policy?: JsonValue
}

export type OrderState =
  | 'queued'
  | 'active'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'abandoned'

export type OrderRecord = {
  order: Order
  state: OrderState
  acceptedAt: number
  terminalAt?: number
}

export type OrderEvent =
  | { kind: 'order.accepted'; at: number; orderId: string }
  | { kind: 'order.terminal'; at: number; orderId: string; state: OrderState }

export type OrderStoreOptions = {
  /** JSONL intent journal. Without it the store is memory-only (tests). */
  journalPath?: string
  now?: () => number
  onEvent?: (event: OrderEvent) => void
}

type JournalEntry =
  | { at: number; kind: 'order.accepted'; order: Order }
  | { at: number; kind: 'order.terminal'; orderId: string; state: OrderState }

const TERMINAL_STATES: ReadonlySet<OrderState> = new Set([
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
  'abandoned',
])

/**
 * One active order at a time; later orders queue. Every accept/terminal is
 * written to the intent journal before memory changes, and cancel is terminal:
 * a cancelled order is never revived by replay.
 */
export class OrderStore {
  private readonly journalPath: string | undefined
  private readonly now: () => number
  private readonly onEvent: ((event: OrderEvent) => void) | undefined
  private readonly records = new Map<string, OrderRecord>()
  private readonly acceptedOrder: string[] = []
  private activeId: string | undefined

  constructor(options: OrderStoreOptions = {}) {
    this.journalPath = options.journalPath
    this.now = options.now ?? (() => Date.now())
    this.onEvent = options.onEvent
  }

  /** Replay the journal; a trailing partial line is discarded. */
  restore(): void {
    if (this.journalPath === undefined) return
    let text: string
    try {
      text = readFileSync(this.journalPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const lines = text.split('\n')
    if (!text.endsWith('\n')) lines.pop()
    for (const line of lines) {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw journalError('journal line is not valid JSON')
      }
      const entry = parsed as Partial<JournalEntry>
      if (entry.kind === 'order.accepted' && isOrder(entry.order)) {
        this.applyAccepted(entry.order, typeof entry.at === 'number' ? entry.at : this.now())
      } else if (entry.kind === 'order.terminal'
        && typeof entry.orderId === 'string'
        && isTerminalState(entry.state)) {
        this.applyTerminal(entry.orderId, entry.state, typeof entry.at === 'number' ? entry.at : this.now())
      } else {
        throw journalError(`journal entry is invalid: ${line.slice(0, 120)}`)
      }
    }
    this.promote()
  }

  enqueue(order: unknown): OrderRecord {
    const validated = validateOrder(order)
    if (this.records.has(validated.id)) {
      throw orderError('ORDER_EXISTS', `order already exists: ${validated.id}`)
    }
    const at = this.now()
    this.appendJournal({ at, kind: 'order.accepted', order: validated })
    this.applyAccepted(validated, at)
    this.promote()
    const record = this.records.get(validated.id) as OrderRecord
    this.onEvent?.({ kind: 'order.accepted', at, orderId: validated.id })
    return record
  }

  cancel(id: string): OrderRecord {
    const record = this.records.get(id)
    if (record === undefined || isTerminalState(record.state)) {
      throw orderError('ORDER_NOT_FOUND', `no active order: ${id}`)
    }
    return this.terminate(id, 'cancelled')
  }

  complete(id: string, state: Exclude<OrderState, 'queued' | 'active' | 'cancelled'>): OrderRecord {
    const record = this.records.get(id)
    if (record === undefined || isTerminalState(record.state)) {
      throw orderError('ORDER_NOT_FOUND', `no active order: ${id}`)
    }
    return this.terminate(id, state)
  }

  active(): OrderRecord | undefined {
    return this.activeId === undefined ? undefined : this.records.get(this.activeId)
  }

  queued(): OrderRecord[] {
    return this.acceptedOrder
      .map(id => this.records.get(id) as OrderRecord)
      .filter(record => record.state === 'queued')
  }

  all(): OrderRecord[] {
    return this.acceptedOrder.map(id => this.records.get(id) as OrderRecord)
  }

  get(id: string): OrderRecord | undefined {
    return this.records.get(id)
  }

  private terminate(
    id: string,
    state: Exclude<OrderState, 'queued' | 'active'>,
  ): OrderRecord {
    const at = this.now()
    this.appendJournal({ at, kind: 'order.terminal', orderId: id, state })
    this.applyTerminal(id, state, at)
    this.promote()
    this.onEvent?.({ kind: 'order.terminal', at, orderId: id, state })
    return this.records.get(id) as OrderRecord
  }

  private applyAccepted(order: Order, at: number): void {
    if (this.records.has(order.id)) return
    this.records.set(order.id, { order, state: 'queued', acceptedAt: at })
    this.acceptedOrder.push(order.id)
  }

  private applyTerminal(id: string, state: OrderState, at: number): void {
    const record = this.records.get(id)
    if (record === undefined) return
    record.state = state
    record.terminalAt = at
    if (this.activeId === id) this.activeId = undefined
  }

  private promote(): void {
    if (this.activeId !== undefined) return
    for (const id of this.acceptedOrder) {
      const record = this.records.get(id)
      if (record !== undefined && record.state === 'queued') {
        record.state = 'active'
        this.activeId = id
        return
      }
    }
  }

  private appendJournal(entry: JournalEntry): void {
    const path = this.journalPath
    if (path === undefined) return
    mkdirSync(dirname(path), { recursive: true })
    const fd = openSync(path, 'a')
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

function validateOrder(value: unknown): Order {
  if (!isRecord(value)) throw orderError('INVALID_ORDER', 'order must be an object')
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw orderError('INVALID_ORDER', 'order id must be a non-empty string')
  }
  if (typeof value.verb !== 'string' || !(ORDER_VERBS as readonly string[]).includes(value.verb)) {
    throw orderError('INVALID_ORDER', `unsupported order verb: ${String(value.verb)}`)
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw orderError('INVALID_ORDER', 'order params must be an object')
  }
  if (value.policy !== undefined) {
    const conflict = parseConflictPolicy(value.policy)
    if (!conflict.ok) throw orderError('INVALID_ORDER', conflict.error)
    const materials = parseMaterialPolicy(value.policy)
    if (!materials.ok) throw orderError('INVALID_ORDER', materials.error)
  }
  if (value.budget !== undefined) {
    if (!isRecord(value.budget)) throw orderError('INVALID_ORDER', 'order budget must be an object')
    for (const key of ['maxTicks', 'maxDeaths'] as const) {
      const amount = value.budget[key]
      if (amount !== undefined && (typeof amount !== 'number' || amount < 0)) {
        throw orderError('INVALID_ORDER', `budget.${key} must be a non-negative number`)
      }
    }
  }
  return value as unknown as Order
}

function isOrder(value: unknown): value is Order {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.verb === 'string'
    && (ORDER_VERBS as readonly string[]).includes(value.verb)
}

function isTerminalState(value: unknown): value is OrderState {
  return typeof value === 'string' && TERMINAL_STATES.has(value as OrderState)
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function orderError(code: string, message: string): P2Error {
  return p2Error(code, 'validation', message, { module: 'mind.orders' })
}

function journalError(message: string): P2Error {
  return p2Error('JOURNAL_CORRUPT', 'validation', message, { module: 'mind.journal' })
}
