import { describe, expect, it } from 'vitest'

import { summarizeEntities, summarizeInventory } from '../src/bridge/summaries.ts'
import { BehaviorHost } from '../src/core/host.ts'
import { BodyRuntime } from '../src/body/runtime.ts'
import { p2Error } from '../src/contracts/protocol.ts'
import type { BodyInfo, CardResult, SnapshotResult } from '../src/contracts/protocol.ts'
import type { ActPort, QueryOutcome, QueryPort } from '../src/core/node-runtime.ts'

const body: BodyInfo = {
  manifest: { schemaVersion: 1, bodyVersion: 'test', protocolVersion: 1, entry: 'body.mjs', files: {} },
  manifestDigest: 'digest',
  bindingId: null,
  capabilities: [],
  provider: null,
}

const owner = { sessionId: 's', agentId: 'a', cwd: process.cwd() }

const act: ActPort = { start: () => ({ poll: () => ({ status: 'running' }), stop: () => {} }) }

const SNAPSHOT_OPS = [
  { key: 'position', op: 'position' },
  { key: 'health', op: 'health' },
  { key: 'inventory', op: 'inventory' },
  { key: 'blocks', op: 'blocks', args: { radius: 8 } },
  { key: 'entities', op: 'entities', args: { count: 8 } },
]

function meta(scope: string): { source: 'query'; scope: string; sampledAt: number } {
  return { source: 'query', scope, sampledAt: 1_000 }
}

async function runSnapshot(query: QueryPort, timeoutMs?: number): Promise<{ result: SnapshotResult; calls: string[] }> {
  const calls: string[] = []
  const counting: QueryPort = (ref, args) => {
    calls.push(ref.op)
    return query(ref, args)
  }
  const host = new BehaviorHost({ bindingId: 'snapshot', query: counting, act })
  const runtime = new BodyRuntime({ body, owner, behavior: host })
  const response = await runtime.handleRequestAsync({
    protocol: 1,
    requestId: 'snapshot-1',
    method: 'snapshot',
    bodyEpoch: runtime.bodyEpoch,
    params: {
      ops: SNAPSHOT_OPS,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  })
  expect(response.error).toBeUndefined()
  return { result: response.result as unknown as SnapshotResult, calls }
}

describe('observation snapshots', () => {
  it('returns every part in one request and isolates a failed part', async () => {
    const query: QueryPort = ref => {
      switch (ref.op) {
        case 'position': return { status: 'ok', value: { x: 1, y: 64, z: 1 }, meta: meta('position') }
        case 'health': return { status: 'ok', value: { health: 20 }, meta: meta('health') }
        case 'inventory': return { status: 'ok', value: [{ name: 'bread', count: 2 }], meta: meta('inventory') }
        case 'blocks':
          return {
            status: 'failed',
            error: p2Error('BLOCKS_FAILED', 'environment', 'chunk unloaded', { module: 'test.observe' }),
          }
        case 'entities':
          return {
            status: 'ok',
            value: [{ id: 1, name: 'zombie', kind: 'Hostile mobs', distance: 3 }],
            meta: meta('entities'),
          }
        default:
          return { status: 'failed', error: p2Error('UNKNOWN', 'validation', 'unknown', { module: 'test.observe' }) }
      }
    }
    const { result, calls } = await runSnapshot(query)
    expect(calls).toEqual(['position', 'health', 'inventory', 'blocks', 'entities'])
    expect(result.partial).toBe(true)
    expect(result.parts.map(part => part.status)).toEqual(['ok', 'ok', 'ok', 'failed', 'ok'])
    expect(result.parts.find(part => part.key === 'blocks')?.error?.code).toBe('BLOCKS_FAILED')
    expect(result.parts.find(part => part.key === 'entities')?.meta).toMatchObject({ scope: 'entities' })
  })

  it('reports a pending part without failing the others', async () => {
    const query: QueryPort = ref => {
      if (ref.op === 'blocks') {
        const poll = (): QueryOutcome => ({ status: 'pending', poll })
        return { status: 'pending', poll }
      }
      return { status: 'ok', value: { op: ref.op }, meta: meta(ref.op) }
    }
    const { result } = await runSnapshot(query, 30)
    expect(result.partial).toBe(true)
    expect(result.parts.find(part => part.key === 'blocks')?.status).toBe('pending')
    expect(result.parts.filter(part => part.status === 'ok')).toHaveLength(4)
  })

  it('rejects duplicate keys and more than eight parts', async () => {
    const host = new BehaviorHost({ bindingId: 'snapshot-2', query: () => ({ status: 'ok', value: null }), act })
    const runtime = new BodyRuntime({ body, owner, behavior: host })
    const duplicate = await runtime.handleRequestAsync({
      protocol: 1,
      requestId: 's2',
      method: 'snapshot',
      bodyEpoch: runtime.bodyEpoch,
      params: { ops: [{ key: 'a', op: 'health' }, { key: 'a', op: 'time' }] },
    })
    expect(duplicate.error?.code).toBe('INVALID_MESSAGE')
    const tooMany = await runtime.handleRequestAsync({
      protocol: 1,
      requestId: 's3',
      method: 'snapshot',
      bodyEpoch: runtime.bodyEpoch,
      params: { ops: Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, op: 'health' })) },
    })
    expect(tooMany.error?.code).toBe('INVALID_MESSAGE')
  })
})

