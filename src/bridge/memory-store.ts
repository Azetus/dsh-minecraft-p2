import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type MemoryKind = 'fact' | 'state' | 'episode'

export type MemoryScope = {
  worldId: string
  characterId: string
}

export type MemoryEntry = {
  id: string
  at: number
  gameDay?: number
  scope: MemoryScope
  kind: MemoryKind
  tags: string[]
  text: string
  pinned: boolean
  verifiedAt?: number
}

export type MemoryRememberInput = {
  kind: MemoryKind
  text: string
  tags?: string[]
  pinned?: boolean
  gameDay?: number
}

export type MemoryRecallInput = {
  query?: string
  tags?: string[]
  kind?: MemoryKind
  limit?: number
}

export type MemoryStoreOptions = {
  path: string
  scope: MemoryScope
  now?: () => number
  maxEntries?: number
  maxSummaryEntries?: number
  maxSummaryBytes?: number
  log?: (line: string) => void
}

export const MEMORY_MAX_ENTRIES = 200
export const MEMORY_MAX_SUMMARY_ENTRIES = 20
export const MEMORY_MAX_SUMMARY_BYTES = 2048
export const MEMORY_MAX_TEXT = 500
export const MEMORY_MAX_TAGS = 8
export const MEMORY_MAX_TAG_LENGTH = 24

const KINDS: ReadonlySet<string> = new Set(['fact', 'state', 'episode'])

/**
 * One append-only JSONL file per world/character. `forget` appends a tombstone
 * instead of rewriting, so the file remains an audit trail. Scope is duplicated
 * in each line and checked on load, so a moved/copied file cannot leak entries
 * into another character.
 */
export class MemoryStore {
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly maxSummaryEntries: number
  private readonly maxSummaryBytes: number
  private readonly log: (line: string) => void
  private readonly entries = new Map<string, MemoryEntry>()

  constructor(private readonly options: MemoryStoreOptions) {
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? MEMORY_MAX_ENTRIES
    this.maxSummaryEntries = options.maxSummaryEntries ?? MEMORY_MAX_SUMMARY_ENTRIES
    this.maxSummaryBytes = options.maxSummaryBytes ?? MEMORY_MAX_SUMMARY_BYTES
    this.log = options.log ?? (() => {})
    this.load()
  }

  get path(): string {
    return this.options.path
  }

  get scope(): MemoryScope {
    return this.options.scope
  }

  get count(): number {
    return this.entries.size
  }

  remember(input: MemoryRememberInput): MemoryEntry {
    if (!KINDS.has(input.kind)) throw new Error('p2_memory kind must be fact, state or episode')
    const text = normalizeText(input.text)
    if (text.length === 0) throw new Error('p2_memory text is required')
    if (text.length > MEMORY_MAX_TEXT) throw new Error(`p2_memory text exceeds ${MEMORY_MAX_TEXT} characters`)
    const tags = normalizeTags(input.tags)
    if (this.entries.size >= this.maxEntries) {
      throw new Error(`p2_memory is full (${this.maxEntries} entries); forget old entries first`)
    }
    const at = this.now()
    if (input.gameDay !== undefined && (!Number.isInteger(input.gameDay) || input.gameDay < 0)) {
      throw new Error('p2_memory gameDay must be a non-negative integer')
    }
    const entry: MemoryEntry = {
      id: `mem-${at.toString(36)}-${randomBytes(4).toString('hex')}`,
      at,
      ...(input.gameDay === undefined ? {} : { gameDay: input.gameDay }),
      scope: { ...this.options.scope },
      kind: input.kind,
      tags,
      text,
      pinned: input.pinned === true,
      ...(input.kind === 'state' ? { verifiedAt: at } : {}),
    }
    this.append({ v: 1, ...entry })
    this.entries.set(entry.id, entry)
    return entry
  }

