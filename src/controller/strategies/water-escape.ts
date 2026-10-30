/**
 * Water escape strategy (M1, S0): the classic "dig into water and drown" case.
 *
 * It is an emergency strategy, not core logic: the controller only knows that
 * an S0 hazard is present and that the proposed action owns the lease until the
 * hazard is gone. The hazard is also written to bounded action memory so the
 * same spot is remembered after recovery.
 */

import type { Strategy, StrategyContext, StrategyVerdict } from '../strategy.ts'
import { asRecord, readPosition } from './reading.ts'

export type WaterEscapeOptions = {
  key?: string
  version?: string
  /** Act artifact that performs the escape (swim up / break to air). */
  act: string
  oxygenBelow?: number
  /** Retries before the emergency branch reports blocked instead of guessing. */
  maxAttempts?: number
}

const FACT_POSITION = 'position'
const FACT_HEALTH = 'health'

export function createWaterEscapeStrategy(options: WaterEscapeOptions): Strategy {
  const key = options.key ?? 'water-escape'
  const version = options.version ?? '1'
  const oxygenBelow = options.oxygenBelow ?? 80
  const maxAttempts = options.maxAttempts ?? 2

  return {
    key,
    version,
    slot: 'S0',
    hazardClass: 'lethal',
    evaluate(context: StrategyContext): StrategyVerdict {
      const facts = context.facts([FACT_POSITION, FACT_HEALTH])
      if (facts.unknown.length > 0) return { kind: 'unknown', missing: facts.unknown }
      const position = readPosition(facts.values[FACT_POSITION])
      if (position === undefined) return { kind: 'unknown', missing: [`${FACT_POSITION}.x`] }
      if (typeof position.inWater !== 'boolean') return { kind: 'unknown', missing: [`${FACT_POSITION}.inWater`] }

      // Oxygen comes from the health query, not the position query.
      const health = asRecord(facts.values[FACT_HEALTH])
      const oxygen = typeof health?.oxygen === 'number' ? health.oxygen : undefined
      const drowning = position.inWater && (oxygen === undefined || oxygen <= oxygenBelow)
      const lowOxygen = oxygen !== undefined && oxygen <= oxygenBelow
      const hazard = drowning || lowOxygen
      if (!hazard) return { kind: 'idle' }

      const hazardId = `water:${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
      context.memory.recordHazard({
        hazardId,
        kind: 'water',
        area: { x: position.x, y: position.y, z: position.z, radius: 3 },
        at: context.now,
        ...(position.dimension === undefined ? {} : { dimension: position.dimension }),
      })

      if (context.activeAction?.intent.startsWith('escape-water')) {
        return { kind: 'running', intent: context.activeAction.intent, progress: { step: 'escaping' } }
      }

      const attempts = context.memory.failuresFor('escape-water', context.now, 60_000).length
      if (attempts >= maxAttempts) {
        return {
          kind: 'blocked',
          missing: [],
          since: context.now,
          diagnostics: [context.diagnostic('ESCAPE_FAILED', 'water escape failed repeatedly', {
            attempts,
            hazardId,
            oxygen: oxygen ?? null,
          })],
        }
      }
      return context.propose('escape-water', options.act, {
        reason: drowning ? 'drowning' : 'low-oxygen',
        hazardId,
        y: position.y,
      })
    },
  }
}



