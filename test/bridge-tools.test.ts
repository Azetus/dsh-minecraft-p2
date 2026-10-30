import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../src/contracts/types.ts'
import type { BodyManager } from '../src/bridge/process-manager.ts'
import { registerP2Tools } from '../src/bridge/tools.ts'
import type { AgentLike } from '../src/bridge/tools.ts'

type Tool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { agent?: AgentLike }) => Promise<JsonValue>
}

function register(): { names: string[]; descriptions: Record<string, string> } {
  const tools: Tool[] = []
  const agent: AgentLike = {
    id: 'agent-1',
    session: { id: 'session-1' },
    ctx: {
      tools: {
        register(definition) {
          tools.push(definition as Tool)
          return () => {}
        },
      },
    },
  }
  registerP2Tools(agent, {} as BodyManager)
  return {
    names: tools.map(tool => tool.name),
    descriptions: Object.fromEntries(tools.map(tool => [tool.name, tool.description])),
  }
}

describe('Controller-only bridge tools', () => {
  it('exposes controller/watch/artifact tools and no behavior control tools', () => {
    const { names } = register()
    expect(names).toContain('p2_controller')
    expect(names).toContain('p2_watch')
    expect(names).toContain('p2_check')
    expect(names).toContain('p2_activate')
    for (const removed of ['p2_switch', 'p2_stop', 'p2_confirm', 'p2_guard', 'p2_trace']) {
      expect(names).not.toContain(removed)
    }
  })

  it('does not describe behavior, run or guard state in status/card', () => {
    const { descriptions } = register()
    expect(descriptions.p2_status).not.toMatch(/run|guard|behavior/iu)
    expect(descriptions.p2_card).not.toMatch(/run|guard|behavior/iu)
  })
})
