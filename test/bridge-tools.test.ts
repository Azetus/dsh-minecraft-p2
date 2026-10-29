import { describe, expect, it } from 'vitest'

import type { BodyManager } from '../src/bridge/process-manager.ts'
import type { AgentLike } from '../src/bridge/tools.ts'
import { registerP2Tools } from '../src/bridge/tools.ts'

function fakeAgent(): { agent: AgentLike; names: string[] } {
  const names: string[] = []
  const agent: AgentLike = {
    id: 'agent-1',
    session: { id: 'session-1', header: { cwd: process.cwd() } },
    ctx: {
      tools: {
        register: definition => {
          names.push(definition.name)
          return () => {}
        },
      },
    },
  }
  return { agent, names }
}

describe('bridge tools', () => {
  it('registers the experiment rescue tool', () => {
    const { agent, names } = fakeAgent()
    const manager = {} as BodyManager
    registerP2Tools(agent, manager)
    expect(names).toContain('p2_rescue')
  })

  it('keeps the core tool surface', () => {
    const { agent, names } = fakeAgent()
    registerP2Tools(agent, {} as BodyManager)
    expect(names).toEqual(expect.arrayContaining([
      'p2_status',
      'p2_observe',
      'p2_check',
      'p2_activate',
      'p2_switch',
      'p2_stop',
      'p2_guard',
      'p2_events',
      'p2_rescue',
    ]))
  })
})
