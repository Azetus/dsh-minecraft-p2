import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { p2Error } from '../contracts/protocol.ts'
import type { JsonValue, P2Error } from '../contracts/types.ts'
import { parseHazardPolicy } from '../port/terrain.ts'
import { parseConflictPolicy, parseMaterialPolicy } from './policy.ts'

/** The finite execution surface: goals, not per-CP scripts. */
export const ORDER_VERBS = [
  'go',
  'place',
  'dig',
  'equip',
  'use',
  'attack',
  'check',
  'container',
  'craft',
  'build',
  'traverse',
  'hold',
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
  | { kind: 'journal.legacy-accepted'; at: number; defVersion: string }

/** A driver action written before it starts; it is reconciled, never replayed. */
export type PendingAction = {
  runId: string
  driverId: string
  keys: string
  orderId?: string
  planId?: string
  workItemId?: string
}

export type RecoveryIdentity = {
  worldId: string
  characterId: string
  defVersion: string
  /** `plans` means defVersion hashes plan templates only; absent is legacy. */
  defScope?: 'plans'
}

export const JOURNAL_VERSION = 1

export type OrderStoreOptions = {
  /** JSONL intent journal. Without it the store is memory-only (tests). */
  journalPath?: string
  /** Recovery identity; a mismatch with the journal header refuses recovery. */
  identity?: RecoveryIdentity
  now?: () => number
  onEvent?: (event: OrderEvent) => void
}

type JournalEntry =
  | { v?: number; at: number; kind: 'journal.identity'; identity: RecoveryIdentity }
  | { v?: number; at: number; kind: 'order.accepted'; order: Order }
  | { v?: number; at: number; kind: 'order.terminal'; orderId: string; state: OrderState }
  | { v?: number; at: number; kind: 'action.pending'; action: PendingAction }
  | { v?: number; at: number; kind: 'action.settled'; runId: string; state: string; code?: string }

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
  private readonly identity: RecoveryIdentity | undefined
  private readonly now: () => number
  private readonly onEvent: ((event: OrderEvent) => void) | undefined
  private readonly records = new Map<string, OrderRecord>()
  private readonly acceptedOrder: string[] = []
  private readonly pending = new Map<string, PendingAction>()
  private headerSeen = false
  private rewriteHeader = false
  private activeId: string | undefined

  constructor(options: OrderStoreOptions = {}) {
    this.journalPath = options.journalPath
    this.identity = options.identity
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
    const entries: JournalEntry[] = []
    for (const line of lines) {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw journalError('journal line is not valid JSON')
      }
      const entry = parsed as Partial<JournalEntry>
      if (entry.v !== undefined && entry.v !== JOURNAL_VERSION) {
        throw journalVersionError(`journal version ${String(entry.v)} is not ${JOURNAL_VERSION}`)
      }
      if (entry.kind !== 'journal.identity' && entry.kind !== 'order.accepted'
        && entry.kind !== 'order.terminal' && entry.kind !== 'action.pending'
        && entry.kind !== 'action.settled') {
        throw journalError(`journal entry is invalid: ${line.slice(0, 120)}`)
      }
      if (entry.kind === 'journal.identity' && !isRecoveryIdentity(entry.identity)) {
        throw journalError('journal identity is invalid')
      }
      entries.push(entry as JournalEntry)
    }

    // Validate identity before applying any entry, so a mismatched journal
    // cannot partially mutate the in-memory store. The last identity entry
    // wins: a legacy header is accepted once by world/character and the next
    // append writes the plan-only header.
    let header: Extract<JournalEntry, { kind: 'journal.identity' }> | undefined
    for (const entry of entries) {
      if (entry.kind === 'journal.identity') header = entry
    }
    if (header !== undefined) {
      if (this.identity !== undefined && !sameIdentity(header.identity, this.identity)) {
        throw identityError(
          `journal identity mismatch: ${header.identity.worldId}/${header.identity.characterId}/${header.identity.defVersion}`,
        )
      }
      this.headerSeen = true
      if (header.identity.defScope === undefined && this.identity?.defScope === 'plans') {
        this.rewriteHeader = true
        this.onEvent?.({ kind: 'journal.legacy-accepted', at: this.now(), defVersion: header.identity.defVersion })
      }
    }

    for (const entry of entries) {
      if (entry.kind === 'journal.identity') continue
      if (entry.kind === 'order.accepted' && isOrder(entry.order)) {
        this.applyAccepted(entry.order, typeof entry.at === 'number' ? entry.at : this.now())
      } else if (entry.kind === 'order.terminal'
        && typeof entry.orderId === 'string'
        && isTerminalState(entry.state)) {
        this.applyTerminal(entry.orderId, entry.state, typeof entry.at === 'number' ? entry.at : this.now())
      } else if (entry.kind === 'action.pending' && isPendingAction(entry.action)) {
        this.pending.set(entry.action.runId, entry.action)
      } else if (entry.kind === 'action.settled' && typeof entry.runId === 'string') {
        this.pending.delete(entry.runId)
      } else {
        throw journalError('journal entry is invalid')
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

  pendingActions(): PendingAction[] {
    return [...this.pending.values()]
  }

  recordActionPending(action: PendingAction): void {
    if (this.pending.has(action.runId)) return
    const at = this.now()
    this.appendJournal({ at, kind: 'action.pending', action })
    this.pending.set(action.runId, action)
  }

  recordActionSettled(runId: string, state: string, code?: string): void {
    if (!this.pending.has(runId)) return
    const at = this.now()
    this.appendJournal({ at, kind: 'action.settled', runId, state, ...(code === undefined ? {} : { code }) })
    this.pending.delete(runId)
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
      if (this.identity !== undefined && (!this.headerSeen || this.rewriteHeader)) {
        writeSync(fd, `${JSON.stringify({
          v: JOURNAL_VERSION,
          at: this.now(),
          kind: 'journal.identity',
          identity: this.identity,
        })}\n`)
        this.headerSeen = true
        this.rewriteHeader = false
      }
      writeSync(fd, `${JSON.stringify({ ...entry, v: JOURNAL_VERSION })}\n`)
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
  if (value.verb === 'traverse') validateTraverseParams(value.params)
  if (value.verb === 'dig') validateDigParams(value.params)
  if (value.verb === 'place') validatePlaceParams(value.params)
  if (value.verb === 'equip') validateEquipParams(value.params)
  if (value.verb === 'use') validateUseParams(value.params)
  if (value.verb === 'craft') validateCraftParams(value.params)
  if (value.verb === 'container') validateContainerParams(value.params)
  if (value.policy !== undefined) {
    const conflict = parseConflictPolicy(value.policy)
    if (!conflict.ok) throw orderError('INVALID_ORDER', conflict.error)
    const materials = parseMaterialPolicy(value.policy)
    if (!materials.ok) throw orderError('INVALID_ORDER', materials.error)
    const hazards = parseHazardPolicy((value.policy as Record<string, unknown>).hazards)
    if (hazards === null) {
      throw orderError('INVALID_ORDER', 'policy.hazards must be {allow:["void"|"lethal_fall"|"lava"], reason?}')
    }
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

/** Material and geometry are mandatory at call time; no implicit material. */
function validateTraverseParams(params: JsonValue | undefined): void {
  if (!isRecord(params)) {
    throw orderError('INVALID_ORDER', 'traverse requires params {mode,x,y,z,item}')
  }
  if (params.mode !== 'bridge' && params.mode !== 'scaffold') {
    throw orderError('INVALID_ORDER', 'traverse.mode must be bridge or scaffold')
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    if (typeof params[axis] !== 'number' || !Number.isFinite(params[axis])) {
      throw orderError('INVALID_ORDER', `traverse.${axis} must be a finite number`)
    }
  }
  if (typeof params.item !== 'string' || params.item.trim().length === 0) {
    throw orderError('INVALID_ORDER', 'traverse.item (the material block) is required')
  }
  const maxBlocks = params.maxBlocks
  if (maxBlocks !== undefined
    && (typeof maxBlocks !== 'number' || !Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 64)) {
    throw orderError('INVALID_ORDER', 'traverse.maxBlocks must be an integer between 1 and 64')
  }
}

function requirePosition(params: Record<string, JsonValue>, verb: string): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    if (typeof params[axis] !== 'number' || !Number.isFinite(params[axis])) {
      throw orderError('INVALID_ORDER', `${verb}.${axis} must be a finite number`)
    }
  }
}

function validateDigParams(params: JsonValue | undefined): void {
  if (!isRecord(params)) throw orderError('INVALID_ORDER', 'dig requires params {x,y,z,purpose?}')
  requirePosition(params, 'dig')
  if (params.purpose !== undefined && params.purpose !== 'clear' && params.purpose !== 'harvest') {
    throw orderError('INVALID_ORDER', 'dig.purpose must be clear or harvest')
  }
}

function validatePlaceParams(params: JsonValue | undefined): void {
  if (!isRecord(params)) throw orderError('INVALID_ORDER', 'place requires params {x,y,z,item}')
  requirePosition(params, 'place')
  if (typeof params.item !== 'string' || params.item.trim().length === 0) {
    throw orderError('INVALID_ORDER', 'place.item is required')
  }
  if (params.face !== undefined
    && !['up', 'down', 'north', 'south', 'east', 'west'].includes(String(params.face))) {
    throw orderError('INVALID_ORDER', 'place.face must be up/down/north/south/east/west')
  }
  if (params.expectedState !== undefined && !isRecord(params.expectedState)) {
    throw orderError('INVALID_ORDER', 'place.expectedState must be an object')
  }
}

function validateEquipParams(params: JsonValue | undefined): void {
  if (!isRecord(params) || typeof params.item !== 'string' || params.item.trim().length === 0) {
    throw orderError('INVALID_ORDER', 'equip.item is required')
  }
}

function validateUseParams(params: JsonValue | undefined): void {
  if (!isRecord(params)) throw orderError('INVALID_ORDER', 'use requires a target or item')
  const hasPosition = params.x !== undefined || params.y !== undefined || params.z !== undefined
  if (hasPosition) requirePosition(params, 'use')
  const hasItem = typeof params.item === 'string' && params.item.trim().length > 0
  if (!hasPosition && !hasItem) throw orderError('INVALID_ORDER', 'use requires a target or item')
  if (params.durationMs !== undefined
    && (typeof params.durationMs !== 'number' || !Number.isFinite(params.durationMs) || params.durationMs < 0)) {
    throw orderError('INVALID_ORDER', 'use.durationMs must be non-negative')
  }
}

function validateCraftParams(params: JsonValue | undefined): void {
  if (!isRecord(params) || typeof params.item !== 'string' || params.item.trim().length === 0) {
    throw orderError('INVALID_ORDER', 'craft.item is required')
  }
  if (params.count !== undefined
    && (typeof params.count !== 'number' || !Number.isInteger(params.count) || params.count < 1 || params.count > 64)) {
    throw orderError('INVALID_ORDER', 'craft.count must be an integer between 1 and 64')
  }
}

function validateContainerParams(params: JsonValue | undefined): void {
  if (!isRecord(params)) throw orderError('INVALID_ORDER', 'container requires params')
  requirePosition(params, 'container')
  if (typeof params.item !== 'string' || params.item.trim().length === 0) {
    throw orderError('INVALID_ORDER', 'container.item is required')
  }
  if (typeof params.action !== 'string'
    || !['withdraw', 'deposit', 'load-input', 'load-fuel', 'take-input', 'take-fuel', 'take-output']
      .includes(params.action)) {
    throw orderError('INVALID_ORDER', 'container.action is invalid')
  }
  if (params.count !== undefined
    && (typeof params.count !== 'number' || !Number.isInteger(params.count) || params.count < 1 || params.count > 64)) {
    throw orderError('INVALID_ORDER', 'container.count must be an integer between 1 and 64')
  }
}

function isOrder(value: unknown): value is Order {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.verb === 'string'
    && (ORDER_VERBS as readonly string[]).includes(value.verb)
}

function isPendingAction(value: unknown): value is PendingAction {
  if (!isRecord(value)) return false
  return typeof value.runId === 'string'
    && typeof value.driverId === 'string'
    && typeof value.keys === 'string'
}

function isRecoveryIdentity(value: unknown): value is RecoveryIdentity {
  return isRecord(value)
    && typeof value.worldId === 'string'
    && typeof value.characterId === 'string'
    && typeof value.defVersion === 'string'
    && (value.defScope === undefined || value.defScope === 'plans')
}

function sameIdentity(left: RecoveryIdentity, right: RecoveryIdentity): boolean {
  if (left.worldId !== right.worldId || left.characterId !== right.characterId) return false
  if (left.defScope === 'plans' && right.defScope === 'plans') {
    return left.defVersion === right.defVersion
  }
  // A header written before plan-only identity (no defScope) is accepted once;
  // the next append writes the new header. A plan-scoped header never falls
  // back to the legacy world/character-only check.
  if (left.defScope === undefined && right.defScope === 'plans') return true
  return left.defScope === right.defScope
}

function identityError(message: string): P2Error {
  return p2Error('RECOVERY_IDENTITY_MISMATCH', 'validation', message, { module: 'mind.journal' })
}

function journalVersionError(message: string): P2Error {
  return p2Error('JOURNAL_VERSION_MISMATCH', 'validation', message, { module: 'mind.journal' })
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