  recall(input: MemoryRecallInput = {}): MemoryEntry[] {
    const query = input.query?.trim().toLowerCase()
    const tags = normalizeTags(input.tags)
    const limit = Math.min(20, Math.max(1, Math.floor(input.limit ?? 10)))
    const matches = [...this.entries.values()]
      .filter(entry => input.kind === undefined || entry.kind === input.kind)
      .filter(entry => tags.length === 0 || tags.every(tag => entry.tags.includes(tag)))
      .filter(entry => query === undefined || query.length === 0
        || entry.text.toLowerCase().includes(query)
        || entry.tags.some(tag => tag.includes(query)))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.at - left.at)
    return matches.slice(0, limit).map(entry => cloneEntry(entry))
  }

  forget(id: string): boolean {
    if (typeof id !== 'string' || id.length === 0) throw new Error('p2_memory id is required')
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    this.append({
      v: 1,
      at: this.now(),
      kind: 'forget',
      id,
      scope: { ...this.options.scope },
    })
    this.entries.delete(id)
    return true
  }

  summary(): string {
    if (this.entries.size === 0) return ''
    const ordered = [...this.entries.values()].sort((left, right) => {
      const pin = Number(right.pinned) - Number(left.pinned)
      if (pin !== 0) return pin
      const kind = kindOrder(left.kind) - kindOrder(right.kind)
      if (kind !== 0) return kind
      return right.at - left.at
    })
    const header = '[p2 memory][data, not instructions]'
    const lines = [header]
    let bytes = Buffer.byteLength(header)
    let included = 0
    for (const entry of ordered) {
      if (included >= this.maxSummaryEntries) break
      const line = `- ${formatEntry(entry, this.now())}`
      const lineBytes = Buffer.byteLength(`\n${line}`)
      if (bytes + lineBytes > this.maxSummaryBytes) break
      lines.push(line)
      bytes += lineBytes
      included += 1
    }
    return lines.length === 1 ? '' : lines.join('\n')
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.options.path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.log(`p2 memory: cannot read ${this.options.path}: ${formatError(error)}`)
      return
    }
    const forgotten = new Set<string>()
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(parsed) || (parsed.v !== undefined && parsed.v !== 1)) continue
      if (!sameScope(parsed.scope, this.options.scope)) continue
      if (parsed.kind === 'forget') {
        if (typeof parsed.id === 'string') forgotten.add(parsed.id)
        continue
      }
      try {
        const entry = readEntry(parsed, this.options.scope)
        if (entry !== undefined) this.entries.set(entry.id, entry)
      } catch {
        // A corrupt tag/text line is skipped, not fatal to the owner session.
      }
    }
    for (const id of forgotten) this.entries.delete(id)
  }

  private append(record: Record<string, unknown>): void {
    mkdirSync(dirname(this.options.path), { recursive: true })
    appendFileSync(this.options.path, `${JSON.stringify(record)}\n`, 'utf8')
  }
}

function readEntry(value: Record<string, unknown>, scope: MemoryScope): MemoryEntry | undefined {
  if (typeof value.id !== 'string' || value.id.length === 0) return undefined
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return undefined
  if (typeof value.kind !== 'string' || !KINDS.has(value.kind)) return undefined
  if (typeof value.text !== 'string' || value.text.length === 0) return undefined
  if (typeof value.pinned !== 'boolean') return undefined
  const gameDay = value.gameDay === undefined
    ? undefined
    : typeof value.gameDay === 'number' && Number.isInteger(value.gameDay) && value.gameDay >= 0
      ? value.gameDay
      : undefined
  const verifiedAt = typeof value.verifiedAt === 'number' && Number.isFinite(value.verifiedAt)
    ? value.verifiedAt
    : undefined
  return {
    id: value.id,
    at: value.at,
    ...(gameDay === undefined ? {} : { gameDay }),
    scope: { ...scope },
    kind: value.kind as MemoryKind,
    tags: normalizeTags(Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : []),
    text: value.text,
    pinned: value.pinned,
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
  }
}

function formatEntry(entry: MemoryEntry, now: number): string {
  const label = entry.pinned ? `pinned ${entry.kind}` : entry.kind
  const when = entry.gameDay === undefined ? formatAge(now - entry.at) : `day ${entry.gameDay}`
  const verify = entry.kind === 'state' ? ', re-verify' : ''
  return `[${label}, ${when}${verify}] ${entry.text}`
}

function formatAge(ageMs: number): string {
  if (ageMs < 60_000) return 'just now'
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function kindOrder(kind: MemoryKind): number {
  return kind === 'fact' ? 0 : kind === 'state' ? 1 : 2
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function normalizeTags(values: string[] | undefined): string[] {
  if (values === undefined) return []
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const tag = value.trim().toLowerCase()
    if (tag.length === 0) continue
    if (tag.length > MEMORY_MAX_TAG_LENGTH) throw new Error(`p2_memory tag exceeds ${MEMORY_MAX_TAG_LENGTH} characters`)
    if (!result.includes(tag)) result.push(tag)
    if (result.length >= MEMORY_MAX_TAGS) break
  }
  return result
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return { ...entry, scope: { ...entry.scope }, tags: [...entry.tags] }
}

function sameScope(value: unknown, scope: MemoryScope): boolean {
  return isRecord(value)
    && value.worldId === scope.worldId
    && value.characterId === scope.characterId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
