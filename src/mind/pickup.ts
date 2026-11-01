import type { ClientPort, EntityInfo, Vec3 } from '../port/index.ts'
import { nearestStandableCell } from './approach.ts'

export type PickupResult = {
  drops: number
  picked: number
  unreachable: number
  notCollected: number
  observed: {
    kind: 'pickup'
    drops: number
    picked: number
    unreachable: number
    notCollected: number
  }
}

const MAX_DROPS = 4
const PICKUP_WAIT_MS = 1_500
const MOVE_TIMEOUT_MS = 5_000

/**
 * Walk to item entities dropped by the block this job just removed. The
 * driver owns the target; this only collects what is already there.
 */
export async function pickupNearby(port: ClientPort, center: Vec3): Promise<PickupResult> {
  const box = {
    min: { x: center.x - 6, y: center.y - 3, z: center.z - 6 },
    max: { x: center.x + 6, y: center.y + 4, z: center.z + 6 },
  }
  const drops = port.entities(box)
    .filter(isDrop)
    .filter(entity => Math.hypot(entity.position.x - center.x, entity.position.y - center.y,
      entity.position.z - center.z) <= 5)
    .slice(0, MAX_DROPS)

  let before = totalCount(port.inventory())
  const start = before
  let picked = 0
  let unreachable = 0
  let notCollected = 0
  for (const drop of drops) {
    const moved = await port.moveTo(drop.position, {
      range: 1,
      intent: 'interact',
      timeoutMs: MOVE_TIMEOUT_MS,
    })
    let after = totalCount(port.inventory())
    if (moved.state !== 'ok') {
      if (after > before) {
        picked += after - before
        before = after
        continue
      }
      const stand = nearestStandableCell(port, drop.position)
      if (stand === undefined) {
        unreachable += 1
        continue
      }
      const retry = await port.moveTo(stand, {
        range: 1,
        intent: 'interact',
        timeoutMs: MOVE_TIMEOUT_MS,
      })
      after = totalCount(port.inventory())
      if (retry.state !== 'ok' || after <= before) {
        if (after > before) {
          picked += after - before
          before = after
        } else {
          unreachable += 1
        }
        continue
      }
    }
    after = await waitForIncrease(port, before)
    if (after > before) {
      picked += after - before
      before = after
      continue
    }
    // The coarse move can stop just outside pickup range. Try a tighter stop
    // before calling the drop not-collected.
    const closer = await port.moveTo(drop.position, {
      range: 0.5,
      intent: 'interact',
      timeoutMs: MOVE_TIMEOUT_MS,
    })
    if (closer.state === 'ok') after = await waitForIncrease(port, before)
    if (after > before) {
      picked += after - before
      before = after
    } else {
      notCollected += 1
    }
  }

  // Items can be picked up automatically while a move is in flight; the
  // inventory delta is the authority, not the per-drop bookkeeping.
  const finalCount = totalCount(port.inventory())
  const auto = finalCount - start
  if (auto > picked) picked = auto

  return {
    drops: drops.length,
    picked,
    unreachable,
    notCollected,
    observed: { kind: 'pickup', drops: drops.length, picked, unreachable, notCollected },
  }
}

function isDrop(entity: EntityInfo): boolean {
  return entity.item !== undefined || entity.name === 'item' || entity.name === 'item_stack'
}

async function waitForIncrease(port: ClientPort, before: number): Promise<number> {
  const end = Date.now() + PICKUP_WAIT_MS
  let after = totalCount(port.inventory())
  while (after <= before && Date.now() < end) {
    await sleep(100)
    after = totalCount(port.inventory())
  }
  return after
}

function totalCount(items: Array<{ count: number }>): number {
  return items.reduce((sum, item) => sum + item.count, 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
