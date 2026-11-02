import { cellKey } from '../../src/motion/model/block.ts'
import type {
  Box,
  Cell,
  CollisionBox,
  EntityView,
  InputControl,
  MotionWorld,
  RawBlock,
  SelfView,
} from '../../src/motion/model/types.ts'
import type { MatrixField } from '../../src/motion/matrix/scenarios.ts'
import { matrixBlockMap } from '../../src/motion/matrix/scenarios.ts'

export const FULL_CUBE: readonly CollisionBox[] = [[0, 0, 0, 1, 1, 1] as const]
export const HALF_CUBE: readonly CollisionBox[] = [[0, 0, 0, 1, 0.5, 1] as const]

export function rawBlock(
  name: string,
  collision: readonly CollisionBox[] | undefined,
  state: Readonly<Record<string, string>> = {},
  loaded = true,
): RawBlock {
  return {
    loaded,
    name,
    state,
    ...(collision === undefined ? {} : { collision }),
  }
}

function collisionFor(name: string, state: Readonly<Record<string, string>> | undefined): readonly CollisionBox[] {
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return []
  if (name.endsWith('_door')) return state?.open === 'true' ? [] : FULL_CUBE
  return FULL_CUBE
}

/** In-memory MotionWorld for pure model tests; records requests, never plays. */
export class FixtureWorld implements MotionWorld {
  readonly blocks = new Map<string, RawBlock>()
  readonly inputs = new Map<InputControl, boolean>()
  readonly actions: string[] = []
  readonly looks: Array<{ yaw: number; pitch: number }> = []
  selfView: SelfView = {
    pos: { x: 0.5, y: 64, z: 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    sneaking: false,
    sprinting: false,
    health: 20,
  }
  private tickCount = 0
  private readonly callbacks = new Set<() => void>()

  self(): SelfView {
    return this.selfView
  }

  blockAt(p: Cell): RawBlock | null {
    return this.blocks.get(cellKey({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })) ?? null
  }

  entities(_box: Box): readonly EntityView[] {
    return []
  }

  tick(): number {
    return this.tickCount
  }

  onTick(cb: () => void): () => void {
    this.callbacks.add(cb)
    return () => this.callbacks.delete(cb)
  }

  advance(): void {
    this.tickCount += 1
    for (const cb of [...this.callbacks]) cb()
  }

  setInput(control: InputControl, on: boolean): void {
    this.inputs.set(control, on)
    this.actions.push(`input:${control}:${on}`)
  }

  look(yaw: number, pitch: number): void {
    this.looks.push({ yaw, pitch })
    this.selfView = { ...this.selfView, yaw, pitch }
  }

  useOn(p: Cell): void {
    this.actions.push(`use:${p.x},${p.y},${p.z}`)
  }

  place(p: Cell, item: string): void {
    this.actions.push(`place:${p.x},${p.y},${p.z}:${item}`)
  }

  dig(p: Cell): void {
    this.actions.push(`dig:${p.x},${p.y},${p.z}`)
  }

  attack(entityId: string): void {
    this.actions.push(`attack:${entityId}`)
  }

  releaseAll(): void {
    this.inputs.clear()
    this.actions.push('release')
  }
}

export function buildFixture(field: MatrixField): FixtureWorld {
  const world = new FixtureWorld()
  for (const [key, spec] of matrixBlockMap(field)) {
    world.blocks.set(key, rawBlock(spec.name, collisionFor(spec.name, spec.state), spec.state ?? {}))
  }
  world.selfView = {
    ...world.selfView,
    pos: { x: field.start.x + 0.5, y: field.start.y, z: field.start.z + 0.5 },
  }
  return world
}
