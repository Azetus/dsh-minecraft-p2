import { cellOf } from '../motion/model/index.ts'
import { standCells, type StandCell, type StandResult } from '../motion/search/index.ts'
import { createReadOnlyMotionWorld } from './standing.ts'
import type { Box, ClientPort, EntityInfo, Item, SelfInfo, Vec3 } from '../port/index.ts'
import {
  boxDistance,
  canPickupAt,
  canPickupFrom,
  itemBox,
  playerBox,
  pickupQueryBox,
} from './aabb.ts'

export type PickupItemView = {
  id: string
  name: string
  item?: { name: string; count: number }
  position: Vec3
  width?: number
  height?: number
  box: Box
  playerQueryBox: Box
  distance: number
  canPickupFromStart: boolean
  presentAfter?: boolean
  positionAfter?: Vec3
  countAfter?: number
  merged?: boolean
}

export type PickupMoveView = {
  target: Vec3
  state: string
  code?: string
  actual?: Vec3
}

export type PickupResult = {
  drops: number
  picked: number
  unreachable: number
  notCollected: number
  gone: number
  full: number
  merged: number
  partial: number
  observed: {
    kind: 'pickup'
    drops: number
    picked: number
    unreachable: number
    notCollected: number
    gone: number
    full: number
    merged: number
    partial: number
    pickupDelay: 'unknown'
    target: 'unknown'
    age: 'unknown'
    player: { pos: Vec3; width: number; height: number; box: Box; queryBox: Box }
    inventory: { before: number; after: number; freeSlotsBefore?: number; freeSlotsAfter?: number }
    moves: PickupMoveView[]
    items: PickupItemView[]
    /** Last core stand query that chose pickup cells, when one ran. */
    standQuery?: {
      reason: string | null
      coverage: string
      scanned: number
      unknown: number
      candidates: number
    }
  }
}

const MAX_DROPS = 4
const PICKUP_WAIT_MS = 1_500
const MOVE_TIMEOUT_MS = 5_000
const PLAYER_WIDTH = 0.6
const PLAYER_HEIGHT = 1.8

/**
 * Pick up drops from the block this job just removed. Decisions use the vanilla
 * player AABB inflated by (1.0, 0.5, 1.0), not a centre-distance sphere.
 * The server remains the authority: pickupDelay/target/age are not synced.
 */
