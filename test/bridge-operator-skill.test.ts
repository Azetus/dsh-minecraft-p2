import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  loadOperatorSkill,
  OPERATOR_SKILL_DESCRIPTION,
  OPERATOR_SKILL_NAME,
  registerOperatorSkill,
} from '../src/bridge/operator-skill.ts'

/**
 * Category: cross-module contract (packaged skill distribution).
 * Protects: the playbook is loaded from the installed package, registered on
 * the owner agent's scope with a directory resource base, and disposed with
 * the P2 tools. It never writes a workspace AGENTS.md.
 */

describe('packaged operator skill', () => {
  it('loads the shipped SKILL.md from the package directory', () => {
    const source = loadOperatorSkill(join(process.cwd(), 'skills', 'p2-operator'))
    expect(source).toBeDefined()
    expect(source?.content).toContain('name: p2-operator')
    expect(source?.content).toContain('hold')
    expect((source?.content.length ?? 0)).toBeLessThan(8192)
  })

  it('registers on the agent skills service and returns the disposer', () => {
    const source = loadOperatorSkill(join(process.cwd(), 'skills', 'p2-operator'))
    expect(source).toBeDefined()
    const registered: Array<Record<string, unknown>> = []
    let disposed = 0
    const agent = {
      ctx: {
        get(name: string) {
          if (name !== 'skills') return undefined
          return {
            register(skill: Record<string, unknown>) {
              registered.push(skill)
              return () => { disposed += 1 }
            },
          }
        },
      },
    }
    const dispose = registerOperatorSkill(agent, source!)
    expect(dispose).toBeDefined()
    expect(registered[0]).toMatchObject({
      name: OPERATOR_SKILL_NAME,
      description: OPERATOR_SKILL_DESCRIPTION,
      resourceBase: { kind: 'directory', path: join(process.cwd(), 'skills', 'p2-operator') },
      invocation: { modelInvocable: true, userInvocable: true },
    })
    dispose?.()
    expect(disposed).toBe(1)
  })

  it('is a no-op without a skills service', () => {
    const source = loadOperatorSkill(join(process.cwd(), 'skills', 'p2-operator'))
    expect(registerOperatorSkill({}, source!)).toBeUndefined()
    expect(registerOperatorSkill({ ctx: { get: () => undefined } }, source!)).toBeUndefined()
  })
})
