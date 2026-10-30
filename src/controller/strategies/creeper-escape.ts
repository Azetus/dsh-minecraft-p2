/**
 * Creeper avoidance strategy (M3, S0): the second hazard class proves the
 * reuse claim — it is content only, and the controller core stays unchanged.
 */

import type { Strategy, StrategyContext, StrategyVerdict } from '../strategy.ts'
import { distanceBetween, readEntities, readPosition } from './reading.ts'

export type CreeperEscapeOptions = {
  key?: string
  version?: string
  act: string
  /** Distance at which the creeper counts as lethal. */
  dangerDistance?: number
  maxAttempts?: number
}

const FACT_POSITION = 'position'
const FACT_ENTITIES = 'entities'

export function createCreeperEscapeStrategy(options: CreeperEscapeOptions): Strategy {
  const key = options.key ?? 'creeper-escape'
  const version = options.version ?? '1'
  const dangerDistance = options.dangerDistance ?? 6
  const maxAttempts = options.maxAttempts ?? 2

  return {
    key,
    version,
    slot: 'S0',
    hazardClass: 'lethal',
    evaluate(context: StrategyContext): StrategyVerdict {
      const facts = context.facts([FACT_POSITION, FACT_ENTITIES])
      if (facts.unknown.length > 0) return { kind: 'unknown', missing: facts.unknown }
      const position = readPosition(facts.values[FACT_POSITION])
      if (position === undefined) return { kind: 'unknown', missing: [`${FACT_POSITION}.x`] }
      const entities = readEntities(facts.values[FACT_ENTITIES])
      if (entities === undefined) return { kind: 'unknown', missing: [FACT_ENTITIES] }

      const creeper = entities
        .filter(entity => entity.name.toLowerCase().includes('creeper'))
        .map(entity => ({ entity, distance: entity.distance ?? distanceBetween(position, entity) }))
        .filter(entry => entry.distance <= dangerDistance)
        .sort((left, right) => left.distance - right.distance)[0]
      if (creeper === undefined) return { kind: 'idle' }

      const hazardId = `creeper:${creeper.entity.id ?? `${Math.round(creeper.entity.x)},${Math.round(creeper.entity.z)}`}`
      context.memory.recordHazard({
        hazardId,
        kind: 'creeper',
        area: { x: creeper.entity.x, y: creeper.entity.y, z: creeper.entity.z, radius: dangerDistance },
        at: context.now,
        ...(position.dimension === undefined ? {} : { dimension: position.dimension }),
      })

      if (context.activeAction?.intent.startsWith('retreat-creeper')) {
        return { kind: 'running', intent: context.activeAction.intent, progress: { step: 'retreating' } }
      }
      const attempts = context.memory.failuresFor('retreat-creeper', context.now, 60_000).length
      if (attempts >= maxAttempts) {
        return {
          kind: 'blocked',
          missing: [],
          since: context.now,
          diagnostics: [context.diagnostic('RETREAT_FAILED', 'creeper retreat failed repeatedly', {
            attempts,
            hazardId,
            distance: creeper.distance,
          })],
        }
      }
      return context.propose('retreat-creeper', options.act, {
        from: { x: creeper.entity.x, y: creeper.entity.y, z: creeper.entity.z },
        distance: dangerDistance,
      })
    },
  }
}


