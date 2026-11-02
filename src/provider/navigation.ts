import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { EventEmitter } from 'node:events'
import type { Movements, Pathfinder, PartiallyComputedPath, goals } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { JsonValue } from '../contracts/types.ts'
import {
  clearCell,
  isHazardBlock,
  isWaterBlock,
  safeFallDistance,
  safeOneGap,
  standingAt,
  unstickObstacle,
  type HazardPolicy,
  type UnstickBlock,
} from '../port/terrain.ts'
import { HAZARD_NAMES } from '../motion/model/semantics/vanilla.ts'
import { blockTagsFor } from '../port/mineflayer/block-tags.ts'
import type { Vec3 as Point, BlockInfo } from '../port/types.ts'

const SLICE_MS = 5
const SEARCH_MS = 2_000
const MAX_NODES = 12_000
const STUCK_MS = 3_000
const APPROACH_NEAREST_ENDS = 8
const THREATS = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom', 'blaze', 'wither_skeleton', 'piglin_brute', 'zoglin'])
type PathResult = Pick<PartiallyComputedPath, 'status' | 'path' | 'visitedNodes' | 'generatedNodes'>
type End = { node: Point; position: Point }
type Finish = (code: string | undefined, observed: JsonValue, released: boolean) => void
const doorModes = new WeakMap<Movements, { enabled: boolean }>()
/** Per-run danger permission; the default is always false. */
const dropModes = new WeakMap<Movements, { lethalFall: boolean; safeFall: number }>()
const MAX_HAZARD_DROP = 64

/** Let the planner treat hand-openable doors as passable; the executor opens them. */
export function setNavigationDoorMode(movements: Movements, enabled: boolean): void {
  const mode = doorModes.get(movements)
  if (mode !== undefined) mode.enabled = enabled
}
function manualDoor(block: { name?: string }): boolean {
  return block.name !== undefined && (block.name.endsWith('_door') || block.name.endsWith('_fence_gate'))
    && block.name !== 'iron_door' && !block.name.startsWith('copper') && !/copper_door$/u.test(block.name)
}
function doorAxis(block: Block): 'x' | 'z' {
  return ['east', 'west'].includes(String(block.getProperties().facing)) ? 'x' : 'z'
}
type DoorRecord = { position: Point; name: string; axis: 'x' | 'z'; entrySide: number }
type DoorAction = { kind: 'door'; block: Block; open: boolean; deadline: number; issued: boolean; confirmedAt?: number }
type DigAction = { kind: 'unstick-dig'; block: Block; deadline: number; issued: boolean; confirmedAt?: number; serverState?: number; source?: string }

export function configureNavigation(bot: Bot, movements: Movements): void {
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = true
  movements.allowSprinting = false
  // Disabling towers alone still permits bridging with inventory blocks.
  movements.scafoldingBlocks = []
  // 2.4.5 measures this against the SUPPORT block (feet minus one).
  // A two-block feet-to-feet drop therefore needs an upstream value of 3.
  movements.maxDropDown = 3
  movements.infiniteLiquidDropdownDistance = false
  // Present in 2.4.5's implementation, omitted by its .d.ts.
  ;(movements as Movements & { liquidCost: number }).liquidCost = 8
  movements.entityCost = 4
  // Upstream door activation has unowned async callbacks. Closed doors require
  // an explicit interaction; never turn that path on implicitly.
  movements.canOpenDoors = false
  const mode = { enabled: false }
  doorModes.set(movements, mode)
  const dropMode = { lethalFall: false, safeFall: 2 }
  dropModes.set(movements, dropMode)
  const readCell = (p: Point): BlockInfo | null => {
    const block = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
    if (block === null) return null
    const blockId = (block as unknown as { type?: number }).type
    const serverTags = typeof blockId === 'number' ? blockTagsFor(bot).tagsFor(blockId) : undefined
    return {
      name: block.name,
      loaded: true,
      collision: block.shapes,
      state: Object.fromEntries(Object.entries(block.getProperties()).map(([k, v]) => [k, String(v)])),
      ...(serverTags === undefined ? {} : { serverTags }),
    }
  }
  const getBlock = movements.getBlock.bind(movements)
  movements.getBlock = (pos, dx, dy, dz) => {
    const block = getBlock(pos, dx, dy, dz)
    // The planner may cross a wooden door along its normal. NavigationRun
    // opens it before execution reaches it; upstream useOne stays disabled.
    if (mode.enabled && manualDoor(block)) { block.safe = true; block.physical = false }
    return block
  }
  for (const name of HAZARD_NAMES) {
    const block = bot.registry.blocksByName[name]
    if (block !== undefined) movements.blocksToAvoid.add(block.id)
  }
  movements.exclusionAreasStep.push(block => {
    if (block.position === undefined) return 100
    const below = bot.blockAt(block.position.offset(0, -1, 0))
    if (below === null) return 100
    const belowCell = readCell({ x: below.position.x, y: below.position.y, z: below.position.z })
    if (isHazardBlock(belowCell)) return 100
    // Do not enter water from land. A bot already in water may swim out.
    const here = readCell({ x: block.position.x, y: block.position.y, z: block.position.z })
    if (isWaterBlock(here) && !(bot.entity as typeof bot.entity & { isInWater?: boolean }).isInWater) return 100
    return 0
  })
  const getNeighbors = movements.getNeighbors.bind(movements)
  movements.getNeighbors = node => getNeighbors(node).filter(next => {
    if (mode.enabled) for (const p of [node, next]) {
      const block = bot.blockAt(new Vec3(p.x, p.y, p.z))
      if (block !== null && manualDoor(block)) {
        const axis = doorAxis(block)
        if (next.y !== node.y || (axis === 'x' ? next.z !== node.z : next.x !== node.x)) return false
      }
    }
    if (next.parkour) {
      if (!safeOneGap(readCell, node, next)) return false
      const cost = movements.exclusionStep(movements.getBlock(new Vec3(next.x, next.y, next.z), 0, 0, 0))
      if (cost >= 100) return false
      next.cost += 2 + cost
    }
    if (next.y >= node.y) return true
    const drop = node.y - next.y
    const withinSafe = drop <= dropMode.safeFall
    const withinLethal = dropMode.lethalFall && drop <= MAX_HAZARD_DROP
    if (drop > 2 && !withinSafe && !withinLethal) return false
    if (drop > 2) {
      // A planned fall must land on solid, loaded, standable ground with a
      // clear fall column. The safe pass keeps a health margin; the explicit
      // lethal pass is the only path allowed to ignore that margin.
      const landingCell = { x: next.x, y: next.y, z: next.z }
      if (standingAt(readCell, landingCell).state !== 'valid') return false
      const support = readCell({ x: next.x, y: next.y - 1, z: next.z })
      if (support === null || !support.loaded || isWaterBlock(support) || isHazardBlock(support)) return false
      for (let y = next.y + 1; y < node.y; y++) {
        const cell = readCell({ x: next.x, y, z: next.z })
        if (cell === null || !clearCell(cell)) return false
      }
      next.cost += (withinSafe ? 10 + drop * 3 : 20 + drop * 4)
      return true
    }
    // Upstream diagonal/drop moves do not consistently run exclusionStep on
    // the landing cell. Check it explicitly, including its support/hazards.
    const landing = movements.getBlock(new Vec3(next.x, next.y, next.z), 0, 0, 0)
    const cost = movements.exclusionStep(landing)
    if (cost >= 100) return false
    next.cost += cost
    return true
  })
  const pathfinder = bot.pathfinder as Pathfinder & { searchRadius: number }
  pathfinder.tickTimeout = SLICE_MS
  pathfinder.thinkTimeout = SEARCH_MS
  pathfinder.searchRadius = 48
}

