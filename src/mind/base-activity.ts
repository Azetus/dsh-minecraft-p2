import type {
  BaseActivityKind,
  BaseActivityView,
  BaseWaitingReason,
} from '../contracts/protocol.ts'
import { isRecord } from '../contracts/protocol.ts'
import type { Vec3 } from '../port/index.ts'

/** A whole-block cell; the controller never keeps a floating-point position. */
export type BaseCell = { x: number; y: number; z: number }

export type BaseActivitySpec =
  | { kind: 'idle' }
  | { kind: 'wandering'; radius: number }
  | { kind: 'escort'; target: string; distance: number }

const DEFAULT_WANDER_RADIUS = 8
const DEFAULT_ESCORT_DISTANCE = 3
/** The core stand query caps its reach at this value. */
const MAX_BASE_RADIUS = 8
const MAX_TARGET_NAME = 64

/**
 * The permanent default behaviour of the body. It is deliberately in-memory:
 * a body restart recreates the controller and therefore starts in the default
 * `idle` state instead of restoring an Agent choice. The Agent must explicitly
 * select `wandering` or `escort`; a fresh/restarted body never walks away from
 * its spawn or last position on its own.
 *
 * The controller only holds intent and anchor state. Target selection belongs
 * to the `base.work` giver; this class never reads the world.
 */
export class BaseActivityController {
  private kind: BaseActivityKind = 'idle'
  private params: BaseActivityView['params'] = {}
  private state: BaseActivityView['state'] = 'inactive'
  private waiting: BaseWaitingReason | null = null
  private anchorCell: BaseCell | undefined
  private nextDecisionAt = 0
  private seq = 0

  /** Validate and store an Agent choice. An active controller re-anchors. */
  set(input: unknown, now: number, feet?: Vec3): BaseActivityView {
    const spec = parseBaseActivity(input)
    this.kind = spec.kind
    this.params = paramsOf(spec)
    this.waiting = null
    this.seq += 1
    if (this.state === 'active' && feet !== undefined) {
      this.anchorCell = cellOf(feet)
      this.nextDecisionAt = now + 500
    }
    return this.view()
  }

  /** First activation is a takeover: the current feet cell becomes the anchor. */
  activate(now: number, feet: Vec3): boolean {
    if (this.state === 'active') return false
    this.state = 'active'
    this.waiting = null
    this.anchorCell = cellOf(feet)
    this.nextDecisionAt = now + 500
    this.seq += 1
    return true
  }

  deactivate(_reason: string): boolean {
    if (this.state === 'inactive') return false
    this.state = 'inactive'
    this.waiting = null
    return true
  }

  isActive(): boolean {
    return this.state === 'active'
  }

  view(): BaseActivityView {
    return {
      kind: this.kind,
      state: this.state,
      params: { ...this.params },
      waitingReason: this.waiting,
    }
  }

  anchor(): BaseCell | undefined {
    return this.anchorCell === undefined ? undefined : { ...this.anchorCell }
  }

  shouldDecide(now: number): boolean {
    return now >= this.nextDecisionAt
  }

  nextSequence(): number {
    this.seq += 1
    return this.seq
  }

  /** A completed wander earns a short break before the next pick. */
  noteArrival(now: number): void {
    this.nextDecisionAt = now + 4_000
  }

  /** Repeated selection or move failure backs off instead of spinning. */
  noteFailure(now: number): void {
    this.nextDecisionAt = now + 10_000
  }

  scheduleNext(now: number, delayMs: number): void {
    this.nextDecisionAt = now + Math.max(0, delayMs)
  }

  /** Body-side move outcome; escort needs a shorter cadence than wandering. */
  noteMoveResult(kind: 'wandering' | 'escort', ok: boolean, now: number): void {
    const delay = kind === 'wandering' ? (ok ? 4_000 : 10_000) : (ok ? 750 : 2_000)
    this.nextDecisionAt = now + delay
  }

  /** Returns true only on the transition into waiting, so the body reports once. */
  markWaiting(reason: BaseWaitingReason, now: number): boolean {
    this.nextDecisionAt = now + 1_000
    if (this.waiting === reason) return false
    this.waiting = reason
    return true
  }

  clearWaiting(now: number): boolean {
    if (this.waiting === null) return false
    this.waiting = null
    this.nextDecisionAt = now + 250
    return true
  }

  /** Escort target name, when the current activity is escort. */
  escortTarget(): string | undefined {
    return this.kind === 'escort' ? this.params.target : undefined
  }
}

export function parseBaseActivity(input: unknown): BaseActivitySpec {
  if (!isRecord(input)) throw new Error('base activity must be an object')
  const kind = input.kind
  if (kind === 'idle') {
    rejectUnknown(input, ['kind'], 'base activity')
    return { kind: 'idle' }
  }
  if (kind === 'wandering') {
    rejectUnknown(input, ['kind', 'radius'], 'base activity')
    const radius = input.radius === undefined
      ? DEFAULT_WANDER_RADIUS
      : integer(input.radius, 1, MAX_BASE_RADIUS, 'base activity.radius')
    return { kind: 'wandering', radius }
  }
  if (kind === 'escort') {
    rejectUnknown(input, ['kind', 'target', 'distance'], 'base activity')
    if (typeof input.target !== 'string' || input.target.trim().length === 0) {
      throw new Error('base activity.target is required for escort')
    }
    const target = input.target.trim()
    if (target.length > MAX_TARGET_NAME) {
      throw new Error(`base activity.target must be at most ${MAX_TARGET_NAME} characters`)
    }
    const distance = input.distance === undefined
      ? DEFAULT_ESCORT_DISTANCE
      : integer(input.distance, 1, MAX_BASE_RADIUS, 'base activity.distance')
    return { kind: 'escort', target, distance }
  }
  throw new Error('base activity.kind must be idle, wandering or escort')
}

function paramsOf(spec: BaseActivitySpec): BaseActivityView['params'] {
  if (spec.kind === 'wandering') return { radius: spec.radius }
  if (spec.kind === 'escort') return { target: spec.target, distance: spec.distance }
  return {}
}

function cellOf(pos: Vec3): BaseCell {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not supported`)
  }
}
