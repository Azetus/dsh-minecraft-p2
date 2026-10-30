/**
 * Fake world + actuator for controller tests. Boundary fake only: it provides
 * the actuator and sense contracts, never a game simulation of P2 itself.
 */

import { P2Controller } from '../src/controller/controller.ts'
import type { FactSource, SenseResult } from '../src/controller/controller.ts'
import type {
  ActionHandle,
  ActionOutcome,
  ActionRequest,
  ActuatorPort,
  LeaseGrant,
  ReleaseReport,
} from '../src/controller/types.ts'
import type { P2ControllerOptions } from '../src/controller/controller.ts'

export type WorldPosition = {
  x: number
  y: number
  z: number
  dimension?: string
  inWater?: boolean
  oxygen?: number
}

export type World = {
  position: WorldPosition
  inventory: Array<{ name: string; count: number }>
  blocks: Array<{ name: string; x: number; y: number; z: number }>
  entities: Array<{ id?: number; name: string; kind?: string; position: { x: number; y: number; z: number }; distance?: number }>
  health: number
  oxygen: number
  failing: Set<string>
}

export type FakeAction = {
  request: ActionRequest
  grant: LeaseGrant
  outcome: ActionOutcome
  stopCalls: number
  polls: number
  delayTicks: number
}

export class FakeActuator implements ActuatorPort {
  readonly actions: FakeAction[] = []
  readonly stopRequests: number[] = []
  releaseReport: ReleaseReport = { status: 'released' }
  startThrows: Error | undefined
  actionDelayTicks = 0
  private readonly world: World
  private readonly effects: (action: FakeAction) => void

  constructor(world: World, effects?: (action: FakeAction) => void) {
    this.world = world
    this.effects = effects ?? (action => defaultEffect(this.world, action))
  }

  start(request: ActionRequest, grant: LeaseGrant): ActionHandle {
    if (this.startThrows !== undefined) throw this.startThrows
    const action: FakeAction = {
      request,
      grant,
      outcome: { status: 'running' },
      stopCalls: 0,
      polls: 0,
      delayTicks: this.actionDelayTicks,
    }
    this.actions.push(action)
    return {
      poll: () => {
        if (action.outcome.status !== 'running') return action.outcome
        action.polls += 1
        if (action.polls <= action.delayTicks) return action.outcome
        this.effects(action)
        action.outcome = { status: 'succeeded', result: { act: request.act } }
        return action.outcome
      },
      stop: () => {
        action.stopCalls += 1
        if (action.outcome.status === 'running') action.outcome = { status: 'cancelled' }
      },
    }
  }

  stop(now: number): void {
    this.stopRequests.push(now)
    for (const action of this.actions) {
      if (action.outcome.status === 'running') action.outcome = { status: 'cancelled' }
    }
  }

  release(): ReleaseReport {
    return this.releaseReport
  }

  get last(): FakeAction {
    const action = this.actions[this.actions.length - 1]
    if (action === undefined) throw new Error('no action was started')
    return action
  }
}

function defaultEffect(world: World, action: FakeAction): void {
  const intent = action.request.intent
  const args = action.request.args
  if (intent.startsWith('goto:') || intent.startsWith('follow:')) {
    if (typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number') {
      world.position = { ...world.position, x: args.x, y: args.y, z: args.z }
    }
    return
  }
  if (intent.startsWith('dig:')) {
    const x = typeof args.x === 'number' ? args.x : undefined
    const y = typeof args.y === 'number' ? args.y : undefined
    const z = typeof args.z === 'number' ? args.z : undefined
    if (x === undefined || y === undefined || z === undefined) return
    const index = world.blocks.findIndex(block => block.x === x && block.y === y && block.z === z)
    if (index >= 0) {
      const [block] = world.blocks.splice(index, 1)
      if (block !== undefined) addItem(world, block.name, 1)
    }
    return
  }
  if (intent === 'escape-water') {
    world.position = { ...world.position, inWater: false, y: world.position.y + 1 }
    world.oxygen = 20
    return
  }
  if (intent === 'retreat-creeper') {
    world.position = { ...world.position, x: world.position.x + 12 }
    return
  }
}

export function addItem(world: World, name: string, count: number): void {
  const existing = world.inventory.find(item => item.name === name)
  if (existing === undefined) world.inventory.push({ name, count })
  else existing.count += count
}

export type Harness = {
  world: World
  actuator: FakeActuator
  controller: P2Controller
  clock: { now: number }
  tick: (ms?: number) => ReturnType<P2Controller['tick']>
  run: (ticks: number, ms?: number) => ReturnType<P2Controller['tick']>
}

const FACT_SOURCES: Record<string, FactSource> = {
  position: { op: 'position', scope: 'world:overworld' },
  health: { op: 'health', scope: 'world:overworld' },
  inventory: { op: 'inventory', scope: 'world:overworld' },
  nearbyBlocks: { op: 'blocks', scope: 'world:overworld' },
  entities: { op: 'entities', scope: 'world:overworld' },
}

export function createHarness(options: Partial<P2ControllerOptions> & {
  world?: Partial<World>
  effects?: (action: FakeAction) => void
  actionDelayTicks?: number
} = {}): Harness {
  const { world: worldOverrides, effects, actionDelayTicks, ...controllerOptions } = options
  const world: World = {
    position: { x: 0, y: 64, z: 0, dimension: 'overworld', inWater: false, ...worldOverrides?.position },
    inventory: worldOverrides?.inventory ?? [],
    blocks: worldOverrides?.blocks ?? [],
    entities: worldOverrides?.entities ?? [],
    health: worldOverrides?.health ?? 20,
    oxygen: worldOverrides?.oxygen ?? 20,
    failing: worldOverrides?.failing ?? new Set(),
  }
  const clock = { now: 1000 }
  const actuator = new FakeActuator(world, effects)
  actuator.actionDelayTicks = actionDelayTicks ?? 0
  const sense = {
    sample(source: FactSource): SenseResult {
      if (world.failing.has(source.op)) return { status: 'unknown', reason: 'sense-unavailable' }
      switch (source.op) {
        case 'position':
          return { status: 'ok', value: { ...world.position } }
        case 'health':
          return { status: 'ok', value: { health: world.health, food: 20, oxygen: world.oxygen } }
        case 'inventory':
          return { status: 'ok', value: world.inventory.map(item => ({ ...item })) }
        case 'blocks':
          return {
            status: 'ok',
            value: world.blocks.map(block => ({ ...block })),
          }
        case 'entities':
          return {
            status: 'ok',
            value: world.entities.map(entity => ({ ...entity, position: { ...entity.position } })),
          }
        default:
          return { status: 'unknown', reason: `no source for ${source.op}` }
      }
    },
  }
  const controller = new P2Controller({
    actuator,
    sense,
    facts: FACT_SOURCES,
    now: () => clock.now,
    coherenceWindowMs: 500,
    factTtlMs: 1000,
    refreshIntervalMs: 100,
    stopTimeoutMs: 2000,
    verificationTimeoutMs: 500,
    unknownDeadlineMs: 600,
    ...controllerOptions,
  })
  return {
    world,
    actuator,
    controller,
    clock,
    tick: (ms = 100) => {
      clock.now += ms
      return controller.tick()
    },
    run: (ticks: number, ms = 100) => {
      clock.now += ms
      let status = controller.tick()
      for (let index = 1; index < ticks; index += 1) {
        clock.now += ms
        status = controller.tick()
      }
      return status
    },
  }
}


