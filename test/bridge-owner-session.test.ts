import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BodyManager } from '../src/bridge/process-manager.ts'
import { RepeatTracker } from '../src/bridge/repeat.ts'
import { loadPackagedSkills, registerPackagedSkills, P2_SKILL_NAMES } from '../src/bridge/owner-skills.ts'
import { registerMemoryTool } from '../src/bridge/memory-tools.ts'
import { MemoryStore } from '../src/bridge/memory-store.ts'
import { registerP2Tools } from '../src/bridge/tools.ts'
import type { AgentLike, ToolDefinition, ToolsService } from '../src/bridge/tools.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-owner-session-test-'))
  dirs.push(dir)
  return dir
}

function recordingTools(): { tools: Map<string, ToolDefinition>; service: ToolsService } {
  const tools = new Map<string, ToolDefinition>()
  return {
    tools,
    service: {
      register(definition: ToolDefinition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
}

const agent: AgentLike = {
  id: 'agent-1',
  session: { id: 'session-1', header: { cwd: process.cwd() } },
}

describe('owner session registrations', () => {
  it('loads and registers the six packaged skills', () => {
    const sources = loadPackagedSkills(process.cwd())
    expect(sources.map(source => source.name).sort()).toEqual([...P2_SKILL_NAMES].sort())
    expect(sources.find(source => source.name === 'p2-subagent')?.content).toContain('没有 P2')
    expect(sources.find(source => source.name === 'p2-survival')?.content).toContain('不隔墙挖')
    const registered: Array<Record<string, unknown>> = []
    const disposers = registerPackagedSkills(
      {
        ...agent,
        ctx: {
          get: () => ({
            register(skill: Record<string, unknown>) {
              registered.push(skill)
              return () => {}
            },
          }),
        },
      },
      sources,
    )
    expect(disposers).toHaveLength(6)
    expect(registered.map(skill => skill.name).sort()).toEqual([...P2_SKILL_NAMES].sort())
    expect(registered[0]).toMatchObject({ source: 'runtime', invocation: { modelInvocable: true } })
  })

  it('registers P2 tools on the provided (owner-scoped) service', () => {
    const { tools, service } = recordingTools()
    const manager = new BodyManager({ bodyEntry: 'unused-body.mjs', log: () => {} })
    registerP2Tools(agent, manager, service, new RepeatTracker())
    expect([...tools.keys()]).toEqual(expect.arrayContaining([
      'p2_status', 'p2_order', 'p2_duty', 'p2_observe', 'p2_say', 'p2_cancel',
    ]))
    expect(tools.has('p2_memory')).toBe(false)
  })

  it('registers p2_memory separately and keeps it owner-only', async () => {
    const root = tempDir()
    const store = new MemoryStore({
      path: join(root, 'memory.jsonl'),
      scope: { worldId: 'w', characterId: 'c' },
      now: () => 1_000,
    })
    const { tools, service } = recordingTools()
    registerMemoryTool(agent, service, store)
    const memory = tools.get('p2_memory')
    expect(memory).toBeDefined()
    const remembered = await memory!.execute(
      { action: 'remember', kind: 'fact', text: 'base here', tags: ['base'] },
      { agent },
    ) as { entry?: { text?: string } }
    expect(remembered.entry?.text).toBe('base here')
    const recalled = await memory!.execute({ action: 'recall', query: 'base' }, { agent }) as {
      count?: number
    }
    expect(recalled.count).toBe(1)
    await expect(memory!.execute(
      { action: 'recall' },
      { agent: { ...agent, session: { id: 'other' } } },
    )).rejects.toThrow(/owner session/u)
  })
})