export async function pickupNearby(
  port: ClientPort,
  center: Vec3,
  options: { delayTicks?: number } = {},
): Promise<PickupResult> {
  const startInventory = port.inventory()
  const startCount = totalCount(startInventory)
  const startFree = freeSlots(startInventory)
  const self = port.self()
  const moves: PickupMoveView[] = []

  if (options.delayTicks !== undefined && options.delayTicks > 0) {
    await sleep(options.delayTicks * 50 + 100)
  }

  const query = queryBox(center)
  const requery = wideQueryBox(center)
  const initial = dropsIn(port, query, center)
  const items = initial.map(entity => itemView(port, entity, self))
  let before = startCount
  let picked = 0
  let unreachable = 0
  let notCollected = 0
  let gone = 0
  let full = 0
  let merged = 0
  let partial = 0
  let pickupQuery: StandResult | undefined

  for (let index = 0; index < initial.length; index += 1) {
    const drop = initial[index]!
    const view = items[index]!
    const currentSelf = port.self()
    let pickedDuringMove = false
    if (!canPickupFrom(currentSelf, drop)) {
      let reached = false
      const direct = await port.moveTo(drop.position, {
        range: 1,
        intent: 'interact',
        timeoutMs: MOVE_TIMEOUT_MS,
      })
      moves.push({
        target: { ...drop.position },
        state: direct.state,
        ...(direct.code === undefined ? {} : { code: direct.code }),
        ...(direct.state === 'ok' ? { actual: { ...port.self().pos } } : {}),
      })
      const afterDirect = totalCount(port.inventory())
      if (afterDirect > before) {
        picked += afterDirect - before
        before = afterDirect
        pickedDuringMove = true
        reached = true
      } else if (direct.state === 'ok' && canPickupFrom(port.self(), drop)) {
        reached = true
      }
      if (!reached) {
        const found = findPickupCells(port, drop, port.self())
        pickupQuery = found.query
        for (const cell of found.cells) {
          const moved = await port.moveTo(cell, {
            range: 1,
            intent: 'interact',
            timeoutMs: MOVE_TIMEOUT_MS,
          })
          moves.push({
            target: cell,
            state: moved.state,
            ...(moved.code === undefined ? {} : { code: moved.code }),
            ...(moved.state === 'ok' ? { actual: { ...port.self().pos } } : {}),
          })
          const afterMove = totalCount(port.inventory())
          if (afterMove > before) {
            picked += afterMove - before
            before = afterMove
            pickedDuringMove = true
            reached = true
            break
          }
          if (moved.state === 'ok' && canPickupFrom(port.self(), drop)) {
            reached = true
            break
          }
        }
      }
      if (pickedDuringMove) {
        await requeryItem(port, requery, drop, view, center)
        if (view.presentAfter === true) partial += 1
        continue
      }
      if (!reached) {
        unreachable += 1
        await requeryItem(port, requery, drop, view, center)
        continue
      }
    }

    let after = await waitForIncrease(port, before, PICKUP_WAIT_MS)
    if (after > before) {
      picked += after - before
      before = after
      await requeryItem(port, requery, drop, view, center)
      if (view.presentAfter === true) partial += 1
      continue
    }

    // Do not move again by centre distance. A second wait covers the normal
    // server pickup delay / inventory packet lag; the AABB cell is authoritative.
    after = await waitForIncrease(port, before, 750)
    if (after > before) {
      picked += after - before
      before = after
      await requeryItem(port, requery, drop, view, center)
      if (view.presentAfter === true) partial += 1
      continue
    }

    await requeryItem(port, requery, drop, view, center)
    if (view.presentAfter !== true) {
      if (view.merged === true) merged += 1
      gone += 1
    } else if (startFree === 0) {
      full += 1
    } else {
      notCollected += 1
    }
  }

  const finalInventory = port.inventory()
  const finalCount = totalCount(finalInventory)
  const endFree = freeSlots(finalInventory)
  const auto = finalCount - startCount
  if (auto > picked) picked = auto

  const finalSelf = port.self()
  const width = finalSelf.width ?? PLAYER_WIDTH
  const height = finalSelf.height ?? PLAYER_HEIGHT
  return {
    drops: initial.length,
    picked,
    unreachable,
    notCollected,
    gone,
    full,
    merged,
    partial,
    observed: {
      kind: 'pickup',
      drops: initial.length,
      picked,
      unreachable,
      notCollected,
      gone,
      full,
      merged,
      partial,
      pickupDelay: 'unknown',
      target: 'unknown',
      age: 'unknown',
      player: {
        pos: { ...finalSelf.pos },
        width,
        height,
        box: playerBox(finalSelf),
        queryBox: pickupQueryBox(finalSelf),
      },
      inventory: {
        before: startCount,
        after: finalCount,
        ...(startFree === undefined ? {} : { freeSlotsBefore: startFree }),
        ...(endFree === undefined ? {} : { freeSlotsAfter: endFree }),
      },
      moves,
      items,
      ...(pickupQuery === undefined
        ? {}
        : {
            standQuery: {
              reason: pickupQuery.reason ?? null,
              coverage: pickupQuery.coverage,
              scanned: pickupQuery.scanned,
              unknown: pickupQuery.unknown,
              candidates: pickupQuery.cells.length,
            },
          }),
    },
  }
}

async function requeryItem(
  port: ClientPort,
  query: Box,
  original: EntityInfo,
  view: PickupItemView,
  center: Vec3,
): Promise<void> {
  const current = port.entities(query).filter(entity => entity.item !== undefined
    || entity.name === 'item' || entity.name === 'item_stack')
  const same = current.find(entity => entity.id === original.id)
  if (same !== undefined) {
    view.presentAfter = true
    view.positionAfter = { ...same.position }
    if (same.item !== undefined) view.countAfter = same.item.count
    return
  }
  view.presentAfter = false
  const merged = current.find(entity => entity.id !== original.id
    && entity.item?.name === original.item?.name
    && Math.hypot(entity.position.x - center.x, entity.position.y - center.y,
      entity.position.z - center.z) <= 5)
  if (merged !== undefined) {
    view.merged = true
    view.positionAfter = { ...merged.position }
    if (merged.item !== undefined) view.countAfter = merged.item.count
  }
}

