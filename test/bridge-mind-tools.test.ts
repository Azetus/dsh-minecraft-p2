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
  readonly baseActivities: unknown[] = []
  readonly dutyCalls: unknown[] = []
  readonly policyCalls: unknown[] = []
  /** Override the next accepted order result (queue summary tests). */
  orderResult: unknown = { id: 'ord-1', state: 'active' }
  locksResult: unknown[] = []

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
    return this.orderResult
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

  async mindDuty(params: unknown): Promise<unknown> {
    this.dutyCalls.push(params)
    return {
      previousDuty: null,
      started: {
        id: 'duty-1', kind: 'gather', item: 'dirt', quota: 1, baseline: 0, collected: 0,
        progress: 0, activeMs: 0, pausedMs: 0, jobs: 0, state: 'active', startedAt: 0,
      },
    }
  }

  async mindBaseActivity(params: unknown): Promise<unknown> {
    this.baseActivities.push(params)
    return {
      kind: 'wandering', state: 'active', params: { radius: 8 }, waitingReason: null,
    }
  }

  async mindPolicy(params: unknown): Promise<unknown> {
    this.policyCalls.push(params)
    return {
      source: 'agent',
      mode: 'allowlist',
      fight: { allowedTargets: ['zombie'], retreatHealth: 8, radius: 8, leash: 12 },
      selfCare: {
        eat: { enabled: true, foodBelow: 14 },
        retreat: { enabled: true, healthBelow: 8 },
        unstuck: { enabled: true },
      },
    }
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

  async locks(): Promise<unknown[]> {
    return this.locksResult
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
      'p2_base_activity',
      'p2_policy',
      'p2_orders',
      'p2_cancel',
      'p2_report',
      'p2_events',
    ])
  })

  it('reports locks while the body is inactive', async () => {
    const { manager, definitions, agent } = harness()
    manager.currentState = 'inactive'
    manager.locksResult = [{
      version: 1,
      lockId: 'lock-1',
      host: '127.0.0.1',
      port: 25575,
      ownerSessionId: 'session-9',
      agentId: 'agent-9',
      bridgePid: 999,
      startedAt: 1,
      heartbeatAt: 2,
    }]
    const value = await definitions.get('p2_status')?.execute({}, { agent }) as {
      state?: string
      locks?: Array<{ ownerSessionId?: string; host?: string; port?: number }>
    }
    expect(value.state).toBe('inactive')
    expect(value.locks?.[0]).toMatchObject({
      host: '127.0.0.1',
      port: 25575,
      ownerSessionId: 'session-9',
    })
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

  it('surfaces a hold barrier warning in the accepted result', async () => {
    const { definitions, manager, agent } = harness()
    manager.orderResult = {
      id: 'ord-hold',
      state: 'active',
      queue: {
        active: { id: 'ord-hold', verb: 'hold' },
        queued: 3,
        holdsActiveSlot: true,
        queuedBehind: 3,
        release: 'p2_cancel {id:"ord-hold"} or {all:true}',
      },
    }
    const hold = await definitions.get('p2_order')?.execute({ verb: 'hold' }, { agent }) as {
      queue: { holdsActiveSlot: boolean }
      warning: string
    }
    expect(hold.queue).toMatchObject({ holdsActiveSlot: true, queuedBehind: 3 })
    expect(hold.warning).toContain('not a queue purge')

    manager.orderResult = {
      id: 'ord-go',
      state: 'queued',
      queue: {
        active: { id: 'ord-hold', verb: 'hold' },
        queued: 1,
        blockedBy: { id: 'ord-hold', verb: 'hold' },
        release: 'p2_cancel {id:"ord-hold"} or {all:true}',
      },
    }
    const go = await definitions.get('p2_order')?.execute(
      { verb: 'go', params: { x: 0, y: 64, z: 0 } },
      { agent },
    ) as { warning: string }
    expect(go.warning).toContain('active hold ord-hold')
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

  it('exposes and forwards the find observation mode', async () => {
    const { definitions, manager, agent } = harness()
    const definition = definitions.get('p2_observe')
    expect(definition?.description).toMatch(/find/i)
    expect(definition?.description).toMatch(/go\/craft/i)
    const properties = (definition?.parameters as {
      properties?: Record<string, unknown>
    }).properties ?? {}
    expect(properties).toMatchObject({
      mode: { enum: ['box', 'points', 'find'] },
      near: { required: ['x', 'y', 'z'] },
      radius: { minimum: 1, maximum: 32 },
      limit: { minimum: 1, maximum: 10 },
    })

    const args = {
      mode: 'find',
      near: { x: 0, y: 64, z: 0 },
      radius: 16,
      only: ['crafting_table'],
      limit: 5,
    }
    const value = await definition?.execute(args, { agent })
    expect(value).toEqual({ blocks: [], at: 1 })
    expect(manager.observes).toEqual([args])
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

  it('forwards base activity set/status without acting', async () => {
    const { definitions, manager, agent } = harness()
    const definition = definitions.get('p2_base_activity')
    expect(definition?.description).toMatch(/not persisted|NOT persisted/i)
    expect(definition?.description).toMatch(/restart/i)
    expect((definition?.parameters as { properties?: Record<string, unknown> }).properties).toMatchObject({
      action: { enum: ['set', 'status'] },
    })

    const status = await definition?.execute({ action: 'status' }, { agent })
    expect(status).toMatchObject({ kind: 'wandering', state: 'active' })
    expect(manager.baseActivities).toEqual([{ action: 'status' }])

    const activity = { kind: 'escort', target: 'Alice', distance: 3 }
    await definition?.execute({ action: 'set', activity }, { agent })
    expect(manager.baseActivities.at(-1)).toEqual({ action: 'set', activity })
    expect(manager.orders).toHaveLength(0)
  })

  it('forwards a duty start and exposes replacement result', async () => {
    const { definitions, manager, agent } = harness()
    const definition = definitions.get('p2_duty')
    expect(definition?.description).toMatch(/replace/i)
    const duty = { kind: 'gather', item: 'dirt', quota: 2 }
    const result = await definition?.execute({ action: 'start', duty }, { agent }) as {
      previousDuty: unknown
      started: { state: string }
    }
    expect(result.previousDuty).toBeNull()
    expect(result.started.state).toBe('active')
    expect(manager.dutyCalls).toEqual([{ action: 'start', duty }])
  })

  it('forwards policy set/status/reset without acting', async () => {
    const { definitions, manager, agent } = harness()
    const definition = definitions.get('p2_policy')
    expect(definition?.description).toMatch(/process-local|restart/i)
    expect((definition?.parameters as { properties?: Record<string, unknown> }).properties).toMatchObject({
      action: { enum: ['set', 'reset', 'status'] },
    })
    const reaction = { fight: { allowedTargets: ['zombie'] } }
    await definition?.execute({ action: 'set', reaction }, { agent })
    expect(manager.policyCalls.at(-1)).toEqual({ action: 'set', reaction })
    await definition?.execute({ action: 'status' }, { agent })
    expect(manager.policyCalls.at(-1)).toEqual({ action: 'status' })
    await definition?.execute({ action: 'reset' }, { agent })
    expect(manager.policyCalls.at(-1)).toEqual({ action: 'reset' })
    expect(manager.orders).toHaveLength(0)
  })

  it('rejects a tool call from a non-owner session', async () => {
    const { definitions, agent } = harness('other-session')
    await expect(definitions.get('p2_orders')?.execute({}, { agent })).rejects.toThrow(/different session/)
  })
})
