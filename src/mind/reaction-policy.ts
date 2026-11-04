import type {
  ReactionFightPolicy,
  ReactionPolicyView,
  SelfCarePolicy,
} from '../contracts/protocol.ts'
import { isRecord } from '../contracts/protocol.ts'
import type { EntityInfo } from '../port/index.ts'
import { HOSTILE_NAMES } from './givers/common.ts'

/** Neutral mobs that minecraft-data may label as hostile. Auto-fight never picks them. */
export const NEUTRAL_NAMES: ReadonlySet<string> = new Set([
  'enderman',
  'spider',
  'cave_spider',
  'piglin',
  'zombified_piglin',
])

/** Self-destructive auto-fight targets; explicit attack orders can still name them. */
export const AUTO_AVOID_NAMES: ReadonlySet<string> = new Set([
  'creeper',
  'wither',
  'ender_dragon',
  'warden',
])

export type ReactionPolicy = {
  fight: ReactionFightPolicy | null
  selfCare: SelfCarePolicy
}

export const DEFAULT_SELF_CARE: SelfCarePolicy = {
  eat: { enabled: true, foodBelow: 14 },
  retreat: { enabled: true, healthBelow: 8 },
  unstuck: { enabled: true },
}

const MAX_TARGETS = 32
const MAX_RADIUS = 16
const MAX_LEASH = 32

export function defaultReactionPolicy(): ReactionPolicy {
  return { fight: null, selfCare: cloneSelfCare(DEFAULT_SELF_CARE) }
}

/**
 * Parse the `reaction` object. `set` replaces the whole policy; an omitted
 * `fight` means flee-only, and an explicit empty `allowedTargets` means all
 * adapter-classified hostiles minus the neutral and auto-avoid sets.
 */
export function parseReactionPolicy(input: unknown): ReactionPolicy {
  if (!isRecord(input)) throw new Error('reaction must be an object')
  for (const key of Object.keys(input)) {
    if (key !== 'fight' && key !== 'selfCare') throw new Error(`reaction.${key} is not supported`)
  }
  const fight = parseFight(input.fight)
  const selfCare = input.selfCare === undefined
    ? cloneSelfCare(DEFAULT_SELF_CARE)
    : parseSelfCare(input.selfCare)
  return { fight, selfCare }
}

function parseFight(value: unknown): ReactionFightPolicy | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw new Error('reaction.fight must be an object')
  for (const key of Object.keys(value)) {
    if (!['allowedTargets', 'retreatHealth', 'radius', 'leash'].includes(key)) {
      throw new Error(`reaction.fight.${key} is unknown`)
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'allowedTargets')) {
    throw new Error('reaction.fight.allowedTargets is required (use [] for all hostiles)')
  }
  if (!Array.isArray(value.allowedTargets)) throw new Error('reaction.fight.allowedTargets must be an array')
  if (value.allowedTargets.length > MAX_TARGETS) {
    throw new Error(`reaction.fight.allowedTargets must contain at most ${MAX_TARGETS} names`)
  }
  const allowedTargets: string[] = []
  for (const entry of value.allowedTargets) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error('reaction.fight.allowedTargets must contain non-empty entity names')
    }
    const name = normalizeName(entry)
    if (name === 'player') throw new Error('reaction.fight.allowedTargets cannot include players')
    if (NEUTRAL_NAMES.has(name)) {
      throw new Error(`reaction.fight.allowedTargets cannot include neutral target: ${name}`)
    }
    if (AUTO_AVOID_NAMES.has(name)) {
      throw new Error(`reaction.fight.allowedTargets cannot include auto-avoid target: ${name}`)
    }
    if (!allowedTargets.includes(name)) allowedTargets.push(name)
  }
  const retreatHealth = integer(value.retreatHealth, 0, 20, 'reaction.fight.retreatHealth', 8)
  const radius = integer(value.radius, 1, MAX_RADIUS, 'reaction.fight.radius', 8)
  const leash = integer(value.leash, 1, MAX_LEASH, 'reaction.fight.leash', 12)
  if (leash < radius) throw new Error('reaction.fight.leash must be >= reaction.fight.radius')
  return { allowedTargets, retreatHealth, radius, leash }
}

function parseSelfCare(value: unknown): SelfCarePolicy {
  if (!isRecord(value)) throw new Error('reaction.selfCare must be an object')
  for (const key of Object.keys(value)) {
    if (!['eat', 'retreat', 'unstuck'].includes(key)) throw new Error(`reaction.selfCare.${key} is unknown`)
  }
  const defaults = cloneSelfCare(DEFAULT_SELF_CARE)
  return {
    eat: parseEat(value.eat, defaults.eat),
    retreat: parseRetreat(value.retreat, defaults.retreat),
    unstuck: parseUnstuck(value.unstuck, defaults.unstuck),
  }
}