function point(p: Point): Point { return { x: p.x, y: p.y, z: p.z } }
function key(p: Point): string { return `${p.x},${p.y},${p.z}` }
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }

/** One bounded navigation owner. No placement or raw recovery input pulses;
 * door use and explicitly authorized local digging share this owner's fence. */
export class NavigationRun {
  private active = true
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners: Array<[string, (...args: any[]) => void]> = []
  private readonly startedAt = performance.now()
  private readonly from: Point
  private readonly target: Point
  private readonly requested: Point
  private approaching = false
  private fallbackReason = ''
  private ends: End[] = []
  private suggestions: Point[] = []
  private recoveryEnd: End | undefined
  private goal!: goals.Goal
  private phase = 'planning'
  private pathStatus = 'pending'
  private path: Point[] = []
  private planner: ReturnType<Pathfinder['getPathFromTo']> | undefined
  private replans = 0
  private recoveries = 0
  private generatedNodes = 0
  private visitedNodes = 0
  private searchMs = 0
  private planningAt = this.startedAt
  private lastProgressAt = this.startedAt
  private progressAnchor: Point
  private travelled = 0
  private lastPosition: Point
  private dirty = false
  private recovering = false
  private readonly tried = new Set<string>()
  private reason = ''
  private obstruction: JsonValue = null
  private threats: Point[] = []
  private threatKey = ''
  private lastThreatCheck = 0
  private readonly threatCost: (block: { position: Vec3 }) => number
  private interaction: DoorAction | DigAction | undefined
  private readonly openedDoors = new Map<string, DoorRecord>()
  private doorActions = 0
  private handSlotToRestore: number | undefined
  private readonly actions: Array<{ seq: number; kind: string; state: string; at: Point; detail: JsonValue }> = []
  private readonly dug = new Set<string>()
  private readonly clientListeners: Array<[string, (...args: any[]) => void]> = []
  private readonly hazards: HazardPolicy | undefined
  private readonly savedMaxDropDown: number
  private readonly healthBefore: number
  private readonly safeFallBudget: number
  private hazardPass = false
  private safeFallPass = false
  private fatalTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly bot: Bot,
    private readonly movements: Movements,
    target: Point,
    private readonly range: number,
    private readonly timeoutMs: number,
    private readonly finish: Finish,
    private readonly policy: {
      exact?: boolean
      approach?: boolean
      unstickDig?: readonly UnstickBlock[]
      intent?: 'interact' | 'attack'
      hazards?: HazardPolicy
    } = {},
  ) {
    this.from = point(bot.entity.position)
    this.requested = point(target)
    this.target = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) }
    this.progressAnchor = this.from
    this.lastPosition = this.from
    this.hazards = policy.hazards
    this.savedMaxDropDown = movements.maxDropDown
    this.healthBefore = bot.health
    this.safeFallBudget = safeFallDistance(bot.health)
    if (this.hazards !== undefined && this.hazards.allow.length > 0) {
      this.listen('death', () => {
        if (!this.active || (!this.hazardPass && this.phase !== 'fatal-step')) return
        this.actionEvent('hazard', 'died', this.target, { hazards: this.hazards ?? null })
        const released = this.stop()
        this.finish('DIED_IN_ALLOWED_HAZARD', this.report(), released)
      })
    }
    this.threatCost = block => {
      if (block.position === undefined) return 100
      let cost = 0
      for (const threat of this.threats) {
        const d = distance(block.position, threat)
        // Permit escape out of an existing danger radius, never approach it.
        if (d < 2.5 && d < distance(this.bot.entity.position, threat) - 0.1) return 100
        if (d < 6) cost += (6 - d) * 2
      }
      return cost
    }
    this.movements.exclusionAreasStep.push(this.threatCost)
    const doorMode = doorModes.get(movements)
    if (doorMode !== undefined) doorMode.enabled = true
  }

  start(): void {
    if (![this.target.x, this.target.y, this.target.z, this.range, this.timeoutMs].every(Number.isFinite)
      || this.range < 0 || this.range > 8 || this.timeoutMs <= 0) {
      this.fail('BAD_ARGS', 'invalid-navigation-parameters')
      return
    }
    // A void/lava target has no standing node; it is an explicit escape only.
    if (this.tryFatalHazard()) return
    if (!this.refreshEnds()) return
    this.readThreats()
    if ((this.policy.unstickDig?.length ?? 0) > 0) {
      const observe = (pos: Point, state: number, source: string): void => {
        const action = this.interaction
        if (action?.kind === 'unstick-dig' && action.issued && key(pos) === key(action.block.position)) {
          action.serverState = state; action.source = source
        }
      }
      const single = (packet: { location: Point; type: number }): void => observe(packet.location, packet.type, 'block_change')
      // 1.21.1 uses 3D section coordinates and packed numeric state/offsets.
      const multi = (packet: { chunkCoordinates: Point; records: number[] }): void => {
        for (const record of packet.records) observe({ x: packet.chunkCoordinates.x * 16 + ((record >> 8) & 15),
          y: packet.chunkCoordinates.y * 16 + (record & 15), z: packet.chunkCoordinates.z * 16 + ((record >> 4) & 15) }, record >> 12, 'multi_block_change')
      }
      this.bot._client.on('block_change', single)
      this.bot._client.on('multi_block_change', multi)
      this.clientListeners.push(['block_change', single], ['multi_block_change', multi])
    }
    this.listen('path_update', (result: PathResult) => {
      if (!this.active || this.phase !== 'moving') return
      // Upstream post-processing puts a route node on top of the door's thin
      // collision box. Correct the transit node before upstream consumes it.
      for (const node of result.path) {
        const p = new Vec3(Math.floor(node.x), Math.floor(node.y), Math.floor(node.z))
        let block = this.bot.blockAt(p)
        if (block === null || !manualDoor(block)) block = this.bot.blockAt(p.offset(0, -1, 0))
        if (block !== null && manualDoor(block)) {
          node.x = block.position.x + 0.5; node.z = block.position.z + 0.5
          node.y = block.position.y - (block.getProperties().half === 'upper' ? 1 : 0)
        }
      }
      this.acceptPath(result)
      // Upstream assigns its path AFTER emitting this event. Stop/replan on
      // the next turn, otherwise the event handler's stop would be overwritten.
      this.schedule(0)
    })
    this.listen('path_reset', (reason: string) => {
      if (!this.active || this.phase === 'planning') return
      this.reason = reason
      this.replans++
      if (reason === 'stuck') this.dirty = true
      this.schedule(0)
    })
    this.listen('blockUpdate', (oldBlock, newBlock) => {
      const p = newBlock?.position ?? oldBlock?.position
      if (p === undefined) { this.dirty = true; return }
      if (oldBlock?.stateId === newBlock?.stateId && oldBlock !== null && newBlock !== null) return
      // Includes same-type state changes (doors/trapdoors) missed by upstream.
      if (distance(p, this.target) <= this.range + 2 || distance(p, this.bot.entity.position) < 3
        || this.path.some(node => distance(node, p) < 2)) this.dirty = true
    })
    this.listen('chunkColumnUnload', () => { this.dirty = true })
    this.beginPlan(this.goalFor(this.ends))
  }

  report(): JsonValue {
    return {
      from: this.from, target: this.target, at: point(this.bot.entity.position), range: this.range,
      phase: this.phase, pathStatus: this.pathStatus, reason: this.approaching ? this.fallbackReason : this.reason,
      approach: this.approaching, requested: this.requested, actual: point(this.bot.entity.position),
      fallbackDistance: this.approaching ? distance(this.bot.entity.position, this.requested) : 0,
      elapsedMs: Math.round(performance.now() - this.startedAt), searchMs: Math.round(this.searchMs),
      replans: this.replans, recoveries: this.recoveries, visitedNodes: this.visitedNodes,
      generatedNodes: this.generatedNodes, distanceTravelled: this.travelled,
      searchBudget: { sliceMs: SLICE_MS, timeMs: SEARCH_MS, nodes: MAX_NODES, costMargin: 48 },
      currentBlock: this.read(this.bot.entity.position)?.name ?? null, obstruction: this.obstruction,
      candidates: this.ends.slice(0, 8).map(end => end.position), nearbyCandidates: this.suggestions,
      bestReachable: this.path.at(-1) ?? null,
      actions: this.actions, openDoors: [...this.openedDoors.values()].map(door => door.position),
      hazards: this.hazards ?? null,
      hazardPass: this.hazardPass,
      safeFallPass: this.safeFallPass,
      safeFall: this.safeFallBudget,
      healthBefore: this.healthBefore,
      healthAfter: this.bot.health,
    }
  }

  stop(): boolean {
    if (!this.active) return this.released()
    this.active = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.fatalTimer !== undefined) clearTimeout(this.fatalTimer)
    this.fatalTimer = undefined
    this.planner = undefined
    const dropMode = dropModes.get(this.movements)
    if (dropMode !== undefined) {
      dropMode.lethalFall = false
      dropMode.safeFall = 2
    }
    if (this.hazardPass || this.safeFallPass) this.movements.maxDropDown = this.savedMaxDropDown
    if (this.interaction !== undefined) this.actionEvent(this.interaction.kind, 'cancelled', this.interaction.block.position, { issued: this.interaction.issued })
    let digStopped = true
    if (this.interaction?.kind === 'unstick-dig' && this.interaction.issued) {
      try { this.bot.stopDigging() } catch { digStopped = false }
      if (this.bot.targetDigBlock != null) digStopped = false
    }
    this.interaction = undefined
    let handRestored = true
    try { this.restoreHand() } catch { handRestored = false }
    const doorMode = doorModes.get(this.movements)
    if (doorMode !== undefined) doorMode.enabled = false
    for (const [event, listener] of this.listeners) (this.bot as EventEmitter).removeListener(event, listener)
    this.listeners.length = 0
    for (const [event, listener] of this.clientListeners) this.bot._client.removeListener(event, listener)
    this.clientListeners.length = 0
    const index = this.movements.exclusionAreasStep.indexOf(this.threatCost)
    if (index >= 0) this.movements.exclusionAreasStep.splice(index, 1)
    const stopped = this.hardStop()
    return stopped && digStopped && handRestored
  }

  private read = (p: Point): BlockInfo | null => {
    const block = this.bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
    return block === null ? null : { name: block.name, loaded: true, collision: block.shapes,
      state: Object.fromEntries(Object.entries(block.getProperties()).map(([k, v]) => [k, String(v)])) }
  }

  private refreshEnds(): boolean {
    if (this.approaching) {
      this.ends = this.approachEnds()
      if (this.ends.length > 0) return true
      this.fail('GOTO_NO_PATH', 'approach-standing-space-lost')
      return false
    }
    const ends: End[] = []
    let unknown = false
    const radius = Math.ceil(this.range)
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) {
      if (Math.hypot(dx, dy, dz) > this.range) continue
      const node = { x: this.target.x + dx, y: this.target.y + dy, z: this.target.z + dz }
      const result = standingAt(this.read, node)
      if (result.state === 'valid' && this.withinInteractionReach(result.position!)) ends.push({ node, position: result.position! })
      if (result.state === 'unknown') unknown = true
      if (result.block !== undefined) this.obstruction = result.block
    }
    this.ends = ends.sort((a, b) => distance(a.position, this.from) - distance(b.position, this.from))
    if (ends.length > 0) return true
    // Suggestions are safe standing cells, NOT proof of reachability or an
    // implicit relaxation of the caller's goal. The giver decides a new goal.
    const nearby: Point[] = []
    for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -3; dz <= 3; dz++) {
      const stand = standingAt(this.read, { x: this.target.x + dx, y: this.target.y + dy, z: this.target.z + dz })
      if (stand.state === 'valid') nearby.push(stand.position!)
    }
    this.suggestions = nearby.sort((a, b) => distance(a, this.target) - distance(b, this.target)).slice(0, 8)
    const reason = unknown ? 'target-observation-incomplete' : 'no-safe-standing-space'
    if (this.prepareApproach(reason)) return true
    this.fail(unknown ? 'GOTO_TARGET_UNLOADED' : 'GOTO_INVALID_TARGET', reason)
    return false
  }

  private approachEnds(): End[] {
    const ends: End[] = []
    for (let dx = -5; dx <= 5; dx++) for (let dy = -5; dy <= 5; dy++) for (let dz = -5; dz <= 5; dz++) {
      const node = { x: this.target.x + dx, y: this.target.y + dy, z: this.target.z + dz }
      if (distance(node, this.requested) > 5.5) continue
      const stand = standingAt(this.read, node)
      if (stand.state === 'valid' && distance(stand.position!, this.requested) <= 4.5) ends.push({ node, position: stand.position! })
    }
    return ends.sort((a, b) => distance(a.position, this.requested) - distance(b.position, this.requested))
  }

  private prepareApproach(reason: string): boolean {
    if (this.policy.exact || !this.policy.approach || this.approaching || this.policy.intent !== undefined) return false
    const candidates = this.approachEnds()
    if (candidates.length === 0) return false
    // A* stops at the cheapest goal node, not at the goal closest to the
    // requested point. Keep only the nearest candidates so an easy outside
    // cell cannot win over a slightly harder interior cell next to the target.
    const ends = candidates.slice(0, APPROACH_NEAREST_ENDS)
    this.actionEvent('approach', 'fallback', this.target, {
      reason,
      pathStatus: this.pathStatus,
      visitedNodes: this.visitedNodes,
      generatedNodes: this.generatedNodes,
      candidates: candidates.length,
      ends: ends.length,
      nearest: ends[0]?.position ?? null,
      bestReachable: this.path.at(-1) ?? null,
    })
    this.ends = ends
    this.approaching = true
    this.fallbackReason = reason
    this.recovering = false
    return true
  }

  /** Second pass: a health-budgeted fall, no explicit hazard permission. */
  private trySafeFall(): boolean {
    if (this.target.y >= Math.floor(this.bot.entity.position.y)) return false
    if (this.safeFallPass || this.safeFallBudget <= 2) return false
    const mode = dropModes.get(this.movements)
    if (mode === undefined) return false
    mode.safeFall = this.safeFallBudget
    this.safeFallPass = true
    this.movements.maxDropDown = Math.max(3, this.safeFallBudget + 1)
    this.actionEvent('hazard', 'safe-fall-enabled', this.target, {
      safeFall: this.safeFallBudget,
      health: this.bot.health,
    })
    return true
  }

  /** Third pass: only when the caller explicitly allowed lethal falls. */
  private tryLethalFall(): boolean {
    if (this.target.y >= Math.floor(this.bot.entity.position.y)) return false
    if (this.hazardPass) return false
    if (this.hazards?.allow.includes('lethal_fall') !== true) return false
    const mode = dropModes.get(this.movements)
    if (mode === undefined) return false
    mode.lethalFall = true
    this.hazardPass = true
    this.movements.maxDropDown = MAX_HAZARD_DROP + 1
    this.actionEvent('hazard', 'lethal-fall-enabled', this.target, {
      hazards: this.hazards,
      from: point(this.bot.entity.position),
    })
    return true
  }

  /** A void/lava target is a fatal exit, not a normal standing goal. */
  private tryFatalHazard(): boolean {
    const allow = this.hazards?.allow
    if (allow === undefined) return false
    const block = this.read(this.target)
    if (block === null || !block.loaded) return false
    const isLava = block.name === 'lava'
    const isVoid = !isLava && clearCell(block) && standingAt(this.read, this.target).state === 'blocked'
    if ((!isLava && !isVoid) || (isLava && !allow.includes('lava')) || (isVoid && !allow.includes('void'))) return false
    if (distance(this.bot.entity.position, this.target) > 6) {
      this.fail('HAZARD_TARGET_TOO_FAR', 'fatal-exit-out-of-reach')
      return true
    }
    this.beginFatalStep()
    return true
  }

  private beginFatalStep(): void {
    this.phase = 'fatal-step'
    this.actionEvent('hazard', 'fatal-step', this.target, { hazards: this.hazards ?? null })
    if (!this.hardStop()) { this.fail('STOP_UNCONFIRMED', 'fatal-step-not-released'); return }
    void this.bot.lookAt(new Vec3(this.target.x + 0.5, this.target.y + 0.5, this.target.z + 0.5), true)
      .then(() => {
        if (!this.active) return
        this.bot.setControlState('forward', true)
        this.fatalTimer = setTimeout(() => {
          if (!this.active) return
          this.bot.setControlState('forward', false)
          this.fatalTimer = setTimeout(() => {
            if (this.active) this.fail('HAZARD_SURVIVED', 'fatal-step-did-not-kill')
          }, 1_500)
          this.fatalTimer.unref?.()
        }, 700)
        this.fatalTimer.unref?.()
      })
      .catch(error => {
        if (this.active) this.fail('HAZARD_STEP_FAILED', String(error))
      })
  }

  private goalFor(ends: End[]): goals.Goal {
    const allowed = new Set(ends.map(end => key(end.node)))
    const min = { x: Math.min(...ends.map(e => e.node.x)), y: Math.min(...ends.map(e => e.node.y)), z: Math.min(...ends.map(e => e.node.z)) }
    const max = { x: Math.max(...ends.map(e => e.node.x)), y: Math.max(...ends.map(e => e.node.y)), z: Math.max(...ends.map(e => e.node.z)) }
    return {
      isEnd: node => allowed.has(key(node)),
      // Chebyshev lower bound to the accepted set: zero at EVERY endpoint,
      // including GoalNear's range. Drops span <=2; a one-gap jump spans two
      // horizontal cells but costs >=3, keeping this bound admissible.
      heuristic: node => Math.max(0, min.x - node.x, node.x - max.x, min.z - node.z, node.z - max.z,
        (min.y - node.y) / 2, (node.y - max.y) / 2),
      hasChanged: () => false,
      isValid: () => this.active,
    }
  }

  private beginPlan(goal: goals.Goal): void {
    if (!this.active) return
    if (!this.hardStop()) { this.fail('STOP_UNCONFIRMED', 'path-not-released'); return }
    // Upstream fullStop may recenter locally; that is not walking progress.
    this.lastPosition = point(this.bot.entity.position)
    this.goal = goal
    this.phase = 'planning'
    this.pathStatus = 'pending'
    this.planningAt = performance.now()
    this.bot.pathfinder.setMovements(this.movements)
    this.planner = this.bot.pathfinder.getPathFromTo(this.movements, this.bot.entity.position, goal, {
      timeout: SEARCH_MS, tickTimeout: SLICE_MS, searchRadius: 48, optimizePath: false,
    })
    this.schedule(0)
  }

  private acceptPath(result: PathResult): void {
    this.pathStatus = result.status
    this.path = result.path.map(point)
    this.generatedNodes = result.generatedNodes
    this.visitedNodes = result.visitedNodes
  }

  private tick(): void {
    if (!this.active) return
    const now = performance.now()
    if (now - this.startedAt >= this.timeoutMs) { this.fail('GOTO_TIMEOUT', 'deadline'); return }
    if (this.interaction !== undefined) { this.tickInteraction(now); return }
    if (this.dirty) {
      this.dirty = false
      if (!this.refreshEnds()) return
      this.replans++
      this.recovering = false
      this.beginPlan(this.goalFor(this.ends))
      return
    }
    if (this.planner !== undefined) {
      const next = this.planner.next()
      if (next.done) { this.fail('GOTO_NO_PATH', 'search-ended-without-route'); return }
      this.acceptPath(next.value.result as PathResult)
      this.searchMs += performance.now() - now
      if (this.generatedNodes > MAX_NODES) { this.fail('GOTO_SEARCH_LIMIT', 'node-budget'); return }
      if (this.pathStatus === 'partial' && performance.now() - this.planningAt < SEARCH_MS + 100) {
        this.schedule(0)
        return
      }
      this.planner = undefined
      if (this.pathStatus === 'noPath') {
        if (this.recovering) { this.recover(); return }
        if (this.trySafeFall()) { this.beginPlan(this.goalFor(this.ends)); return }
        if (this.tryLethalFall()) { this.beginPlan(this.goalFor(this.ends)); return }
        if (this.prepareApproach('requested-unreachable')) { this.beginPlan(this.goalFor(this.ends)); return }
        if ((this.policy.unstickDig?.length ?? 0) > 0) { this.recover(); return }
        this.fail('GOTO_NO_PATH', 'search-exhausted-within-movement-policy')
        return
      }
      if (this.pathStatus !== 'success' && this.path.length === 0) {
        this.fail('GOTO_SEARCH_TIMEOUT', 'search-budget')
        return
      }
      // A budget-limited prefix may be followed, but never counts as arrival.
      this.phase = 'moving'
      this.lastProgressAt = performance.now()
      this.progressAnchor = point(this.bot.entity.position)
      this.bot.pathfinder.setGoal(this.goal)
    }
    if (this.tryDoors()) return
    if (this.generatedNodes > MAX_NODES) { this.fail('GOTO_SEARCH_LIMIT', 'node-budget'); return }
    const position = this.bot.entity.position
    this.travelled += distance(position, this.lastPosition)
    this.lastPosition = point(position)
    if (this.arrived(this.ends) && this.withinInteractionReach(position) && (!this.approaching || distance(position, this.requested) <= 4.5)) {
      this.phase = 'arrived'
      const released = this.stop()
      this.finish(released ? undefined : 'STOP_UNCONFIRMED', this.report(), released)
      return
    }
    if (this.recovering && this.recoveryEnd !== undefined && this.arrived([this.recoveryEnd])) {
      this.recovering = false
      this.replans++
      this.beginPlan(this.goalFor(this.ends))
      return
    }
    if (this.pathStatus === 'noPath' && (this.path.length === 0 || distance(position, this.path.at(-1)!) < 0.7)) {
      if (this.recovering) this.recover()
      else if (this.trySafeFall()) this.beginPlan(this.goalFor(this.ends))
      else if (this.tryLethalFall()) this.beginPlan(this.goalFor(this.ends))
      else if (this.prepareApproach('requested-unreachable')) this.beginPlan(this.goalFor(this.ends))
      else if ((this.policy.unstickDig?.length ?? 0) > 0) this.recover()
      else this.fail('GOTO_NO_PATH', 'search-exhausted-within-movement-policy')
      return
    }
    if (distance(position, this.progressAnchor) >= 0.35) {
      this.progressAnchor = point(position)
      this.lastProgressAt = now
    }
    // Partial means A* is still calculating, not that the body is stuck.
    if (this.pathStatus !== 'partial' && now - this.lastProgressAt >= STUCK_MS) {
      this.recover()
      return
    }
    if (now - this.lastThreatCheck >= 1_000) {
      this.lastThreatCheck = now
      if (this.readThreats()) this.dirty = true
    }
    this.schedule(100)
  }

  private recover(): void {
    if (++this.recoveries > 2) {
      if (!this.tryUnstick()) this.fail('GOTO_STUCK', 'no-displacement-after-recovery')
      return
    }
    const p = this.bot.entity.position.floored()
    const candidates: End[] = []
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) for (const dy of [0, 1, -1]) {
      const node = { x: p.x + dx!, y: p.y + dy, z: p.z + dz! }
      if (this.tried.has(key(node))) continue
      const stand = standingAt(this.read, node)
      if (stand.state === 'valid') candidates.push({ node, position: stand.position! })
    }
    const candidate = candidates.sort((a, b) => distance(a.node, this.target) - distance(b.node, this.target))[0]
    if (candidate === undefined) {
      if (!this.tryUnstick()) this.fail('GOTO_STUCK', 'no-safe-recovery-waypoint')
      return
    }
    this.tried.add(key(candidate.node))
    this.recoveryEnd = candidate
    this.recovering = true
    this.reason = 'recovery-waypoint'
    this.replans++
    this.beginPlan(this.goalFor([candidate]))
  }

  private arrived(ends: End[]): boolean {
    if (!this.bot.entity.onGround) return false
    const p = this.bot.entity.position
    if (this.approaching && distance(p, this.requested) <= 4.5) {
      const stand = standingAt(this.read, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
      if (stand.state === 'valid') return true
    }
    return ends.some(end => Math.abs(p.x - end.position.x) <= 0.35 && Math.abs(p.z - end.position.z) <= 0.35
      && Math.abs(p.y - end.position.y) <= 0.15 && standingAt(this.read, end.node).state === 'valid')
  }

  private withinInteractionReach(p: Point): boolean {
    if (this.policy.intent === 'attack') return distance(p, this.requested) <= 3
    if (this.policy.intent !== 'interact') return true
    if (Math.floor(p.x) === this.target.x && Math.floor(p.z) === this.target.z
      && (Math.floor(p.y) === this.target.y || Math.floor(p.y) === this.target.y - 1)) return false
    return distance({ ...p, y: p.y + 1.5 }, { x: this.target.x + 0.5, y: this.target.y + 0.5, z: this.target.z + 0.5 }) <= 4.5
  }

  private readThreats(): boolean {
    this.threats = Object.values(this.bot.entities).filter(entity => THREATS.has(entity.name ?? '')
      && distance(entity.position, this.bot.entity.position) <= 16).slice(0, 16).map(entity => point(entity.position))
    const next = this.threats.map(p => key({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })).sort().join(';')
    const changed = next !== this.threatKey
    this.threatKey = next
    return changed
  }

  private actionEvent(kind: string, state: string, at: Point, detail: JsonValue = null): void {
    this.actions.push({ seq: (this.actions.at(-1)?.seq ?? 0) + 1, kind, state, at: point(at), detail })
    if (this.actions.length > 32) this.actions.shift()
  }

  private visible(block: Block): boolean {
    const eye = this.bot.entity.position.offset(0, (this.bot.entity as typeof this.bot.entity & { eyeHeight?: number }).eyeHeight ?? 1.62, 0)
    const toward = this.aimPoint(block).minus(eye)
    const length = toward.norm()
    if (length > 4.5 || length === 0) return false
    const direction = toward.normalize()
    // WorldSync.raycast skips unloaded cells; an interaction must not.
    for (let d = 0; d < length; d += 0.25) if (this.bot.blockAt(eye.plus(direction.scaled(d))) === null) return false
    const hit = this.bot.world.raycast(eye, direction, length + 0.05)
    // Open fence gates have an empty collision box but remain interactable.
    return hit === null ? manualDoor(block) && block.shapes.length === 0 : (hit as unknown as Block).position.equals(block.position)
  }

  private aimPoint(block: Block): Vec3 {
    // An open door leaf lies at the edge of the cell; aiming at cell centre
    // misses it, making a real raycast reject closing after crossing.
    const shape = manualDoor(block) ? block.shapes[0] : undefined
    return shape === undefined ? block.position.offset(0.5, 0.5, 0.5)
      : block.position.offset((shape[0]! + shape[3]!) / 2, (shape[1]! + shape[4]!) / 2, (shape[2]! + shape[5]!) / 2)
  }

  private tryDoors(): boolean {
    const pos = this.bot.entity.position
    for (const door of this.openedDoors.values()) {
      const side = pos[door.axis] - (door.position[door.axis] + 0.5)
      if (side * door.entrySide >= 0 || Math.abs(side) < 1.2 || distance(pos, door.position) > 4) continue
      if (Object.values(this.bot.entities).some(entity => Math.abs(entity.position.x - door.position.x - 0.5) < 0.9
        && Math.abs(entity.position.z - door.position.z - 0.5) < 0.9 && Math.abs(entity.position.y - door.position.y) < 2)) continue
      const block = this.bot.blockAt(new Vec3(door.position.x, door.position.y, door.position.z))
      if (block === null || block.name !== door.name || !this.visible(block)) continue
      if (block.getProperties().open !== true) { this.openedDoors.delete(key(door.position)); continue }
      this.startDoor(block, false)
      return true
    }
    let nearest = 0
    for (let i = 1; i < this.path.length; i++) if (distance(pos, this.path[i]!) < distance(pos, this.path[nearest]!)) nearest = i
    for (const node of this.path.slice(nearest, nearest + 8)) {
      const block = this.bot.blockAt(new Vec3(Math.floor(node.x), Math.floor(node.y), Math.floor(node.z)))
      if (block === null || !manualDoor(block) || block.getProperties().open === true) continue
      const lower = block.getProperties().half === 'upper' ? this.bot.blockAt(block.position.offset(0, -1, 0)) : block
      if (lower === null || distance(pos, lower.position.offset(0.5, 0, 0.5)) > 3.5 || !this.visible(lower)) continue
      this.startDoor(lower, true)
      return true
    }
    return false
  }

  private startDoor(block: Block, open: boolean): void {
    if (++this.doorActions > 8) { this.fail('GOTO_DOOR_LIMIT', 'door-interaction-budget'); return }
    if (!this.hardStop()) { this.fail('STOP_UNCONFIRMED', 'door-path-not-released'); return }
    // Empty hand prevents a removed/replaced door from turning use into place.
    if (this.bot.heldItem != null) {
      const slot = this.bot.inventory.slots.findIndex((item, index) => index >= 36 && index <= 44 && item == null)
      if (slot < 0) { this.fail('GOTO_DOOR_NO_EMPTY_HAND', 'door-requires-empty-hotbar-slot'); return }
      this.handSlotToRestore = this.bot.quickBarSlot
      this.bot.setQuickBarSlot(slot - 36)
    }
    const action: DoorAction = { kind: 'door', block, open, deadline: performance.now() + 2_000, issued: false }
    this.interaction = action
    this.phase = 'door'
    this.actionEvent('door', 'started', block.position, { open })
    // activateBlock awaits an uncancellable look before sending its packet.
    // Use the same 1.21.1 use-block packet, fenced after our own forced look.
    const aim = this.aimPoint(block)
    void this.bot.lookAt(aim, true).then(() => {
      if (!this.active || this.interaction !== action) return
      const current = this.bot.blockAt(block.position)
      if (current === null || current.stateId !== block.stateId || !this.visible(current) || this.bot.heldItem != null) {
        this.fail('GOTO_DOOR_CHANGED', 'door-changed-before-use'); return
      }
      if (!this.bot.supportFeature('blockPlaceHasInsideBlock')) { this.fail('GOTO_DOOR_UNSUPPORTED', 'unsupported-use-block-protocol'); return }
      this.bot._client.write('block_place', { location: block.position, direction: 1, hand: 0,
        cursorX: aim.x - block.position.x, cursorY: aim.y - block.position.y, cursorZ: aim.z - block.position.z,
        insideBlock: false, sequence: 0, worldBorderHit: false })
      this.bot.swingArm('right')
      action.issued = true
    }).catch(error => {
      if (this.active && this.interaction === action) this.fail('GOTO_DOOR_FAILED', String(error))
    })
    this.schedule(50)
  }

  private tickInteraction(now: number): void {
    const action = this.interaction!
    if (action.kind === 'unstick-dig') { this.tickDig(action, now); return }
    if (now >= action.deadline) { this.actionEvent('door', 'timeout', action.block.position); this.fail('GOTO_DOOR_TIMEOUT', 'door-readback-timeout'); return }
    const block = this.bot.blockAt(action.block.position)
    const upper = action.block.name.endsWith('_door') ? this.bot.blockAt(action.block.position.offset(0, 1, 0)) : null
    const upperOk = !action.block.name.endsWith('_door') || (upper !== null && upper.name === action.block.name && upper.getProperties().open === action.open)
    if (action.issued && upperOk && block !== null && block.name === action.block.name && block.getProperties().open === action.open) {
      if (action.confirmedAt === undefined) action.confirmedAt = now
      if (now - action.confirmedAt >= 200) {
        this.actionEvent('door', 'readback', block.position, { open: action.open, stateId: block.stateId })
        if (action.open) {
          const axis = doorAxis(block)
          this.openedDoors.set(key(block.position), { position: point(block.position), name: block.name, axis,
            entrySide: this.bot.entity.position[axis] - block.position[axis] - 0.5 })
        } else this.openedDoors.delete(key(block.position))
        this.interaction = undefined
        this.restoreHand()
        this.dirty = false
        this.replans++
        this.beginPlan(this.goalFor(this.ends))
        return
      }
    } else delete action.confirmedAt
    this.schedule(50)
  }

  private restoreHand(): void {
    if (this.handSlotToRestore === undefined) return
    const slot = this.handSlotToRestore
    this.handSlotToRestore = undefined
    this.bot.setQuickBarSlot(slot)
  }

  private tryUnstick(): boolean {
    if (this.dug.size >= 2 || (this.policy.unstickDig?.length ?? 0) === 0) return false
    const p = this.bot.entity.position.floored()
    const dx = this.target.x - p.x
    const dz = this.target.z - p.z
    const front = Math.abs(dx) >= Math.abs(dz) ? { x: p.x + Math.sign(dx), z: p.z } : { x: p.x, z: p.z + Math.sign(dz) }
    for (const at of [{ x: p.x, y: p.y + 2, z: p.z }, { ...front, y: p.y + 1 }, { ...front, y: p.y }]) {
      if (this.dug.has(key(at))) continue
      if (!this.policy.unstickDig!.some(block => key(block) === key(at))) continue
      const rejection = unstickObstacle(this.read, at, p, this.policy.unstickDig!)
      const block = this.bot.blockAt(new Vec3(at.x, at.y, at.z))
      if (rejection !== undefined || block === null) { this.actionEvent('unstick-dig', 'rejected', at, rejection ?? 'unloaded'); continue }
      const digMs = this.bot.digTime(block)
      if (!block.diggable || block.hardness < 0 || !block.canHarvest(this.bot.heldItem?.type ?? null)
        || !Number.isFinite(digMs) || digMs > 4_000 || !this.bot.canDigBlock(block) || !this.visible(block)) {
        this.actionEvent('unstick-dig', 'rejected', at, 'tool-hardness-or-reach'); continue
      }
      if (this.timeoutMs - (performance.now() - this.startedAt) < digMs + 800) {
        this.actionEvent('unstick-dig', 'rejected', at, 'insufficient-time'); continue
      }
      if (!this.hardStop()) { this.fail('STOP_UNCONFIRMED', 'unstick-path-not-released'); return true }
      this.dug.add(key(at))
      const action: DigAction = { kind: 'unstick-dig', block, deadline: performance.now() + digMs + 1_500, issued: false }
      this.interaction = action
      this.phase = 'unstick-dig'
      this.actionEvent('unstick-dig', 'started', at, { name: block.name, digMs, count: this.dug.size })
      void this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true).then(() => {
        if (!this.active || this.interaction !== action) return
        const current = this.bot.blockAt(block.position)
        if (current === null || current.stateId !== block.stateId
          || unstickObstacle(this.read, at, this.bot.entity.position, this.policy.unstickDig!) !== undefined
          || !current.canHarvest(this.bot.heldItem?.type ?? null) || !this.visible(current)) {
          this.fail('GOTO_UNSTICK_CHANGED', 'unstick-block-changed'); return
        }
        // 'ignore' skips the library's uncancellable look continuation. Its
        // dig task is installed synchronously, so stopDigging can now stop it.
        action.issued = true
        return this.bot.dig(current, 'ignore')
      }).catch(error => {
        if (this.active && this.interaction === action) this.fail('GOTO_UNSTICK_FAILED', String(error))
      })
      this.schedule(50)
      return true
    }
    return false
  }

  private tickDig(action: DigAction, now: number): void {
    if (now >= action.deadline) {
      this.actionEvent('unstick-dig', 'timeout', action.block.position)
      this.fail('GOTO_UNSTICK_TIMEOUT', 'dig-server-readback-timeout')
      return
    }
    const block = this.bot.blockAt(action.block.position)
    const serverName = action.serverState === undefined ? undefined : this.bot.registry.blocksByStateId[action.serverState]?.name
    const air = serverName === 'air' || serverName === 'cave_air' || serverName === 'void_air'
    if (action.issued && air && block !== null && block.stateId === action.serverState) {
      if (action.confirmedAt === undefined) action.confirmedAt = now
      if (now - action.confirmedAt >= 200 && this.bot.targetDigBlock == null) {
        this.actionEvent('unstick-dig', 'readback', block.position, { before: action.block.name, after: block.name,
          stateId: block.stateId, source: action.source ?? null })
        this.interaction = undefined
        this.dirty = false
        this.recovering = false
        this.replans++
        if (this.refreshEnds()) this.beginPlan(this.goalFor(this.ends))
        return
      }
    } else delete action.confirmedAt
    this.schedule(50)
  }

  private hardStop(): boolean {
    let stopped = true
    try { this.bot.pathfinder.stop() } catch { stopped = false }
    try { this.bot.pathfinder.setGoal(null) } catch { stopped = false }
    try { this.bot.clearControlStates() } catch { stopped = false }
    return stopped && this.released()
  }

  private released(): boolean {
    return this.bot.pathfinder.goal === null && !this.bot.pathfinder.isMoving()
      && !(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'] as const).some(key => this.bot.getControlState(key))
  }

  private fail(code: string, reason: string): void {
    this.reason = reason
    this.phase = 'failed'
    const released = this.stop()
    this.finish(released ? code : 'STOP_UNCONFIRMED', this.report(), released)
  }

  private listen(event: string, listener: (...args: any[]) => void): void {
    ;(this.bot as EventEmitter).on(event, listener)
    this.listeners.push([event, listener])
  }

  private schedule(ms: number): void {
    if (!this.active) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    const remaining = Math.max(0, this.timeoutMs - (performance.now() - this.startedAt))
    this.timer = setTimeout(() => {
      try { this.tick() } catch (error) {
        this.fail('GOTO_ERROR', error instanceof Error ? error.message : String(error))
      }
    }, Math.min(ms, remaining))
  }
}
