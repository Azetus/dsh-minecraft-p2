import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { forbiddenToken } from '../src/core/act-checker.ts'
import type { JsonValue } from '../src/contracts/types.ts'
import { Sandbox } from '../src/runner/sandbox.ts'

const ACT_DIR = join(process.cwd(), 'acts')

function readAct(name: string): string {
  return readFileSync(join(ACT_DIR, `${name}.mjs`), 'utf8')
}

function harness(): { sandbox: Sandbox; ops: Array<{ kind: string; name: string; args: JsonValue; id: number }> } {
  const ops: Array<{ kind: string; name: string; args: JsonValue; id: number }> = []
  const sandbox = new Sandbox({
    op: (kind, name, args) => {
      const id = ops.length + 1
      ops.push({ kind, name, args, id })
      return id
    },
    log: () => {},
    now: () => 0,
  })
  return { sandbox, ops }
}

function handles(entries: Array<[number, 'ok' | 'failed', JsonValue?]>): { handles: Array<{ id: number; status: string; value?: JsonValue }> } {
  return {
    handles: entries.map(([id, status, value]) => (value === undefined ? { id, status } : { id, status, value })),
  }
}

describe('baseline act artifacts', () => {
  for (const name of ['place-block', 'attack-one', 'equip-item', 'use-item']) {
    it(`${name} has no forbidden syntax and loads its manifest`, () => {
      const code = readAct(name)
      expect(forbiddenToken(code)).toBeUndefined()
      const { sandbox } = harness()
      const manifest = sandbox.load('act', code) as { id: string }
      expect(manifest.id).toBe(name)
    })
  }

  it('attack-one submits one attack and completes from the handle', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('attack-one'))
    expect(sandbox.start({ entityId: 42 })).toEqual({ kind: 'running' })
    expect(ops).toEqual([{ kind: 'control', name: 'attack', args: { entityId: 42 }, id: 1 }])
    expect(sandbox.update(handles([[1, 'ok', { entityId: 42 }]])))
      .toEqual({ kind: 'complete', result: { entityId: 42 } })
  })

  it('attack-one reports a failed handle as a failed act', () => {
    const { sandbox } = harness()
    sandbox.load('act', readAct('attack-one'))
    sandbox.start({ entityId: 7 })
    expect(sandbox.update(handles([[1, 'failed']]))).toMatchObject({ kind: 'failed' })
  })

  it('equip-item maps the requested destination', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('equip-item'))
    sandbox.start({ item: 'stone_sword', destination: 'hand' })
    expect(ops[0]).toMatchObject({ kind: 'control', name: 'equip', args: { item: 'stone_sword', destination: 'hand' } })
    expect(sandbox.update(handles([[1, 'ok', { item: 'stone_sword' }]])))
      .toEqual({ kind: 'complete', result: { item: 'stone_sword' } })
  })

  it('use-item forwards duration and offhand', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('use-item'))
    sandbox.start({ durationMs: 1600, offhand: true })
    expect(ops[0]).toMatchObject({ kind: 'control', name: 'use', args: { durationMs: 1600, offhand: true } })
    expect(sandbox.update(handles([[1, 'ok', { item: 'bread' }]])))
      .toEqual({ kind: 'complete', result: { item: 'bread' } })
  })

  it('place-block chooses a supporting face locally and equips the item first', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('place-block'))
    expect(sandbox.start({ pos: { x: 1, y: 2, z: 3 }, item: 'dirt' })).toEqual({ kind: 'running' })
    expect(ops.slice(0, 7)).toEqual([
      { kind: 'query', name: 'block', args: { x: 1, y: 2, z: 3 }, id: 1 },
      { kind: 'query', name: 'block', args: { x: 1, y: 1, z: 3 }, id: 2 },
      { kind: 'query', name: 'block', args: { x: 1, y: 2, z: 4 }, id: 3 },
      { kind: 'query', name: 'block', args: { x: 1, y: 2, z: 2 }, id: 4 },
      { kind: 'query', name: 'block', args: { x: 0, y: 2, z: 3 }, id: 5 },
      { kind: 'query', name: 'block', args: { x: 2, y: 2, z: 3 }, id: 6 },
      { kind: 'query', name: 'block', args: { x: 1, y: 3, z: 3 }, id: 7 },
    ])
    const queryResults = handles([
      [1, 'ok', { name: 'air' }],
      [2, 'ok', { name: 'stone' }],
      [3, 'ok', { name: 'air' }],
      [4, 'ok', { name: 'air' }],
      [5, 'ok', { name: 'air' }],
      [6, 'ok', { name: 'air' }],
      [7, 'ok', { name: 'air' }],
    ])
    expect(sandbox.update(queryResults)).toEqual({ kind: 'running' })
    expect(ops[7]).toMatchObject({ kind: 'control', name: 'equip', args: { item: 'dirt', destination: 'hand' } })
    expect(sandbox.update(handles([[8, 'ok', { item: 'dirt' }]]))).toEqual({ kind: 'running' })
    expect(ops[8]).toMatchObject({ kind: 'control', name: 'place', args: { x: 1, y: 2, z: 3, face: 'up' } })
    expect(sandbox.update(handles([[9, 'ok', { name: 'dirt' }]])))
      .toEqual({ kind: 'complete', result: { name: 'dirt' } })
  })

  it('place-block fails when the target is occupied', () => {
    const { sandbox } = harness()
    sandbox.load('act', readAct('place-block'))
    sandbox.start({ pos: { x: 1, y: 2, z: 3 } })
    const queryResults = handles([
      [1, 'ok', { name: 'stone' }],
      [2, 'ok', { name: 'stone' }],
      [3, 'ok', { name: 'air' }],
      [4, 'ok', { name: 'air' }],
      [5, 'ok', { name: 'air' }],
      [6, 'ok', { name: 'air' }],
      [7, 'ok', { name: 'air' }],
    ])
    expect(sandbox.update(queryResults)).toMatchObject({
      kind: 'failed',
      error: { code: 'PLACE_UNSUPPORTED' },
    })
  })
})
