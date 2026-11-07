import { standingCell } from '../motion/execute/index.ts'
import { createRules, defaultConstraints, type StandBlock } from '../motion/model/index.ts'
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

export type PickupItemOutcome =
  | 'collected'
  | 'partial'
  | 'unreachable'
  | 'gone'
  | 'full'
  | 'notCollected'
  | 'timedOut'

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
  /** Items attributed to this entity from the observed inventory delta. */
  picked?: number
  /** Terminal classification for this entity, when this pass attempted it. */
  outcome?: PickupItemOutcome
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

export type PickupStandView = {
  reason: string | null
  coverage: string
  scanned: number
  unknown: number
  candidates: number
  /** Why no movement was possible; absent when a cell was reached. */
  unreachableReason?: 'path-blocked' | 'reachability-unknown' | 'no-stand-cell' | 'unloaded-window' | 'positioning-failed'
  /** Blocks that currently prevent standing where the drop is. */
  requiredDig?: Array<{ x: number; y: number; z: number; layer: 'support' | 'feet' | 'head'; name: string }>
  /** Every candidate with its reachability verdict, for diagnosis. */
  candidateCells?: Array<{ x: number; y: number; z: number; reachable: string; steps?: number }>
}

export type PickupResult = {
  /** Drops selected after the item filter and maxDrops cap. */
  drops: number
  /** Drops matching the filter and radius, before the maxDrops cap. */
  eligible: number
  /** Drops left unprocessed because of the maxDrops cap. */
  skippedByCap: number
  /** Drops not attempted or abandoned because the wall budget expired. */
  timedOut: number
  timeoutHit: boolean
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
    eligible: number
    skippedByCap: number
    timedOut: number
    timeoutHit: boolean
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
    standQuery?: PickupStandView
  }
}

/** Per-call scan/movement options. Dig uses the defaults, which preserve P1 behavior. */
export type PickupOptions = {
  /** Initial server-delay wait before the scan, in ticks (dig harvest uses 8-12). */
  delayTicks?: number
  /** Scan radius around `center`; default 6. */
  radius?: number
  /** Maximum drops processed; default 4. */
  maxDrops?: number
  /** Only drops whose adapter-resolved item name matches exactly. */
  item?: string
  /** Total wall budget for this call; absent means no deadline. */
  timeoutMs?: number
  /** Clock injection for tests. */
  now?: () => number
}

const DEFAULT_PICKUP_RADIUS = 6
const DEFAULT_MAX_DROPS = 4
const HARD_MAX_PICKUP_RADIUS = 64
const HARD_MAX_DROPS = 64
const PICKUP_WAIT_MS = 1_500
const MOVE_TIMEOUT_MS = 5_000
const PLAYER_WIDTH = 0.6
const PLAYER_HEIGHT = 1.8

/**
 * Pick up observed drops near a point. Decisions use the vanilla player AABB
 * inflated by (1.0, 0.5, 1.0), not a centre-distance sphere. The server remains
 * the authority: pickupDelay/target/age are not synced.
 *
 * The scan happens once, nearest-first. `timeoutMs` bounds the whole pass: an
 * expired deadline stops further movement, marks unattempted drops `timedOut`,
 * and returns; it never retries the same entity after that.
 */
