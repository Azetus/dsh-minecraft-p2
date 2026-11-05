import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * `.p2/` is local P2 state. Templates are packaged under `content/templates/`
 * and copied only when a file is missing; user edits are never overwritten.
 */
export type WorkspacePaths = {
  root: string
  persona: string
  config: string
  memoryDir: string
  skillsDir: string
}

export type AutoWakeQuietHours = {
  start: number
  end: number
}

export type AutoWakeConfig = {
  enabled: boolean
  /** Minimum owner-session silence before a wake is considered. */
  silenceMs: number
  /** null disables quiet hours. */
  quietHours: AutoWakeQuietHours | null
  /** 0 means unlimited. */
  dailyCap: number
  /** Scheduling preference only; it is never an authorization gate. */
  skipActiveWork: boolean
  noOpBackoff: boolean
}

export const DEFAULT_AUTO_WAKE: AutoWakeConfig = {
  enabled: true,
  silenceMs: 30 * 60_000,
  quietHours: { start: 0, end: 8 },
  dailyCap: 24,
  skipActiveWork: false,
  noOpBackoff: true,
}

function defaultAutoWake(): AutoWakeConfig {
  const quiet = DEFAULT_AUTO_WAKE.quietHours
  return {
    ...DEFAULT_AUTO_WAKE,
    quietHours: quiet === null ? null : { ...quiet },
  }
}

export function workspacePaths(root: string): WorkspacePaths {
  const dotP2 = join(root, '.p2')
  return {
    root: dotP2,
    persona: join(dotP2, 'persona.md'),
    config: join(dotP2, 'config.json'),
    memoryDir: join(dotP2, 'memory'),
    skillsDir: join(dotP2, 'skills'),
  }
}

export type WorkspaceInitResult = {
  paths: WorkspacePaths
  created: string[]
}

/**
 * Create the workspace and copy packaged templates for missing files.
 * A missing template or a copy failure is logged and tolerated: the body can
 * still start with provider defaults and the packaged persona fallback.
 */
export async function ensureWorkspace(
  root: string,
  templatesDir: string,
  log: (line: string) => void = () => {},
): Promise<WorkspaceInitResult> {
  const paths = workspacePaths(root)
  await mkdir(paths.root, { recursive: true })
  await mkdir(paths.memoryDir, { recursive: true })
  await mkdir(paths.skillsDir, { recursive: true })

  const copies: Array<{ source: string; target: string }> = [
    { source: join(templatesDir, 'persona.md'), target: paths.persona },
    { source: join(templatesDir, 'config.json'), target: paths.config },
    { source: join(templatesDir, 'skills', 'README.md'), target: join(paths.skillsDir, 'README.md') },
    { source: join(templatesDir, 'memory', 'README.md'), target: join(paths.memoryDir, 'README.md') },
  ]
  const created: string[] = []
  for (const copy of copies) {
    try {
      await copyFile(copy.source, copy.target, constants.COPYFILE_EXCL)
      created.push(copy.target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        log(`p2 workspace: cannot create ${copy.target} from ${copy.source}: ${formatError(error)}`)
      }
    }
  }
  if (created.length > 0) log(`p2 workspace ready: ${created.map(path => path).join(', ')}`)
  return { paths, created }
}

/**
 * Read the `autoWake` section from `.p2/config.json`. A missing file or an
 * invalid section falls back to defaults; it never fails the body start.
 */
export async function loadAutoWakeConfig(
  root: string,
  log: (line: string) => void = () => {},
): Promise<AutoWakeConfig> {
  const path = workspacePaths(root).config
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') log(`p2 auto-wake: cannot read ${path}: ${formatError(error)}; using defaults`)
    return defaultAutoWake()
  }
  if (!isRecord(parsed) || !isRecord(parsed.autoWake)) {
    return defaultAutoWake()
  }
  const raw = parsed.autoWake
  const config: AutoWakeConfig = {
    enabled: raw.enabled === undefined ? DEFAULT_AUTO_WAKE.enabled : raw.enabled === true,
    silenceMs: readNumber(raw.silenceMs, DEFAULT_AUTO_WAKE.silenceMs, 1_000, 24 * 60 * 60_000),
    quietHours: readQuietHours(raw.quietHours, DEFAULT_AUTO_WAKE.quietHours),
    dailyCap: Math.floor(readNumber(raw.dailyCap, DEFAULT_AUTO_WAKE.dailyCap, 0, 1_000)),
    skipActiveWork: raw.skipActiveWork === undefined ? DEFAULT_AUTO_WAKE.skipActiveWork : raw.skipActiveWork === true,
    noOpBackoff: raw.noOpBackoff === undefined ? DEFAULT_AUTO_WAKE.noOpBackoff : raw.noOpBackoff === true,
  }
  return config
}

export type MemoryScope = {
  worldId: string
  characterId: string
}

/** One file per world/character; path components are sanitized for Windows. */
export function memoryFilePath(root: string, scope: MemoryScope): string {
  const worldSlug = safeSlug(scope.worldId, 'world')
  const characterSlug = safeSlug(scope.characterId, 'character')
  return join(workspacePaths(root).memoryDir, worldSlug, `${characterSlug}.jsonl`)
}

function safeSlug(value: string, fallback: string): string {
  const original = value.trim()
  let slug = original.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^_+|_+$/gu, '')
  if (slug.length === 0 || slug === '.' || slug === '..') slug = fallback
  const truncated = slug.length > 64
  if (truncated) slug = slug.slice(0, 64)
  if (truncated || slug !== original) slug = `${slug}-${hash8(original)}`
  return slug
}

function hash8(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const number = Math.floor(value)
  if (number < min || number > max) return fallback
  return number
}

function readQuietHours(
  value: unknown,
  fallback: AutoWakeQuietHours | null,
): AutoWakeQuietHours | null {
  if (value === null || value === false) return null
  if (!isRecord(value)) return fallback === null ? null : { ...fallback }
  const start = readNumber(value.start, NaN, 0, 23)
  const end = readNumber(value.end, NaN, 0, 23)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return fallback === null ? null : { ...fallback }
  return { start, end }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
