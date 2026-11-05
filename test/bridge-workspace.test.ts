import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_AUTO_WAKE,
  ensureWorkspace,
  loadAutoWakeConfig,
  memoryFilePath,
  workspacePaths,
} from '../src/bridge/workspace.ts'

const dirs: string[] = []
const templates = join(process.cwd(), 'content', 'templates')

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-workspace-test-'))
  dirs.push(dir)
  return dir
}

describe('p2 workspace templates', () => {
  it('creates the internal workspace and copies missing templates', async () => {
    const root = tempDir()
    const result = await ensureWorkspace(root, templates)
    const paths = workspacePaths(root)
    expect(result.created).toContain(paths.persona)
    expect(result.created).toContain(paths.config)
    expect(readFileSync(paths.persona, 'utf8')).toContain('你是 P2')
    expect(JSON.parse(readFileSync(paths.config, 'utf8'))).toMatchObject({
      minecraft: { username: 'P2_Bot' },
      autoWake: { enabled: true },
    })
    expect(readFileSync(join(paths.skillsDir, 'README.md'), 'utf8')).toContain('.p2/skills')
    expect(readFileSync(join(paths.memoryDir, 'README.md'), 'utf8')).toContain('worldSlug')
  })

  it('never overwrites an existing persona or config', async () => {
    const root = tempDir()
    await ensureWorkspace(root, templates)
    const paths = workspacePaths(root)
    writeFileSync(paths.persona, 'custom persona')
    writeFileSync(paths.config, JSON.stringify({ minecraft: { username: 'Custom' } }))
    const second = await ensureWorkspace(root, templates)
    expect(second.created).toEqual([])
    expect(readFileSync(paths.persona, 'utf8')).toBe('custom persona')
    expect(JSON.parse(readFileSync(paths.config, 'utf8'))).toMatchObject({
      minecraft: { username: 'Custom' },
    })
  })

  it('tolerates a missing template directory', async () => {
    const root = tempDir()
    const result = await ensureWorkspace(root, join(root, 'missing-templates'))
    expect(result.created).toEqual([])
    expect(workspacePaths(root).persona).toContain('.p2')
  })

  it('uses the default autoWake section when the config omits it', async () => {
    const root = tempDir()
    await ensureWorkspace(root, templates)
    const paths = workspacePaths(root)
    writeFileSync(paths.config, JSON.stringify({ minecraft: { username: 'P2_Bot' } }))
    expect(await loadAutoWakeConfig(root)).toEqual(DEFAULT_AUTO_WAKE)
  })

  it('reads autoWake values and allows disabling quiet hours', async () => {
    const root = tempDir()
    await ensureWorkspace(root, templates)
    const paths = workspacePaths(root)
    writeFileSync(paths.config, JSON.stringify({
      autoWake: {
        enabled: false,
        silenceMs: 60_000,
        quietHours: null,
        dailyCap: 0,
        skipActiveWork: true,
        noOpBackoff: false,
      },
    }))
    expect(await loadAutoWakeConfig(root)).toEqual({
      enabled: false,
      silenceMs: 60_000,
      quietHours: null,
      dailyCap: 0,
      skipActiveWork: true,
      noOpBackoff: false,
    })
  })

  it('falls back to defaults for invalid JSON or invalid values', async () => {
    const root = tempDir()
    await ensureWorkspace(root, templates)
    writeFileSync(workspacePaths(root).config, '{not json')
    expect(await loadAutoWakeConfig(root)).toEqual(DEFAULT_AUTO_WAKE)
    writeFileSync(workspacePaths(root).config, JSON.stringify({
      autoWake: { silenceMs: -1, dailyCap: -5, quietHours: { start: 99, end: 2 } },
    }))
    const config = await loadAutoWakeConfig(root)
    expect(config.silenceMs).toBe(DEFAULT_AUTO_WAKE.silenceMs)
    expect(config.dailyCap).toBe(DEFAULT_AUTO_WAKE.dailyCap)
    expect(config.quietHours).toEqual(DEFAULT_AUTO_WAKE.quietHours)
  })
})

describe('memory scope paths', () => {
  it('separates world/character files and sanitizes path components', () => {
    const root = tempDir()
    const first = memoryFilePath(root, { worldId: 'host:25575:minecraft:overworld', characterId: 'uuid-1' })
    const second = memoryFilePath(root, { worldId: 'host:25575:minecraft:overworld', characterId: 'uuid-2' })
    const otherWorld = memoryFilePath(root, { worldId: 'other:25575:minecraft:overworld', characterId: 'uuid-1' })
    expect(first).not.toBe(second)
    expect(first).not.toBe(otherWorld)
    expect(first.endsWith('.jsonl')).toBe(true)
    const rel = relative(workspacePaths(root).memoryDir, first)
    expect(rel).not.toContain(':')
    expect(rel.split(/[\\/]/u)).toHaveLength(2)
    expect(rel).toMatch(/^[A-Za-z0-9._-]+[\\/][A-Za-z0-9._-]+\.jsonl$/u)
  })
})