export async function pickupNearby(
  port: ClientPort,
  center: Vec3,
  options: PickupOptions = {},
): Promise<PickupResult> {
  const clock = options.now ?? (() => Date.now())
  const radius = clampNumber(options.radius ?? DEFAULT_PICKUP_RADIUS, 0, HARD_MAX_PICKUP_RADIUS)
  const maxDrops = Math.floor(clampNumber(options.maxDrops ?? DEFAULT_MAX_DROPS, 1, HARD_MAX_DROPS))
  const deadline = options.timeoutMs === undefined
    ? undefined
    : clock() + Math.max(0, options.timeoutMs)
  const startInventory = port.inventory()
  const startCount = totalCount(startInventory)
  const startFree = freeSlots(startInventory)
  const self = port.self()
  const moves: PickupMoveView[] = []

  if (options.delayTicks !== undefined && options.delayTicks > 0) {
    await sleep(options.delayTicks * 50 + 100)
  }

  const query = queryBox(center, radius)
  const requery = wideQueryBox(center)
  const matching = dropsIn(port, query, center, radius, options.item, self)
  const eligible = matching.length
  const initial = matching.slice(0, maxDrops)
  const skippedByCap = Math.max(0, eligible - initial.length)
  const items = initial.map(entity => itemView(port, entity, self))
  let before = startCount
  let picked = 0
  let unreachable = 0
  let notCollected = 0
  let gone = 0
  let full = 0
  let merged = 0
  let partial = 0
  let timedOut = 0
  let standView: PickupStandView | undefined

  for (let index = 0; index < initial.length; index += 1) {
    if (deadlineExpired(deadline, clock())) {
      timedOut += initial.length - index
      for (let rest = index; rest < items.length; rest += 1) items[rest]!.outcome = 'timedOut'
      break
    }
    const drop = initial[index]!
    const view = items[index]!
    const currentSelf = port.self()
    let pickedDuringMove = false

    // Confirm one pickup from the observed inventory delta and re-query the
    // entity. A remaining entity is `partial`, not a second attempt.
    const confirmPickup = async (after: number): Promise<void> => {
      const delta = after - before
      picked += delta
      view.picked = (view.picked ?? 0) + delta
      before = after
      await requeryItem(port, requery, drop, view, center)
      if (view.presentAfter === true) {
        partial += 1
        view.outcome = 'partial'
      } else {
        view.outcome = 'collected'
      }
    }

    if (!canPickupFrom(currentSelf, drop)) {
      // P1: never walk to the item's position (an item is not a stand cell).
      // The core query supplies real stand cells plus their feet height; a cell
      // already inside the pickup AABB is the only thing worth moving to.
      const found = findPickupCells(port, drop, port.self())
      standView = {
        reason: found.query.reason ?? null,
        coverage: found.query.coverage,
        scanned: found.query.scanned,
        unknown: found.query.unknown,
        candidates: found.query.cells.length,
        ...(found.blocked.length === 0
          ? {}
          : {
              requiredDig: found.blocked.map(block => ({
                x: block.cell.x,
                y: block.cell.y,
                z: block.cell.z,
                layer: block.layer,
                name: block.name,
              })),
            }),
        ...(found.query.cells.length === 0
          ? {}
          : {
              candidateCells: found.query.cells.map(candidate => ({
                x: candidate.cell.x,
                y: candidate.cell.y,
                z: candidate.cell.z,
                reachable: candidate.reachable,
                ...(candidate.steps === undefined ? {} : { steps: candidate.steps }),
              })),
            }),
      }
      let reached = false
      let afterMove = before
      for (const cell of found.cells) {
        if (deadlineExpired(deadline, clock())) break
        const moved = await port.moveTo(cell, {
          range: 0,
          intent: 'interact',
          timeoutMs: Math.max(1, remainingMs(deadline, clock(), MOVE_TIMEOUT_MS)),
        })
        moves.push({
          target: cell,
          state: moved.state,
          ...(moved.code === undefined ? {} : { code: moved.code }),
          ...(moved.state === 'ok' ? { actual: { ...port.self().pos } } : {}),
        })
        afterMove = totalCount(port.inventory())
        if (afterMove > before) {
          pickedDuringMove = true
          reached = true
          break
        }
        if (moved.state === 'ok' && canPickupFrom(port.self(), drop)) {
          reached = true
          break
        }
      }
      if (pickedDuringMove) {
        await confirmPickup(afterMove)
        continue
      }
      // A deadline during positioning is a timeout, not proof the drop is
      // unreachable: the candidate cells may have been fine.
      if (deadlineExpired(deadline, clock())) {
        timedOut += 1
        view.outcome = 'timedOut'
        await requeryItem(port, requery, drop, view, center)
        continue
      }
      if (!reached) {
        unreachable += 1
        view.outcome = 'unreachable'
        standView.unreachableReason = standUnreachableReason(found)
        await requeryItem(port, requery, drop, view, center)
        continue
      }
    }

    let after = await waitForIncrease(
      port,
      before,
      Math.max(0, remainingMs(deadline, clock(), PICKUP_WAIT_MS)),
      clock,
    )
    if (after > before) {
      await confirmPickup(after)
      continue
    }

    // Do not move again by centre distance. A second wait covers the normal
    // server pickup delay / inventory packet lag; the AABB cell is authoritative.
    after = await waitForIncrease(port, before, Math.max(0, remainingMs(deadline, clock(), 750)), clock)
    if (after > before) {
      await confirmPickup(after)
      continue
    }

    if (deadlineExpired(deadline, clock())) {
      timedOut += 1
      view.outcome = 'timedOut'
      await requeryItem(port, requery, drop, view, center)
      continue
    }

    await requeryItem(port, requery, drop, view, center)
    if (view.presentAfter !== true) {
      if (view.merged === true) merged += 1
      gone += 1
      view.outcome = 'gone'
    } else if (startFree === 0) {
      full += 1
      view.outcome = 'full'
    } else {
      notCollected += 1
      view.outcome = 'notCollected'
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
  const timeoutHit = timedOut > 0
  return {
    drops: initial.length,
    eligible,
    skippedByCap,
    timedOut,
    timeoutHit,
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
      eligible,
      skippedByCap,
      timedOut,
      timeoutHit,
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
      ...(standView === undefined ? {} : { standQuery: standView }),
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
): { cells: Vec3[]; query: StandResult; blocked: StandBlock[] } {
  const base = {
    x: Math.floor(item.position.x),
    y: Math.floor(item.position.y),
    z: Math.floor(item.position.z),
  }
  const world = createReadOnlyMotionWorld(point => port.blockAt(point))
  const rules = createRules(world, defaultConstraints())
  // Evidence for the no-cell branch: which blocks make the drop's own cell
  // unstandable. The query itself only returns verdicts.
  const info = rules.standInfo(base)
  const blocked = info.state === 'no' && info.blockedBy !== undefined ? info.blockedBy : []
  // The AABB stays here: the core query only supplies standable cells and their
  // real feet height (a drop on a bottom slab sits at y-0.5, not y).
  const query = standCells(
    world,
    {
      near: base,
      reach: { horizontal: 3, vertical: 2 },
      accept: (cell, feetY) => canPickupAt({ ...cell, y: feetY }, self, item),
    },
    // A drop floating on water is a real pickup target: keep water cells
    // eligible here, unlike reflex/escape queries which must stand dry.
    { from: standingCell(rules, self.pos), dry: false },
  )
  const rank = (candidate: StandCell): number => candidate.reachable === 'yes'
    ? 0
    : candidate.reachable === 'unknown' ? 1 : 2
  const cells = [...query.cells]
    // A proven-unreachable candidate is evidence, not a move target: walking
    // to it only produces a second GOTO_NO_PATH for the same cell.
    .filter(candidate => candidate.reachable !== 'no')
    .sort((left, right) => rank(left) - rank(right)
      || (left.steps ?? Number.MAX_SAFE_INTEGER) - (right.steps ?? Number.MAX_SAFE_INTEGER)
      || left.distance - right.distance
      || left.cell.y - right.cell.y
      || left.cell.x - right.cell.x
      || left.cell.z - right.cell.z)
    .slice(0, 8)
    .map(candidate => candidate.cell)
  return { cells, query, blocked }
}

function standUnreachableReason(found: { cells: Vec3[]; query: StandResult }): NonNullable<PickupStandView['unreachableReason']> {
  if (found.cells.length > 0) return 'positioning-failed'
  if (found.query.cells.length > 0) {
    return found.query.coverage === 'complete' ? 'path-blocked' : 'reachability-unknown'
  }
  return found.query.reason === 'unloaded-window' ? 'unloaded-window' : 'no-stand-cell'
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

function dropsIn(
  port: ClientPort,
  query: Box,
  center: Vec3,
  radius: number,
  item: string | undefined,
  self: SelfInfo,
): EntityInfo[] {
  const selfQuery = pickupQueryBox(self)
  return port.entities(query)
    .filter(entity => entity.item !== undefined || entity.name === 'item' || entity.name === 'item_stack')
    .filter(entity => item === undefined || entity.item?.name === item)
    .filter(entity => Math.hypot(
      entity.position.x - center.x,
      entity.position.y - center.y,
      entity.position.z - center.z,
    ) <= radius)
    // Nearest first: a bounded collect should spend its budget on the drop the
    // body can reach soonest, not on adapter iteration order.
    .sort((left, right) => boxDistance(selfQuery, itemBox(left)) - boxDistance(selfQuery, itemBox(right))
      || left.id.localeCompare(right.id))
}

function queryBox(center: Vec3, radius: number): Box {
  const reach = radius + 2
  return {
    min: { x: center.x - reach, y: center.y - reach, z: center.z - reach },
    max: { x: center.x + reach, y: center.y + reach, z: center.z + reach },
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

async function waitForIncrease(
  port: ClientPort,
  before: number,
  timeoutMs: number,
  now: () => number,
): Promise<number> {
  const end = now() + timeoutMs
  let after = totalCount(port.inventory())
  while (after <= before && now() < end) {
    await sleep(100)
    after = totalCount(port.inventory())
  }
  return after
}

function remainingMs(deadline: number | undefined, at: number, fallback: number): number {
  if (deadline === undefined) return fallback
  return Math.max(0, Math.min(fallback, deadline - at))
}

function deadlineExpired(deadline: number | undefined, at: number): boolean {
  return deadline !== undefined && at >= deadline
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