// 类别：数据完整性
// 保护对象：ARCHITECTURE §2.2（摘要纯函数：相同输入相同输出、不读取游戏、不保存历史）
//           O1 验收（inventory 计数与实体摘要由 bridge 纯函数生成）。
// 失败模式：摘要引入 provider 语义、对畸形行抛错或把未知折成 0 之外的假值。

describe('status cards', () => {
  it('projects run, health, position, hostiles and guard/watch counts', async () => {
    const query: QueryPort = ref => {
      if (ref.op === 'health') return { status: 'ok', value: { health: 18, food: 20 }, meta: meta('health') }
      if (ref.op === 'position') return { status: 'ok', value: { x: 1, y: 64, z: 2 }, meta: meta('position') }
      return {
        status: 'ok',
        value: [{ id: 1, kind: 'Hostile mobs' }, { id: 2, kind: 'Hostile mobs' }],
        meta: meta('entities'),
      }
    }
    const host = new BehaviorHost({ bindingId: 'card-1', query, act })
    const runtime = new BodyRuntime({ body, owner, behavior: host })
    const response = await runtime.handleRequestAsync({
      protocol: 1,
      requestId: 'card-1',
      method: 'card',
      bodyEpoch: runtime.bodyEpoch,
      params: { radius: 8 },
    })
    expect(response.error).toBeUndefined()
    const card = response.result as unknown as CardResult
    expect(card).toMatchObject({
      health: 'ready',
      connection: 'connected',
      healthValue: 18,
      food: 20,
      position: { x: 1, y: 64, z: 2 },
      hostiles: 2,
      run: null,
      guards: { active: 0, firing: 0, error: 0 },
      watches: { active: 0, error: 0 },
    })
  })

  it('keeps an unknown hostile count as null rather than zero', async () => {
    const query: QueryPort = ref => {
      if (ref.op === 'entities') {
        return { status: 'failed', error: p2Error('ENTITIES_FAILED', 'environment', 'unavailable', { module: 'test.observe' }) }
      }
      return { status: 'ok', value: { health: 5, x: 0, y: 64, z: 0 }, meta: meta(ref.op) }
    }
    const host = new BehaviorHost({ bindingId: 'card-2', query, act })
    const runtime = new BodyRuntime({ body, owner, behavior: host })
    const response = await runtime.handleRequestAsync({
      protocol: 1,
      requestId: 'card-2',
      method: 'card',
      bodyEpoch: runtime.bodyEpoch,
      params: {},
    })
    const card = response.result as unknown as CardResult
    expect(card.hostiles).toBeNull()
    expect(card.healthValue).toBe(5)
  })
})

describe('observation summaries', () => {
  it('summarizes inventory counts purely', () => {
    const summary = summarizeInventory([
      { name: 'oak_log', count: 3 },
      { name: 'oak_log', count: 2 },
      { name: 'bread', count: 4 },
    ])
    expect(summary).toEqual({
      items: [
        { name: 'oak_log', count: 3 },
        { name: 'oak_log', count: 2 },
        { name: 'bread', count: 4 },
      ],
      total: 9,
      distinct: 2,
      byName: { oak_log: 5, bread: 4 },
    })
    expect(summarizeInventory(null)).toEqual({ items: [], total: 0, distinct: 0, byName: {} })
  })

  it('summarizes entity hostility and nearest distance', () => {
    const summary = summarizeEntities([
      { id: 1, name: 'zombie', kind: 'Hostile mobs', distance: 7 },
      { id: 2, name: 'cow', kind: 'Passive mobs', distance: 2 },
      { id: 3, name: 'skeleton', kind: 'Hostile mobs', distance: 4 },
    ])
    expect(summary).toEqual({ count: 3, hostile: 2, nearestDistance: 2 })
  })

  it('ignores malformed rows instead of throwing', () => {
    const inventory = summarizeInventory([{ name: 'coal', count: -3 }, { name: 4, count: 1 }, null, 'x'])
    expect(inventory).toEqual({ items: [{ name: 'coal', count: 0 }], total: 0, distinct: 1, byName: { coal: 0 } })
    expect(summarizeEntities([{ distance: 'far' }, null])).toEqual({ count: 1, hostile: 0, nearestDistance: null })
  })
})
