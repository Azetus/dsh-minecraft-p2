import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { P2_SKILL_NAMES } from './owner-skills.ts'
import type { AgentLike } from './tools.ts'

/**
 * Additive workspace skills under `.p2/skills`. Files are plain prompt text:
 * the provider never executes anything and the plugin never writes them.
 */
export type WorkspaceSkillCandidate = {
  name: string
  description: string
  whenToUse?: string
  path: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  source: string
  provider: string
  resourceBase: { kind: 'directory'; path: string }
  rank: number
  locator: { path: string }
}

export type WorkspaceSkillDefinition = WorkspaceSkillCandidate & {
  content: string
}

export type SkillProviderControl = {
  signal: AbortSignal
  invalidate: () => void
}

type SkillServiceLike = {
  register?: (skill: Record<string, unknown>) => (() => void) | undefined
  registerProvider?: (
    create: (control: SkillProviderControl) => unknown,
  ) => (() => void) | undefined
}

export type WorkspaceSkillsRegistration = {
  dispose: () => void
  hotReload: boolean
  provider?: WorkspaceSkillProvider
}

export const WORKSPACE_SKILL_MAX_BYTES = 64 * 1024
export const WORKSPACE_SKILL_MAX_COUNT = 64

export class WorkspaceSkillProvider {
  readonly name = 'p2-workspace'
  private invalidate: (() => void) | undefined

  constructor(
    private readonly root: string,
    private readonly log: (line: string) => void = () => {},
    private readonly maxBytes = WORKSPACE_SKILL_MAX_BYTES,
    private readonly maxCount = WORKSPACE_SKILL_MAX_COUNT,
  ) {}

  setInvalidate(invalidate: () => void): void {
    this.invalidate = invalidate
  }

  async list(): Promise<readonly WorkspaceSkillCandidate[]> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.log(`p2 workspace skills: cannot read ${this.root}: ${formatError(error)}`)
      return []
    }
    const result: WorkspaceSkillCandidate[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (result.length >= this.maxCount) {
        this.log(`p2 workspace skills: more than ${this.maxCount} entries; extra skills ignored`)
        break
      }
      const name = entry.name
      if (!isValidName(name) || P2_SKILL_NAMES.has(name)) {
        if (P2_SKILL_NAMES.has(name)) this.log(`p2 workspace skills: reserved name ignored: ${name}`)
        continue
      }
      const dir = join(this.root, name)
      const path = join(dir, 'SKILL.md')
      const parsed = await this.read(path, name)
      if (parsed === undefined) continue
      const invocation = { modelInvocable: true, userInvocable: true }
      result.push({
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        path,
        invocation,
        source: 'project-agents',
        provider: this.name,
        resourceBase: { kind: 'directory', path: dir },
        rank: 0,
        locator: { path },
      })
    }
    return result
  }

  async get(candidate: WorkspaceSkillCandidate): Promise<WorkspaceSkillDefinition | undefined> {
    const path = candidate.locator?.path ?? candidate.path
    if (typeof path !== 'string' || path.length === 0) return undefined
    const parsed = await this.read(path, candidate.name)
    if (parsed === undefined) return undefined
    return {
      ...candidate,
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      content: parsed.content,
    }
  }

  /** Invalidate the skills catalog; used by the directory watcher. */
  invalidateCatalog(): void {
    this.invalidate?.()
  }

  private async read(
    path: string,
    fallbackName: string,
  ): Promise<{ name: string; description: string; whenToUse?: string; content: string } | undefined> {
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch {
      return undefined
    }
    if (Buffer.byteLength(content) > this.maxBytes) {
      this.log(`p2 workspace skills: ${path} exceeds ${this.maxBytes} bytes; ignored`)
      return undefined
    }
    const parsed = parseSkill(content, fallbackName)
    if (parsed === undefined) {
      this.log(`p2 workspace skills: ${path} has no usable name/description; ignored`)
      return undefined
    }
    if (!isValidName(parsed.name) || P2_SKILL_NAMES.has(parsed.name)) {
      this.log(`p2 workspace skills: ${path} uses an invalid or reserved name: ${parsed.name}`)
      return undefined
    }
    return { ...parsed, content }
  }
}

/**
 * Prefer the dynamic provider so a skill created at runtime appears on the next
 * catalog refresh. If the installed skills service has no provider API, fall
 * back to a one-shot scan at body start and say so in the log.
 */
export async function registerWorkspaceSkills(
  agent: AgentLike,
  root: string,
  log: (line: string) => void = () => {},
): Promise<WorkspaceSkillsRegistration> {
  const skills = agent.ctx?.get('skills') as SkillServiceLike | undefined
  if (skills === undefined) {
    return { dispose: () => {}, hotReload: false }
  }
  const provider = new WorkspaceSkillProvider(root, log)
  if (typeof skills.registerProvider === 'function') {
    let control: SkillProviderControl | undefined
    try {
      const disposeProvider = skills.registerProvider(created => {
        control = created
        provider.setInvalidate(created.invalidate)
        return provider
      })
      const disposeWatch = watchWorkspaceSkills(root, () => control?.invalidate(), log)
      return {
        dispose: () => {
          disposeWatch()
          disposeProvider?.()
        },
        hotReload: true,
        provider,
      }
    } catch (error) {
      log(`p2 workspace skills: provider registration failed: ${formatError(error)}; using a start-only scan`)
    }
  }
  if (typeof skills.register !== 'function') {
    return { dispose: () => {}, hotReload: false, provider }
  }
  const disposers: Array<() => void> = []
  const candidates = await provider.list()
  for (const candidate of candidates) {
    const definition = await provider.get(candidate)
    if (definition === undefined) continue
    try {
      const dispose = skills.register({
        name: definition.name,
        description: definition.description,
        ...(definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse }),
        content: definition.content,
        source: 'project-agents',
        resourceBase: definition.resourceBase,
        invocation: definition.invocation,
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log(`p2 workspace skills: cannot register ${definition.name}: ${formatError(error)}`)
    }
  }
  return {
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
    hotReload: false,
    provider,
  }
}

export function watchWorkspaceSkills(
  root: string,
  invalidate: () => void,
  log: (line: string) => void = () => {},
): () => void {
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    watcher = watch(root, { recursive: true }, () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        try {
          invalidate()
        } catch (error) {
          log(`p2 workspace skills: invalidate failed: ${formatError(error)}`)
        }
      }, 200)
      timer.unref?.()
    })
    watcher.on('error', error => log(`p2 workspace skills: watcher error: ${formatError(error)}`))
  } catch (error) {
    log(`p2 workspace skills: cannot watch ${root}: ${formatError(error)}; restart applies changes`)
    return () => {}
  }
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    watcher?.close()
  }
}

function parseSkill(
  content: string,
  fallbackName: string,
): { name: string; description: string; whenToUse?: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(content)
  const frontmatter = match?.[1] ?? ''
  const body = match === null ? content : content.slice(match[0].length)
  const values: Record<string, string> = {}
  for (const line of frontmatter.split(/\r?\n/u)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/gu, '')
    if (key.length > 0 && value.length > 0) values[key] = value
  }
  const name = values.name ?? fallbackName
  const description = values.description ?? body
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line.length > 0 && !line.startsWith('#'))
  if (name.length === 0 || description === undefined || description.length === 0) return undefined
  return {
    name,
    description: description.slice(0, 300),
    ...(values.whenToUse === undefined ? {} : { whenToUse: values.whenToUse.slice(0, 300) }),
  }
}

function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(name)
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
