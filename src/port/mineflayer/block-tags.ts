import type { Bot } from 'mineflayer'

/**
 * Per-connection block tag index. `mineflayer` does not expose the `tags`
 * packet, but `minecraft-protocol` emits every decoded packet by name, so the
 * adapter can capture the vanilla server tags without adding a dependency.
 *
 * The raw packet stores block ids. Tags can arrive before the bot registry is
 * ready, so mapping is lazy. When tags are absent the index reports `ready:
 * false`; callers must fall back to name rules, never assume "no tag".
 */
export type BlockTagIndex = {
  /** True only after a tags packet was received and mapped against the registry. */
  readonly ready: boolean
  /** Number of raw `minecraft:block` tags in the last packet. */
  readonly tagCount: number
  /** Number of block ids that received at least one tag. */
  readonly blockTagCount: number
  readonly lastError: string | undefined
  /** Shared immutable set for a block id; undefined when unknown/not ready. */
  tagsFor(blockId: number): ReadonlySet<string> | undefined
  reset(): void
}

type TagClient = {
  on(event: 'tags', listener: (packet: unknown) => void): void
}

type RegistryLike = {
  blocks?: Record<string | number, { name?: string } | undefined>
}

type RawTag = { tagName?: unknown; entries?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const EMPTY_TAGS: ReadonlySet<string> = new Set()

class MineflayerBlockTagIndex implements BlockTagIndex {
  private raw = new Map<string, Set<number>>()
  private mapped: Map<number, ReadonlySet<string>> | undefined
  private mappedBlockCount = 0
  private readyFlag = false
  private error: string | undefined

  constructor(private readonly bot: Bot) {
    const client = (bot as unknown as { _client?: TagClient })._client
    if (client === undefined) {
      this.error = 'bot._client is unavailable'
      return
    }
    client.on('tags', packet => this.accept(packet))
    if (typeof bot.once === 'function') bot.once('end', () => this.reset())
  }

  get ready(): boolean {
    this.ensureMapped()
    return this.readyFlag
  }

  get tagCount(): number {
    return this.raw.size
  }

  get blockTagCount(): number {
    this.ensureMapped()
    return this.mappedBlockCount
  }

  get lastError(): string | undefined {
    return this.error
  }

  tagsFor(blockId: number): ReadonlySet<string> | undefined {
    this.ensureMapped()
    if (!this.readyFlag) return undefined
    // Tags are authoritative once ready: a known block with no tags is an empty
    // set, not "unknown". Only a not-ready index returns undefined.
    return this.mapped?.get(blockId) ?? EMPTY_TAGS
  }

  reset(): void {
    this.raw = new Map()
    this.mapped = undefined
    this.mappedBlockCount = 0
    this.readyFlag = false
  }

  private accept(packet: unknown): void {
    if (!isRecord(packet) || !Array.isArray(packet.tags)) {
      this.error = 'tags packet has no tags array'
      return
    }
    const next = new Map<string, Set<number>>()
    for (const group of packet.tags) {
      if (!isRecord(group)) continue
      const tagType = group.tagType
      if (tagType !== 'minecraft:block' && tagType !== 'block') continue
      if (!Array.isArray(group.tags)) continue
      for (const raw of group.tags as RawTag[]) {
        if (!isRecord(raw) || typeof raw.tagName !== 'string' || !Array.isArray(raw.entries)) continue
        const entries = new Set<number>()
        for (const entry of raw.entries) {
          if (typeof entry === 'number' && Number.isFinite(entry)) entries.add(entry)
        }
        next.set(raw.tagName, entries)
      }
    }
    this.raw = next
    this.mapped = undefined
    this.mappedBlockCount = 0
    this.readyFlag = false
    this.error = undefined
    this.ensureMapped()
  }

  private ensureMapped(): void {
    if (this.readyFlag || this.raw.size === 0) return
    const registry = (this.bot as unknown as { registry?: RegistryLike }).registry
    const blocks = registry?.blocks
    if (blocks === undefined) return
    const mapped = new Map<number, Set<string>>()
    for (const [tagName, ids] of this.raw) {
      for (const id of ids) {
        if (blocks[id] === undefined) continue
        const set = mapped.get(id)
        if (set === undefined) mapped.set(id, new Set([tagName]))
        else set.add(tagName)
      }
    }
    this.mapped = mapped
    this.mappedBlockCount = mapped.size
    this.readyFlag = true
  }
}

const indexes = new WeakMap<Bot, BlockTagIndex>()

/** Attach immediately after `createBot`; tags can arrive before spawn. */
export function attachBlockTags(bot: Bot): BlockTagIndex {
  const existing = indexes.get(bot)
  if (existing !== undefined) return existing
  const index = new MineflayerBlockTagIndex(bot)
  indexes.set(bot, index)
  return index
}

/** Existing index for this bot, or an unattached empty one. */
export function blockTagsFor(bot: Bot): BlockTagIndex {
  return indexes.get(bot) ?? attachBlockTags(bot)
}
