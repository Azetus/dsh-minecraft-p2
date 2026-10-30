/**
 * Harvest task strategy (M1): walk to the nearest target block, dig it, and
 * use the commitment baseline to prove *newly* produced items.
 *
 * Content, not core: all Minecraft knowledge (which block, which act, reach)
 * lives in the options. The controller only sees intents and a completion
 * candidate backed by the inventory fact.
 */

import type { JsonValue } from '../../contracts/types.ts'
import { countItem } from '../commitment.ts'
import type { Strategy, StrategyContext, StrategyVerdict } from '../strategy.ts'
import { asRecord, distanceBetween, readBlocks, readPosition } from './reading.ts'

export type HarvestOptions = {
  key?: string
  version?: string
  /** Item counted for progress and the completion candidate (`stone`). */
  item: string
  /** Block name to mine (`stone`). */
  target: string
  /** Default count when the commitment post is not a count condition. */
  count: number
  reach?: number
  gotoAct?: string
  digAct?: string
}

const FACT_POSITION = 'position'
const FACT_INVENTORY = 'inventory'
const FACT_BLOCKS = 'nearbyBlocks'

type Checkpoint = {
  target?: { x: number; y: number; z: number }
  arrived?: boolean
  done: string[]
}

export function createHarvestStrategy(options: HarvestOptions): Strategy {
  const key = options.key ?? 'harvest'
  const version = options.version ?? '1'
  const reach = options.reach ?? 4
  const gotoAct = options.gotoAct ?? 'goto'
  const digAct = options.digAct ?? 'dig'

  return {
    key,
    version,
    slot: 'S2',
    evaluate(context: StrategyContext): StrategyVerdict {
      const commitment = context.commitment
      if (commitment === undefined) return { kind: 'idle' }

      const facts = context.facts([FACT_POSITION, FACT_INVENTORY, FACT_BLOCKS])
      if (facts.unknown.length > 0) return { kind: 'unknown', missing: facts.unknown }

      const position = readPosition(facts.values[FACT_POSITION])
      if (position === undefined) return { kind: 'unknown', missing: [`${FACT_POSITION}.x`] }

      const required = commitment.post.kind === 'count-at-least' ? commitment.post.count : options.count
      const have = countItem(facts.values[FACT_INVENTORY] as JsonValue, options.item) ?? 0
      const baselineValue = commitment.baseline.values[FACT_INVENTORY]
      const had = baselineValue === undefined ? 0 : countItem(baselineValue, options.item) ?? 0
      if (have - had >= required) {
        return { kind: 'candidate-complete', evidence: [context.evidence(FACT_INVENTORY)] }
      }

      const checkpoint = readCheckpoint(commitment.checkpoint)
      const active = context.activeAction
      if (active !== undefined && (active.intent.startsWith('goto:') || active.intent.startsWith('dig:'))) {
        return { kind: 'running', intent: active.intent, progress: { step: active.intent } }
      }

      let target = checkpoint.target
      let arrived = checkpoint.arrived === true
      const done = checkpoint.done

      const last = context.lastOutcome
      if (target !== undefined && last !== undefined) {
        const id = pointId(target)
        if (last.intent === `dig:${id}`) {
          if (last.status === 'succeeded') {
            done.push(id)
            target = undefined
            arrived = false
          } else if (context.memory.failuresFor(`dig:${id}`, context.now, 120_000).length >= 2) {
            target = undefined
            arrived = false
          }
        }
        if (last.intent === `goto:${id}` && last.status === 'succeeded') arrived = true
        if (last.status === 'failed' && last.intent === `goto:${id}` && context.memory.failuresFor(last.intent, context.now, 120_000).length >= 2) {
          target = undefined
          arrived = false
        }
      }

      if (target === undefined) {
        const blocks = readBlocks(facts.values[FACT_BLOCKS])
        if (blocks === undefined) return { kind: 'unknown', missing: [FACT_BLOCKS] }
        const candidates = blocks
          .filter(block => block.name === options.target)
          .filter(block => !done.includes(`${block.x},${block.y},${block.z}`))
          .filter(block => context.memory.failuresFor(`dig:${block.x},${block.y},${block.z}`, context.now, 120_000).length < 2)
        const nearest = candidates
          .map(block => ({ block, distance: distanceBetween(position, block) }))
          .sort((left, right) => left.distance - right.distance)[0]
        if (nearest === undefined) {
          return {
            kind: 'blocked',
            missing: [FACT_BLOCKS],
            since: context.now,
            diagnostics: [context.diagnostic('NO_TARGET', `no reachable ${options.target} in observation`, { done })],
          }
        }
        target = { x: nearest.block.x, y: nearest.block.y, z: nearest.block.z }
        arrived = false
      }

      const boundedDone = done.slice(-8)
      const distance = distanceBetween(position, target)
      const id = pointId(target)
      const shouldGoto = distance > reach && !arrived
      if (shouldGoto) {
        context.saveCheckpoint({ target, arrived: false, done: boundedDone } as unknown as JsonValue)
        return context.propose(`goto:${id}`, gotoAct, { x: target.x, y: target.y, z: target.z, range: reach })
      }
      context.saveCheckpoint({ target, arrived: true, done: boundedDone } as unknown as JsonValue)
      return context.propose(`dig:${id}`, digAct, { x: target.x, y: target.y, z: target.z })
    },
  }
}

function readCheckpoint(value: JsonValue): Checkpoint {
  const record = asRecord(value)
  if (record === undefined) return { done: [] }
  const target = asRecord(record.target)
  const done = Array.isArray(record.done) ? record.done.filter(item => typeof item === 'string') as string[] : []
  return {
    done,
    ...(target !== undefined
      && typeof target.x === 'number'
      && typeof target.y === 'number'
      && typeof target.z === 'number'
      ? { target: { x: target.x, y: target.y, z: target.z } } : {}),
    ...(record.arrived === true ? { arrived: true } : {}),
  }
}

function pointId(point: { x: number; y: number; z: number }): string {
  return `${point.x},${point.y},${point.z}`
}

