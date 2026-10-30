/**
 * Follow-owner strategy (M3): a second task strategy, here a *standing*
 * commitment (follow / stay near). It has no natural success terminal — the
 * controller keeps it until it is cancelled or blocked, which is exactly the
 * C2 `standing` case.
 */

import type { Strategy, StrategyContext, StrategyVerdict } from '../strategy.ts'
import { distanceBetween, readEntities, readPosition } from './reading.ts'

export type FollowOwnerOptions = {
  key?: string
  version?: string
  act?: string
  /** Entity name of the player to follow. */
  owner: string
  distance?: number
  maxDistance?: number
}

const FACT_POSITION = 'position'
const FACT_ENTITIES = 'entities'

export function createFollowOwnerStrategy(options: FollowOwnerOptions): Strategy {
  const key = options.key ?? 'follow-owner'
  const version = options.version ?? '1'
  const act = options.act ?? 'goto'
  const followDistance = options.distance ?? 3
  const maxDistance = options.maxDistance ?? 32

  return {
    key,
    version,
    slot: 'S2',
    evaluate(context: StrategyContext): StrategyVerdict {
      const facts = context.facts([FACT_POSITION, FACT_ENTITIES])
      if (facts.unknown.length > 0) return { kind: 'unknown', missing: facts.unknown }
      const position = readPosition(facts.values[FACT_POSITION])
      if (position === undefined) return { kind: 'unknown', missing: [`${FACT_POSITION}.x`] }
      const entities = readEntities(facts.values[FACT_ENTITIES])
      if (entities === undefined) return { kind: 'unknown', missing: [FACT_ENTITIES] }

      const owner = entities.find(entity => entity.name === options.owner)
      if (owner === undefined) return { kind: 'unknown', missing: [`${FACT_ENTITIES}.${options.owner}`] }

      const distance = distanceBetween(position, owner)
      if (distance > maxDistance) {
        return {
          kind: 'blocked',
          missing: [],
          since: context.now,
          diagnostics: [context.diagnostic('FOLLOW_OUT_OF_RANGE', `owner is ${Math.round(distance)} blocks away`, {
            owner: options.owner,
            distance,
          })],
        }
      }
      if (distance <= followDistance) {
        return { kind: 'running', intent: 'follow:hold', progress: { step: 'near-owner' } }
      }
      if (context.activeAction?.intent.startsWith('follow:')) {
        return { kind: 'running', intent: context.activeAction.intent, progress: { step: 'following' } }
      }
      return context.propose(`follow:${options.owner}`, act, {
        x: owner.x,
        y: owner.y,
        z: owner.z,
        range: followDistance,
      })
    },
  }
}
