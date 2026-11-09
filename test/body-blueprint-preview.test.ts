import { describe, expect, it } from 'vitest'

import { BodyRuntime } from '../src/body/runtime.ts'
import type { BodyInfo, RequestEnvelope } from '../src/contracts/index.ts'
import type { BlueprintPreview } from '../src/body/blueprint-preview.ts'
import type { BlockInfo, BodyApi } from '../src/body/api.ts'

/**
 * Category: cross-module contract (M3-01 preview / M3-02 ingestion).
 * Protects: dry-run material/conflict/unknown accounting before any order,
 * with default-deny protection for containers and fluids.
 */

const body: BodyInfo = {
  manifest: {
    schemaVersion: 1,
    bodyVersion: '0.1.0',
    protocolVersion: 1,
    entry: 'body.mjs',
    files: { 'body.mjs': 'a'.repeat(64) },
  },
  manifestDigest: 'b'.repeat(64),
  bindingId: null,

  provider: null,
}

const cells: Record<string, BlockInfo> = {
  '0,64,0': { name: 'dirt', loaded: true },
  '1,64,0': { name: 'air', loaded: true },
  '2,64,0': { name: 'stone', loaded: true, solid: true },
  '3,64,0': { name: 'chest', loaded: true, solid: true },
}

function fakePort(): { port: BodyApi; writes: number } {
  let writes = 0
  const port = {
    blockAt: (p: { x: number; y: number; z: number }) => cells[`${p.x},${p.y},${p.z}`] ?? null,
    inventory: () => [{ slot: 0, name: 'dirt', count: 1 }],
    beginWrite: () => { writes += 1 },
    endWrite: () => {},
  } as unknown as BodyApi
  return { port, get writes() { return writes } }
}

function runtimeWith(port: BodyApi | undefined): BodyRuntime {
  return new BodyRuntime({
    body,
    owner: { sessionId: 's1', agentId: 'a1', cwd: 'C:/p2' },
    now: () => 1234,
    ...(port === undefined ? {} : { game: port }),
  })
}

function request(params: Record<string, unknown>): RequestEnvelope {
  return { protocol: 1, requestId: 'r1', method: 'blueprint.preview', params: params as never }
}

const blueprint = {
  blocks: [
    { x: 0, y: 64, z: 0, name: 'dirt' },
    { x: 1, y: 64, z: 0, name: 'dirt' },
    { x: 2, y: 64, z: 0, name: 'dirt' },
    { x: 3, y: 64, z: 0, name: 'dirt' },
    { x: 4, y: 64, z: 0, name: 'dirt' },
  ],
}

describe('blueprint preview', () => {
  it('reports satisfied, conflicts, unknown cells and missing materials', async () => {
    const fake = fakePort()
    const response = await runtimeWith(fake.port).handleRequestAsync(request({ blueprint }))
    const preview = response.result as unknown as BlueprintPreview
    expect(preview.ok).toBe(false)
    expect(preview.at).toBe(1234)
    expect(preview.blocks).toBe(5)
    expect(preview.satisfied).toBe(1)
    expect(preview.required).toEqual({ dirt: 5 })
    expect(preview.missing).toEqual({ dirt: 3 })
    expect(preview.unknownTotal).toBe(1)
    expect(preview.unknown).toEqual([{ x: 4, y: 64, z: 0 }])
    expect(preview.conflictTotal).toBe(2)
    expect(preview.conflicts.find(conflict => conflict.current === 'stone')).toMatchObject({ clearable: true })
    expect(preview.conflicts.find(conflict => conflict.current === 'chest')).toMatchObject({ clearable: false })
    expect(fake.writes).toBe(0)
  })

  it('reports invalid geometry without querying the world', async () => {
    const fake = fakePort()
    const response = await runtimeWith(fake.port).handleRequestAsync(request({
      blueprint: { blocks: [{ x: 0, y: 64, z: 0, name: 'dirt' }, { x: 0, y: 64, z: 0, name: 'dirt' }] },
    }))
    const preview = response.result as unknown as BlueprintPreview
    expect(preview.ok).toBe(false)
    expect(preview.invalid.join(' ')).toContain('duplicate')
  })

  it('reports no provider instead of pretending the blueprint is buildable', async () => {
    const response = await runtimeWith(undefined).handleRequestAsync(request({ blueprint }))
    expect(response.error?.code).toBe('NOT_INITIALIZED')
  })
})
