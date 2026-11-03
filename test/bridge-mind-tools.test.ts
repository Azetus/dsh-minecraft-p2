import { describe, expect, it } from 'vitest'

import { registerP2Tools } from '../src/bridge/tools.ts'
import type { AgentLike, ToolDefinition, ToolsService } from '../src/bridge/tools.ts'
import type { BodyManager } from '../src/bridge/process-manager.ts'

/**
 * Category: cross-module contract (M1 operator surface).
 * Protects: operator tools only read mind state or submit orders; they never
 * act on the world, and a non-owner session cannot drive the body.
 */

class FakeManager {
  currentState = 'active'
  currentOwner = { sessionId: 's1', agentId: 'a1', cwd: 'C:/p2' }
  readonly orders: unknown[] = []
  readonly cancels: string[] = []
  readonly observes: unknown[] = []
  readonly entityQueries: unknown[] = []
  readonly previews: unknown[] = []
  readonly says: string[] = []

  async status(): Promise<unknown> {
    return {
      state: 'active',
      status: {
        bodyEpoch: 'epoch-1',
        health: 'ready',
        connection: 'connected',
        providerState: { connected: true, paused: false },
        mind: {
          tracker: 'idle',
          job: null,
          fault: null,
          home: { x: 0, y: 64, z: 0 },
          activeOrder: null,
          queuedOrders: 0,
          eventsSeq: 0,
        },
      },
    }
  }

  async mindOrder(order: unknown): Promise<unknown> {
    this.orders.push(order)
    return { id: 'ord-1', state: 'active' }
  }

  async worldObserve(params: unknown): Promise<unknown> {
    this.observes.push(params)
    return { blocks: [], at: 1 }
  }

  async worldEntities(params: unknown): Promise<unknown> {
    this.entityQueries.push(params)
    return { entities: [], total: 0 }
  }

  async blueprintPreview(blueprint: unknown): Promise<unknown> {
    this.previews.push(blueprint)
    return { ok: true, blocks: 0 }
  }

  async chatSay(text: string): Promise<unknown> {
    this.says.push(text)
    return { sent: true }
  }

  async mindOrders(): Promise<unknown> {
    return { active: null, queued: [], queueBlockedBy: null }
  }

  async mindCancel(id: string, all = false): Promise<unknown> {
    this.cancels.push(all ? `all:${id}` : id)
    return all ? { id: '*', state: 'cancelled', cancelled: 2 } : { id, state: 'cancelled' }
  }

  async mindReport(): Promise<unknown> {
    return { report: null }
  }

  async mindEvents(): Promise<unknown> {
    return { events: [], seq: 0 }
  }
}

function harness(sessionId = 's1'): {
  manager: FakeManager
  definitions: Map<string, ToolDefinition>
  tools: ToolsService
  agent: AgentLike
} {
  const manager = new FakeManager()
  const definitions = new Map<string, ToolDefinition>()
  const tools: ToolsService = {
    register: definition => {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
  }
  const agent: AgentLike = { id: 'a1', session: { id: sessionId } }
  registerP2Tools(agent, manager as unknown as BodyManager, tools)
  return { manager, definitions, tools, agent }
}

describe('mind operator tools', () => {
  it('registers the M1 operator surface', () => {
    const { definitions } = harness()
    expect([...definitions.keys()]).toEqual([
      'p2_status',
      'p2_observe',
      'p2_entities',
      'p2_preview_blueprint',
      'p2_say',
      'p2_order',
      'p2_duty',
      'p2_orders',
      'p2_cancel',
      'p2_report',
      'p2_events',
    ])
  })

  it('reports mind state through p2_status', async () => {
    const { definitions, agent } = harness()
    const value = await definitions.get('p2_status')?.execute({}, { agent }) as {
      state: string
      paused: boolean | null
      mind: { tracker: string }
    }
    expect(value.state).toBe('active')
    expect(value.paused).toBe(false)
    expect(value.mind.tracker).toBe('idle')
  })

  it('submits an order without adding any action surface', async () => {
    const { definitions, manager, agent } = harness()
    const value = await definitions.get('p2_order')?.execute(
      { verb: 'go', params: { x: 0, y: 64, z: 0 } },
      { agent },
    )
    expect(value).toEqual({ accepted: true, id: 'ord-1', state: 'active' })
    expect(manager.orders).toEqual([{ verb: 'go', params: { x: 0, y: 64, z: 0 } }])
  })

  it('passes an observation request through, without acting', async () => {
    const { definitions, manager, agent } = harness()
    const box = {
      min: { x: 0, y: 64, z: 0 },
      max: { x: 2, y: 64, z: 2 },
    }
    const value = await definitions.get('p2_observe')?.execute(box, { agent })
    expect(value).toEqual({ blocks: [], at: 1 })
    expect(manager.observes).toEqual([box])
    expect(manager.orders).toHaveLength(0)
  })

  it('passes an entity query through, without acting', async () => {
    const { definitions, manager, agent } = harness()
    const args = { radius: 64, names: ['item'] }
    const value = await definitions.get('p2_entities')?.execute(args, { agent })
    expect(value).toEqual({ entities: [], total: 0 })
    expect(manager.entityQueries).toEqual([args])
    expect(manager.orders).toHaveLength(0)
  })

  it('previews a blueprint without acting', async () => {
    const { definitions, manager, agent } = harness()
    const blueprint = { blocks: [{ x: 0, y: 64, z: 0, name: 'dirt' }] }
    const value = await definitions.get('p2_preview_blueprint')?.execute({ blueprint }, { agent })
    expect(value).toEqual({ ok: true, blocks: 0 })
    expect(manager.previews).toEqual([blueprint])
    expect(manager.orders).toHaveLength(0)
  })

  it('sends a chat reply through p2_say', async () => {
    const { definitions, manager, agent } = harness()
    const value = await definitions.get('p2_say')?.execute({ text: '收到' }, { agent })
    expect(value).toEqual({ sent: true })
    expect(manager.says).toEqual(['收到'])
  })

  it('cancels by id and lists events', async () => {
    const { definitions, manager, agent } = harness()
    await definitions.get('p2_cancel')?.execute({ id: 'ord-1' }, { agent })
    expect(manager.cancels).toEqual(['ord-1'])
    const events = await definitions.get('p2_events')?.execute({ sinceSeq: 4 }, { agent })
    expect(events).toEqual({ events: [], seq: 0 })
  })

  it('cancels every order with all:true and exposes the queue barrier', async () => {
    const { definitions, manager, agent } = harness()
    const orders = await definitions.get('p2_orders')?.execute({}, { agent })
    expect(orders).toMatchObject({ queueBlockedBy: null })
    const result = await definitions.get('p2_cancel')?.execute({ all: true }, { agent })
    expect(result).toEqual({ id: '*', state: 'cancelled', cancelled: 2 })
    expect(manager.cancels).toEqual(['all:*'])
  })

  it('rejects a tool call from a non-owner session', async () => {
    const { definitions, agent } = harness('other-session')
    await expect(definitions.get('p2_orders')?.execute({}, { agent })).rejects.toThrow(/different session/)
  })
})