function findPickupCells(
  port: ClientPort,
  item: EntityInfo,
  self: SelfInfo,
): { cells: Vec3[]; query: StandResult } {
  const base = {
    x: Math.floor(item.position.x),
    y: Math.floor(item.position.y),
    z: Math.floor(item.position.z),
  }
  // The AABB stays here: the core query only supplies standable cells and their
  // real feet height (a drop on a bottom slab sits at y-0.5, not y).
  const query = standCells(
    createReadOnlyMotionWorld(point => port.blockAt(point)),
    {
      near: base,
      reach: { horizontal: 3, vertical: 2 },
      accept: (cell, feetY) => canPickupAt({ ...cell, y: feetY }, self, item),
    },
    { from: cellOf(self.pos) },
  )
  const rank = (candidate: StandCell): number => candidate.reachable === 'yes'
    ? 0
    : candidate.reachable === 'unknown' ? 1 : 2
  const cells = [...query.cells]
    .sort((left, right) => rank(left) - rank(right)
      || (left.steps ?? Number.MAX_SAFE_INTEGER) - (right.steps ?? Number.MAX_SAFE_INTEGER)
      || left.distance - right.distance
      || left.cell.y - right.cell.y
      || left.cell.x - right.cell.x
      || left.cell.z - right.cell.z)
    .slice(0, 8)
    .map(candidate => candidate.cell)
  return { cells, query }
}

function itemView(port: ClientPort, entity: EntityInfo, self: SelfInfo): PickupItemView {
  const box = itemBox(entity)
  return {
    id: entity.id,
    name: entity.name,
    ...(entity.item === undefined ? {} : { item: { ...entity.item } }),
    position: { ...entity.position },
    ...(entity.width === undefined ? {} : { width: entity.width }),
    ...(entity.height === undefined ? {} : { height: entity.height }),
    box,
    playerQueryBox: pickupQueryBox(self),
    distance: boxDistance(pickupQueryBox(self), box),
    canPickupFromStart: canPickupFrom(self, entity),
  }
}

function dropsIn(port: ClientPort, query: Box, center: Vec3): EntityInfo[] {
  return port.entities(query)
    .filter(entity => entity.item !== undefined || entity.name === 'item' || entity.name === 'item_stack')
    .filter(entity => Math.hypot(
      entity.position.x - center.x,
      entity.position.y - center.y,
      entity.position.z - center.z,
    ) <= 6)
    .slice(0, MAX_DROPS)
}

function queryBox(center: Vec3): Box {
  return {
    min: { x: center.x - 8, y: center.y - 4, z: center.z - 8 },
    max: { x: center.x + 8, y: center.y + 5, z: center.z + 8 },
  }
}

/** Wide re-query: a drop can fall out of the local pickup box. */
function wideQueryBox(center: Vec3): Box {
  return {
    min: { x: center.x - 32, y: center.y - 128, z: center.z - 32 },
    max: { x: center.x + 32, y: center.y + 32, z: center.z + 32 },
  }
}

function totalCount(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.count, 0)
}

/** Storage slots are 9..44 in mineflayer; armour/offhand are excluded. */
function freeSlots(items: Item[]): number | undefined {
  const slots = new Set<number>()
  for (const item of items) {
    if (item.slot >= 9 && item.slot <= 44) slots.add(item.slot)
  }
  return Math.max(0, 36 - slots.size)
}

async function waitForIncrease(port: ClientPort, before: number, timeoutMs: number): Promise<number> {
  const end = Date.now() + timeoutMs
  let after = totalCount(port.inventory())
  while (after <= before && Date.now() < end) {
    await sleep(100)
    after = totalCount(port.inventory())
  }
  return after
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
