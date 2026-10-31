import type { Bot } from 'mineflayer'
import type { EventEmitter } from 'node:events'
import type { Movements, Pathfinder, PartiallyComputedPath, goals } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { JsonValue } from '../contracts/types.ts'
import { standingAt, WALK_HAZARDS } from '../port/terrain.ts'
import type { Vec3 as Point, BlockInfo } from '../port/types.ts'

const SLICE_MS = 5
const SEARCH_MS = 2_000
const MAX_NODES = 12_000
const STUCK_MS = 3_000
const THREATS = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom', 'blaze', 'wither_skeleton', 'piglin_brute', 'zoglin'])
type PathResult = Pick<PartiallyComputedPath, 'status' | 'path' | 'visitedNodes' | 'generatedNodes'>
type End = { node: Point; position: Point }
type Finish = (code: string | undefined, observed: JsonValue, released: boolean) => void

export function configureNavigation(bot: Bot, movements: Movements): void {
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = false
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
  for (const name of WALK_HAZARDS) {
    const block = bot.registry.blocksByName[name]
    if (block !== undefined) movements.blocksToAvoid.add(block.id)
  }
  movements.exclusionAreasStep.push(block => {
    if (block.position === undefined) return 100
    const below = bot.blockAt(block.position.offset(0, -1, 0))
    if (below === null || WALK_HAZARDS.has(below.name)) return 100
    // Do not enter water from land. A bot already in water may swim out.
    if (block.name === 'water' && !(bot.entity as typeof bot.entity & { isInWater?: boolean }).isInWater) return 100
    return 0
  })
  const getNeighbors = movements.getNeighbors.bind(movements)
  movements.getNeighbors = node => getNeighbors(node).filter(next => {
    if (next.y >= node.y) return true
    if (node.y - next.y > 2) return false
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

/** One bounded navigation owner. It never digs, places, or pulses raw inputs. */
export class NavigationRun {
  private active = true
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners: Array<[string, (...args: any[]) => void]> = []
  private readonly startedAt = performance.now()
  private readonly from: Point
  private readonly target: Point
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

  constructor(
    private readonly bot: Bot,
    private readonly movements: Movements,
    target: Point,
    private readonly range: number,
    private readonly timeoutMs: number,
    private readonly finish: Finish,
  ) {
    this.from = point(bot.entity.position)
    this.target = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) }
    this.progressAnchor = this.from
    this.lastPosition = this.from
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
  }

  start(): void {
    if (![this.target.x, this.target.y, this.target.z, this.range, this.timeoutMs].every(Number.isFinite)
      || this.range < 0 || this.range > 8 || this.timeoutMs <= 0) {
      this.fail('BAD_ARGS', 'invalid-navigation-parameters')
      return
    }
    if (!this.refreshEnds()) return
    this.readThreats()
    this.listen('path_update', (result: PathResult) => {
      if (!this.active || this.phase === 'planning') return
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
      phase: this.phase, pathStatus: this.pathStatus, reason: this.reason,
      elapsedMs: Math.round(performance.now() - this.startedAt), searchMs: Math.round(this.searchMs),
      replans: this.replans, recoveries: this.recoveries, visitedNodes: this.visitedNodes,
      generatedNodes: this.generatedNodes, distanceTravelled: this.travelled,
      searchBudget: { sliceMs: SLICE_MS, timeMs: SEARCH_MS, nodes: MAX_NODES, costMargin: 48 },
      currentBlock: this.read(this.bot.entity.position)?.name ?? null, obstruction: this.obstruction,
      candidates: this.ends.slice(0, 8).map(end => end.position), nearbyCandidates: this.suggestions,
      bestReachable: this.path.at(-1) ?? null,
    }
  }

  stop(): boolean {
    if (!this.active) return this.released()
    this.active = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.planner = undefined
    for (const [event, listener] of this.listeners) (this.bot as EventEmitter).removeListener(event, listener)
    this.listeners.length = 0
    const index = this.movements.exclusionAreasStep.indexOf(this.threatCost)
    if (index >= 0) this.movements.exclusionAreasStep.splice(index, 1)
    return this.hardStop()
  }

  private read = (p: Point): BlockInfo | null => {
    const block = this.bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
    return block === null ? null : { name: block.name, loaded: true, collision: block.shapes }
  }

  private refreshEnds(): boolean {
    const ends: End[] = []
    let unknown = false
    const radius = Math.ceil(this.range)
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) {
      if (Math.hypot(dx, dy, dz) > this.range) continue
      const node = { x: this.target.x + dx, y: this.target.y + dy, z: this.target.z + dz }
      const result = standingAt(this.read, node)
      if (result.state === 'valid') ends.push({ node, position: result.position! })
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
    this.fail(unknown ? 'GOTO_TARGET_UNLOADED' : 'GOTO_INVALID_TARGET', unknown ? 'target-observation-incomplete' : 'no-safe-standing-space')
    return false
  }

  private goalFor(ends: End[]): goals.Goal {
    const allowed = new Set(ends.map(end => key(end.node)))
    const min = { x: Math.min(...ends.map(e => e.node.x)), y: Math.min(...ends.map(e => e.node.y)), z: Math.min(...ends.map(e => e.node.z)) }
    const max = { x: Math.max(...ends.map(e => e.node.x)), y: Math.max(...ends.map(e => e.node.y)), z: Math.max(...ends.map(e => e.node.z)) }
    return {
      isEnd: node => allowed.has(key(node)),
      // Chebyshev lower bound to the accepted set: zero at EVERY endpoint,
      // including GoalNear's range; one legal step changes each axis by <= 1
      // except drops (up to 2), so halve vertical distance.
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
    if (this.generatedNodes > MAX_NODES) { this.fail('GOTO_SEARCH_LIMIT', 'node-budget'); return }
    const position = this.bot.entity.position
    this.travelled += distance(position, this.lastPosition)
    this.lastPosition = point(position)
    if (this.arrived(this.ends)) {
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
    if (++this.recoveries > 2) { this.fail('GOTO_STUCK', 'no-displacement-after-recovery'); return }
    const p = this.bot.entity.position.floored()
    const candidates: End[] = []
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) for (const dy of [0, 1, -1]) {
      const node = { x: p.x + dx!, y: p.y + dy, z: p.z + dz! }
      if (this.tried.has(key(node))) continue
      const stand = standingAt(this.read, node)
      if (stand.state === 'valid') candidates.push({ node, position: stand.position! })
    }
    const candidate = candidates.sort((a, b) => distance(a.node, this.target) - distance(b.node, this.target))[0]
    if (candidate === undefined) { this.fail('GOTO_STUCK', 'no-safe-recovery-waypoint'); return }
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
    return ends.some(end => Math.abs(p.x - end.position.x) <= 0.35 && Math.abs(p.z - end.position.z) <= 0.35
      && Math.abs(p.y - end.position.y) <= 0.15 && standingAt(this.read, end.node).state === 'valid')
  }

  private readThreats(): boolean {
    this.threats = Object.values(this.bot.entities).filter(entity => THREATS.has(entity.name ?? '')
      && distance(entity.position, this.bot.entity.position) <= 16).slice(0, 16).map(entity => point(entity.position))
    const next = this.threats.map(p => key({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })).sort().join(';')
    const changed = next !== this.threatKey
    this.threatKey = next
    return changed
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