function parseEat(value: unknown, fallback: SelfCarePolicy['eat']): SelfCarePolicy['eat'] {
  if (value === undefined) return fallback
  if (!isRecord(value)) throw new Error('reaction.selfCare.eat must be an object')
  for (const key of Object.keys(value)) {
    if (!['enabled', 'foodBelow'].includes(key)) throw new Error(`reaction.selfCare.eat.${key} is unknown`)
  }
  return {
    enabled: boolean(value.enabled, 'reaction.selfCare.eat.enabled', fallback.enabled),
    foodBelow: integer(value.foodBelow, 0, 20, 'reaction.selfCare.eat.foodBelow', fallback.foodBelow),
  }
}

function parseRetreat(value: unknown, fallback: SelfCarePolicy['retreat']): SelfCarePolicy['retreat'] {
  if (value === undefined) return fallback
  if (!isRecord(value)) throw new Error('reaction.selfCare.retreat must be an object')
  for (const key of Object.keys(value)) {
    if (!['enabled', 'healthBelow'].includes(key)) throw new Error(`reaction.selfCare.retreat.${key} is unknown`)
  }
  return {
    enabled: boolean(value.enabled, 'reaction.selfCare.retreat.enabled', fallback.enabled),
    healthBelow: integer(value.healthBelow, 0, 20, 'reaction.selfCare.retreat.healthBelow', fallback.healthBelow),
  }
}

function parseUnstuck(value: unknown, fallback: SelfCarePolicy['unstuck']): SelfCarePolicy['unstuck'] {
  if (value === undefined) return fallback
  if (!isRecord(value)) throw new Error('reaction.selfCare.unstuck must be an object')
  for (const key of Object.keys(value)) {
    if (key !== 'enabled') throw new Error(`reaction.selfCare.unstuck.${key} is unknown`)
  }
  return { enabled: boolean(value.enabled, 'reaction.selfCare.unstuck.enabled', fallback.enabled) }
}

export function reactionPolicyView(policy: ReactionPolicy, source: 'default' | 'agent', updatedAt?: number): ReactionPolicyView {
  return {
    source,
    mode: policy.fight === null
      ? 'flee'
      : policy.fight.allowedTargets.length === 0 ? 'all-hostiles' : 'allowlist',
    fight: policy.fight === null ? null : { ...policy.fight, allowedTargets: [...policy.fight.allowedTargets] },
    selfCare: cloneSelfCare(policy.selfCare),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/** One process-local policy; a body restart creates the default flee-only state. */
export class ReactionPolicyState {
  private policy = defaultReactionPolicy()
  private source: 'default' | 'agent' = 'default'
  private updatedAt: number | undefined

  set(input: unknown, now: number): ReactionPolicyView {
    const next = parseReactionPolicy(input)
    this.policy = next
    this.source = 'agent'
    this.updatedAt = now
    return this.view()
  }

  reset(now: number): ReactionPolicyView {
    this.policy = defaultReactionPolicy()
    this.source = 'default'
    this.updatedAt = now
    return this.view()
  }

  get(): ReactionPolicy {
    return {
      fight: this.policy.fight === null
        ? null
        : { ...this.policy.fight, allowedTargets: [...this.policy.fight.allowedTargets] },
      selfCare: cloneSelfCare(this.policy.selfCare),
    }
  }

  view(): ReactionPolicyView {
    return reactionPolicyView(this.policy, this.source, this.updatedAt)
  }
}

/** Whether the automatic fight giver may acquire this entity. */
export function isAutoFightTarget(entity: EntityInfo, policy: ReactionPolicy): boolean {
  const fight = policy.fight
  if (fight === null) return false
  if (entity.type === 'player' || /player/i.test(entity.kind ?? '')) return false
  if (/passive|neutral|tameable/i.test(entity.kind ?? '')) return false
  const name = normalizeName(entity.name)
  if (NEUTRAL_NAMES.has(name)) return false
  if (AUTO_AVOID_NAMES.has(name)) return false
  const hostile = HOSTILE_NAMES.has(name)
    || entity.type === 'hostile'
    || /hostile/i.test(entity.kind ?? '')
  if (!hostile) return false
  return fight.allowedTargets.length === 0 || fight.allowedTargets.includes(name)
}

export function normalizeName(name: string): string {
  return name.replace(/^minecraft:/u, '').trim().toLowerCase()
}

function cloneSelfCare(value: SelfCarePolicy): SelfCarePolicy {
  return {
    eat: { ...value.eat },
    retreat: { ...value.retreat },
    unstuck: { ...value.unstuck },
  }
}

function integer(value: unknown, min: number, max: number, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function boolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}
