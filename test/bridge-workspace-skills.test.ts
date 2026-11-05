import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorkspaceSkillProvider, registerWorkspaceSkills } from '../src/bridge/workspace-skills.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempSkills(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-skills-test-'))
  dirs.push(dir)
  return dir
}

function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), body)
}

describe('workspace skills provider', () => {
  it('lists valid skills, skips reserved names, and loads content on demand', async () => {
    const root = tempSkills()
    writeSkill(root, 'alpha', '---\nname: alpha\ndescription: Alpha skill.\nwhenToUse: When testing alpha.\n---\n\n# Alpha\n\nBody.\n')
    writeSkill(root, 'p2-persona', '---\nname: p2-persona\ndescription: reserved\n---\n\nreserved\n')
    writeSkill(root, 'bad', '')
    const provider = new WorkspaceSkillProvider(root)
    const list = await provider.list()
    expect(list.map(entry => entry.name)).toEqual(['alpha'])
    expect(list[0]).toMatchObject({
      description: 'Alpha skill.',
      whenToUse: 'When testing alpha.',
      source: 'project-agents',
      provider: 'p2-workspace',
      resourceBase: { kind: 'directory', path: join(root, 'alpha') },
    })
    const definition = await provider.get(list[0]!)
    expect(definition?.content).toContain('# Alpha')
  })

  it('skips oversized files', async () => {
    const root = tempSkills()
    writeSkill(root, 'huge', `---\nname: huge\ndescription: huge\n---\n\n${'x'.repeat(100)}`)
    const provider = new WorkspaceSkillProvider(root, () => {}, 20)
    expect(await provider.list()).toEqual([])
  })

  it('registers a dynamic provider when the skills service supports it', async () => {
    const root = tempSkills()
    writeSkill(root, 'alpha', '---\nname: alpha\ndescription: Alpha.\n---\n\n# Alpha\n')
    let invalidated = 0
    let disposed = 0
    let listed = 0
    const service = {
      registerProvider(create: (control: { signal: AbortSignal; invalidate: () => void }) => unknown) {
        const provider = create({ signal: new AbortController().signal, invalidate: () => { invalidated += 1 } })
        return () => {
          expect(provider).toBeInstanceOf(WorkspaceSkillProvider)
          disposed += 1
        }
      },
      register() {
        listed += 1
        return () => {}
      },
    }
    const registration = await registerWorkspaceSkills(
      { id: 'a', session: { id: 's' }, ctx: { get: () => service } },
      root,
    )
    expect(registration.hotReload).toBe(true)
    expect(listed).toBe(0)
    registration.provider?.invalidateCatalog()
    expect(invalidated).toBe(1)
    registration.dispose()
    expect(disposed).toBe(1)
  })

  it('falls back to a start-only scan without the provider API', async () => {
    const root = tempSkills()
    writeSkill(root, 'alpha', '---\nname: alpha\ndescription: Alpha.\n---\n\n# Alpha\n')
    const registered: Array<Record<string, unknown>> = []
    const service = {
      register(skill: Record<string, unknown>) {
        registered.push(skill)
        return () => {}
      },
    }
    const registration = await registerWorkspaceSkills(
      { id: 'a', session: { id: 's' }, ctx: { get: () => service } },
      root,
    )
    expect(registration.hotReload).toBe(false)
    expect(registered[0]).toMatchObject({
      name: 'alpha',
      description: 'Alpha.',
      source: 'project-agents',
    })
    registration.dispose()
  })
})
