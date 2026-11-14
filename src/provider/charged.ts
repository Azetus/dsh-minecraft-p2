/**
 * Read a crossbow's charged projectiles from the item representation the
 * adapter already parsed. This is deliberately best-effort:
 *
 * - component-era stacks expose `charged_projectiles` as `{projectiles: Slot[]}`;
 * - pre-1.20.5 stacks expose NBT `ChargedProjectiles` / `Charged`;
 * - anything else is unknown, never "empty".
 *
 * The provider is the only layer allowed to know these shapes. The BodyApi
 * exposes the tri-state `Item.chargedProjectiles` instead.
 */

type ChargedSlot = {
  itemId?: unknown
  itemCount?: unknown
  id?: unknown
}

type ChargedComponent = {
  type?: unknown
  data?: {
    projectiles?: unknown
  }
}

type ChargedItem = {
  components?: unknown
  componentMap?: unknown
  nbt?: unknown
}

/**
 * Return charged projectile names, `[]` when the representation proves the
 * crossbow is empty, and `undefined` when the representation cannot tell.
 * `nameOf` returns undefined for an id outside the registry.
 */
export function readChargedProjectiles(
  item: ChargedItem,
  nameOf: (id: number) => string | undefined,
): string[] | undefined {
  const components = item.components
  if (Array.isArray(components)) {
    const component = components.find(entry =>
      isRecord(entry) && entry.type === 'charged_projectiles') as ChargedComponent | undefined
    if (component === undefined) return []
    const projectiles = component.data?.projectiles
    if (!Array.isArray(projectiles)) return undefined
    if (projectiles.length === 0) return []
    const names: string[] = []
    for (const slot of projectiles) {
      if (!isRecord(slot)) return undefined
      const name = slotName(slot, nameOf)
      if (name === undefined) return undefined
      names.push(name)
    }
    return names
  }

  // A components-capable item whose component list was not parsed is not the
  // same thing as a known-empty crossbow. Do not fall through to NBT here.
  if (item.componentMap !== undefined) return undefined

  if (item.nbt !== undefined) {
    if (item.nbt === null) return []
    return readNbtCharged(item.nbt, nameOf)
  }

  return undefined
}

function readNbtCharged(nbt: unknown, nameOf: (id: number) => string | undefined): string[] | undefined {
  const projectiles = compoundTag(nbt, 'ChargedProjectiles')
  if (projectiles === undefined) {
    // `Charged` alone proves "charged" but not that the projectile is an
    // arrow; the caller needs the list to distinguish arrow from firework.
    const charged = byteTag(compoundTag(nbt, 'Charged'))
    return charged === 1 ? undefined : []
  }
  if (!isRecord(projectiles) || projectiles.type !== 'list') return undefined
  const listValue = projectiles.value
  if (!isRecord(listValue) || !Array.isArray(listValue.value)) return undefined
  if (listValue.value.length === 0) return []
  const names: string[] = []
  for (const entry of listValue.value) {
    if (!isRecord(entry)) return undefined
    const idTag = compoundTag(entry, 'id')
    if (!isRecord(idTag) || idTag.type !== 'string' || typeof idTag.value !== 'string') return undefined
    const name = normalizeName(idTag.value)
    if (name === undefined) return undefined
    names.push(name)
  }
  return names
}

function slotName(slot: ChargedSlot, nameOf: (id: number) => string | undefined): string | undefined {
  // Some 26.1 protocol builds expose the slot fields in the opposite order
  // (`itemCount` carries the item id and vice versa). Prefer a candidate that
  // is a known projectile name instead of hardcoding a version.
  const candidates: string[] = []
  if (typeof slot.itemId === 'number') {
    const name = nameOf(slot.itemId)
    if (name !== undefined) candidates.push(name)
  }
  if (typeof slot.itemCount === 'number') {
    const name = nameOf(slot.itemCount)
    if (name !== undefined && !candidates.includes(name)) candidates.push(name)
  }
  const projectile = candidates.find(isProjectileName)
  if (projectile !== undefined) return projectile
  if (candidates.length > 0) return candidates[0]
  // Some adapters keep an already-normalized name on the slot.
  if (typeof slot.id === 'string') return normalizeName(slot.id)
  return undefined
}

function isProjectileName(name: string): boolean {
  return name === 'arrow' || name.endsWith('_arrow') || name === 'firework_rocket'
}

function compoundTag(value: unknown, key: string): unknown {
  if (!isRecord(value) || value.type !== 'compound' || !isRecord(value.value)) return undefined
  return value.value[key]
}

function byteTag(value: unknown): number | undefined {
  if (!isRecord(value) || value.type !== 'byte' || typeof value.value !== 'number') return undefined
  return value.value
}

function normalizeName(value: string): string | undefined {
  const name = value.replace(/^minecraft:/u, '').trim()
  return name.length === 0 ? undefined : name
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
