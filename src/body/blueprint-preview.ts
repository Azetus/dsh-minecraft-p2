import type { ObserveVec3 } from '../contracts/protocol.ts'
import { countItem, isAirName, matchesExpected } from '../mind/plan.ts'
import { parseBlueprint } from '../mind/blueprint.ts'
import type { ClientPort } from '../port/index.ts'

export type BlueprintConflict = {
  x: number
  y: number
  z: number
  expected: string
  current: string
  solid?: boolean
  clearable: boolean
}

export type BlueprintPreview = {
  ok: boolean
  at: number
  blocks: number
  required: Record<string, number>
  missing: Record<string, number>
  satisfied: number
  unknownTotal: number
  unknown: ObserveVec3[]
  conflictTotal: number
  conflicts: BlueprintConflict[]
  invalid: string[]
}

const MAX_REPORTED_CONFLICTS = 128
const MAX_REPORTED_UNKNOWN = 64

/** Conservative defaults for a preview; policy can only tighten them later. */
const PROTECTED = new Set([
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
  'hopper', 'dropper', 'dispenser', 'brewing_stand', 'enchanting_table',
  'beacon', 'spawner', 'bedrock', 'obsidian', 'water', 'lava',
])

/**
 * Dry-run a blueprint against the current world. It only reads blocks and
 * inventory; no material is consumed and no block is cleared or placed.
 */
export function previewBlueprint(
  port: ClientPort,
  value: unknown,
  at: number,
): BlueprintPreview {
  const parsed = parseBlueprint(value)
  if (!parsed.ok) {
    return {
      ok: false,
      at,
      blocks: 0,
      required: {},
      missing: {},
      satisfied: 0,
      unknownTotal: 0,
      unknown: [],
      conflictTotal: 0,
      conflicts: [],
      invalid: parsed.errors,
    }
  }

  const { blueprint } = parsed
  const inventory = port.inventory()
  const required: Record<string, number> = {}
  const need: Record<string, number> = {}
  let satisfied = 0
  const unknown: ObserveVec3[] = []
  let unknownTotal = 0
  const conflicts: BlueprintConflict[] = []
  let conflictTotal = 0

  for (const block of blueprint.blocks) {
    required[block.name] = (required[block.name] ?? 0) + 1
    const current = port.blockAt(block)
    if (current === null || !current.loaded) {
      unknownTotal += 1
      if (unknown.length < MAX_REPORTED_UNKNOWN) unknown.push({ x: block.x, y: block.y, z: block.z })
      need[block.name] = (need[block.name] ?? 0) + 1
      continue
    }
    if (matchesExpected(current, { name: block.name, ...(block.state === undefined ? {} : { state: block.state }) })) {
      satisfied += 1
      continue
    }
    need[block.name] = (need[block.name] ?? 0) + 1
    if (!isAirName(current.name)) {
      conflictTotal += 1
      if (conflicts.length < MAX_REPORTED_CONFLICTS) {
        conflicts.push({
          x: block.x,
          y: block.y,
          z: block.z,
          expected: block.name,
          current: current.name,
          ...(current.solid === undefined ? {} : { solid: current.solid }),
          clearable: isClearable(current.name),
        })
      }
    }
  }

  const missing: Record<string, number> = {}
  for (const [name, count] of Object.entries(need)) {
    const shortage = count - countItem(inventory, name)
    if (shortage > 0) missing[name] = shortage
  }

  return {
    ok: unknownTotal === 0
      && conflictTotal === 0
      && Object.keys(missing).length === 0,
    at,
    blocks: blueprint.blocks.length,
    required,
    missing,
    satisfied,
    unknownTotal,
    unknown,
    conflictTotal,
    conflicts,
    invalid: [],
  }
}

function isClearable(name: string): boolean {
  return !PROTECTED.has(name.replace(/^minecraft:/u, ''))
}
