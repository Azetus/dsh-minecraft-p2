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

const P2_ACTS = [
  'craft',
  'furnace-load',
  'furnace-take',
  'chest-transfer',
  'toss-item',
  'sleep',
  'respawn',
  'interact',
  'trade',
  'mount',
] as const

const BED_COLORS = [
  'white_bed',
  'orange_bed',
  'magenta_bed',
  'light_blue_bed',
  'yellow_bed',
  'lime_bed',
  'pink_bed',
  'gray_bed',
  'light_gray_bed',
  'cyan_bed',
  'purple_bed',
  'blue_bed',
  'brown_bed',
  'green_bed',
  'red_bed',
  'black_bed',
]

describe('P2 baseline act artifacts', () => {
  for (const name of P2_ACTS) {
    it(`${name} has no forbidden syntax and loads its manifest`, () => {
      const code = readAct(name)
      expect(forbiddenToken(code)).toBeUndefined()
      const { sandbox } = harness()
      const manifest = sandbox.load('act', code) as { id: string }
      expect(manifest.id).toBe(name)
    })
  }

  it('craft submits one craft op with the optional count and table', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('craft'))
    expect(sandbox.start({ item: 'stick', count: 4, table: { x: 1, y: 2, z: 3 } })).toEqual({ kind: 'running' })
    expect(ops).toEqual([
      { kind: 'control', name: 'craft', args: { item: 'stick', count: 4, table: { x: 1, y: 2, z: 3 } }, id: 1 },
    ])
    expect(sandbox.update(handles([[1, 'ok', { item: 'stick', count: 4 }]])))
      .toEqual({ kind: 'complete', result: { item: 'stick', count: 4 } })
  })

  it('craft reports a failed handle as a failed act', () => {
    const { sandbox } = harness()
    sandbox.load('act', readAct('craft'))
    sandbox.start({ item: 'stick' })
    expect(sandbox.update(handles([[1, 'failed']]))).toMatchObject({ kind: 'failed' })
  })

  it('furnace-load loads input then fuel and completes', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('furnace-load'))
    expect(sandbox.start({
      pos: { x: 1, y: 64, z: 2 },
      input: { item: 'raw_iron', count: 3 },
      fuel: { item: 'coal', count: 2 },
    })).toEqual({ kind: 'running' })
    expect(ops).toEqual([
      {
        kind: 'control',
        name: 'container-transfer',
        args: { x: 1, y: 64, z: 2, action: 'load-input', item: 'raw_iron', count: 3 },
        id: 1,
      },
    ])
    expect(sandbox.update(handles([[1, 'ok', { action: 'load-input' }]]))).toEqual({ kind: 'running' })
    expect(ops).toEqual([
      {
        kind: 'control',
        name: 'container-transfer',
        args: { x: 1, y: 64, z: 2, action: 'load-input', item: 'raw_iron', count: 3 },
        id: 1,
      },
      {
        kind: 'control',
        name: 'container-transfer',
        args: { x: 1, y: 64, z: 2, action: 'load-fuel', item: 'coal', count: 2 },
        id: 2,
      },
    ])
    expect(sandbox.update(handles([[2, 'ok', { action: 'load-fuel' }]]))).toEqual({ kind: 'complete', result: { loaded: true } })
  })

  it('furnace-take submits one take-output transfer and completes from the handle', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('furnace-take'))
    expect(sandbox.start({ pos: { x: 3, y: 64, z: -2 } })).toEqual({ kind: 'running' })
    expect(ops).toEqual([
      {
        kind: 'control',
        name: 'container-transfer',
        args: { x: 3, y: 64, z: -2, action: 'take-output' },
        id: 1,
      },
    ])
    const output = { action: 'take-output', kind: 'furnace', item: 'iron_ingot', count: 2 }
    expect(sandbox.update(handles([[1, 'ok', output]]))).toEqual({ kind: 'complete', result: output })
  })

  it('furnace-take reports a failed handle as a failed act', () => {
    const { sandbox } = harness()
    sandbox.load('act', readAct('furnace-take'))
    sandbox.start({ pos: { x: 3, y: 64, z: -2 } })
    expect(sandbox.update(handles([[1, 'failed']]))).toMatchObject({ kind: 'failed' })
  })

  it('chest-transfer forwards the action, item and count', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('chest-transfer'))
    expect(sandbox.start({ pos: { x: 0, y: 64, z: 0 }, action: 'withdraw', item: 'bread', count: 5 }))
      .toEqual({ kind: 'running' })
    expect(ops).toEqual([
      {
        kind: 'control',
        name: 'container-transfer',
        args: { x: 0, y: 64, z: 0, action: 'withdraw', item: 'bread', count: 5 },
        id: 1,
      },
    ])
    const transfer = { action: 'withdraw', kind: 'chest', item: 'bread', count: 5 }
    expect(sandbox.update(handles([[1, 'ok', transfer]]))).toEqual({ kind: 'complete', result: transfer })
  })

  it('toss-item submits one toss with the requested count', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('toss-item'))
    expect(sandbox.start({ item: 'dirt', count: 2 })).toEqual({ kind: 'running' })
    expect(ops).toEqual([{ kind: 'control', name: 'toss', args: { item: 'dirt', count: 2 }, id: 1 }])
    expect(sandbox.update(handles([[1, 'ok', { item: 'dirt', count: 2 }]])))
      .toEqual({ kind: 'complete', result: { item: 'dirt', count: 2 } })
  })

  it('sleep submits a direct sleep op when pos is given', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('sleep'))
    expect(sandbox.start({ pos: { x: 10, y: 63, z: -4 } })).toEqual({ kind: 'running' })
    expect(ops).toEqual([{ kind: 'control', name: 'sleep', args: { x: 10, y: 63, z: -4 }, id: 1 }])
    expect(sandbox.update(handles([[1, 'ok', { slept: true, timeOfDay: 13000 }]])))
      .toEqual({ kind: 'complete', result: { slept: true, timeOfDay: 13000 } })
  })

  it('sleep queries the bed colors and sleeps in the nearest bed', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('sleep'))
    expect(sandbox.start({})).toEqual({ kind: 'running' })
    expect(ops).toEqual([
      { kind: 'query', name: 'blocks', args: { names: BED_COLORS, radius: 16, count: 1 }, id: 1 },
    ])
    const beds = [
      { name: 'red_bed', x: 5, y: 64, z: 0, distance: 5 },
      { name: 'blue_bed', x: 2, y: 64, z: 0, distance: 2 },
    ]
    expect(sandbox.update(handles([[1, 'ok', beds]]))).toEqual({ kind: 'running' })
    expect(ops[1]).toEqual({ kind: 'control', name: 'sleep', args: { x: 2, y: 64, z: 0 }, id: 2 })
    expect(sandbox.update(handles([[2, 'ok', { slept: true }]])))
      .toEqual({ kind: 'complete', result: { slept: true } })
  })

  it('sleep fails with SLEEP_NO_BED when no bed is nearby', () => {
    const { sandbox } = harness()
    sandbox.load('act', readAct('sleep'))
    sandbox.start({})
    expect(sandbox.update(handles([[1, 'ok', []]]))).toMatchObject({
      kind: 'failed',
      error: { code: 'SLEEP_NO_BED' },
    })
  })

  it('respawn submits one respawn op and completes from the handle', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('respawn'))
    expect(sandbox.start({})).toEqual({ kind: 'running' })
    expect(ops).toEqual([{ kind: 'control', name: 'respawn', args: {}, id: 1 }])
    expect(sandbox.update(handles([[1, 'ok', { x: 0, y: 70, z: 0 }]])))
      .toEqual({ kind: 'complete', result: { x: 0, y: 70, z: 0 } })
  })

  it('respawn reports a failed handle as a failed act', () => {
    const { sandbox } = harness()
    sandbox.load('act', readAct('respawn'))
    sandbox.start({})
    expect(sandbox.update(handles([[1, 'failed']]))).toMatchObject({ kind: 'failed' })
  })

  it('interact equips the item first and then interacts', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('interact'))
    expect(sandbox.start({ entityId: 9, item: 'emerald' })).toEqual({ kind: 'running' })
    expect(ops).toEqual([
      { kind: 'control', name: 'equip', args: { item: 'emerald', destination: 'hand' }, id: 1 },
    ])
    expect(sandbox.update(handles([[1, 'ok', { item: 'emerald' }]]))).toEqual({ kind: 'running' })
    expect(ops).toEqual([
      { kind: 'control', name: 'equip', args: { item: 'emerald', destination: 'hand' }, id: 1 },
      { kind: 'control', name: 'interact', args: { entityId: 9 }, id: 2 },
    ])
    const response = { entityId: 9, name: 'villager' }
    expect(sandbox.update(handles([[2, 'ok', response]]))).toEqual({ kind: 'complete', result: response })
  })

  it('trade submits one trade with entityId, index and count', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('trade'))
    expect(sandbox.start({ entityId: 12, index: 2, count: 3 })).toEqual({ kind: 'running' })
    expect(ops).toEqual([
      { kind: 'control', name: 'trade', args: { entityId: 12, index: 2, count: 3 }, id: 1 },
    ])
    const trade = { entityId: 12, index: 2, count: 3 }
    expect(sandbox.update(handles([[1, 'ok', trade]]))).toEqual({ kind: 'complete', result: trade })
  })

  it('trade rejects a missing index with BAD_ARGS', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('trade'))
    expect(sandbox.start({ entityId: 12 })).toMatchObject({
      kind: 'failed',
      error: { code: 'BAD_ARGS' },
    })
    expect(ops).toEqual([])
  })

  it('mount submits one mount op and confirms the mount', () => {
    const { sandbox, ops } = harness()
    sandbox.load('act', readAct('mount'))
    expect(sandbox.start({ entityId: 31 })).toEqual({ kind: 'running' })
    expect(ops).toEqual([{ kind: 'control', name: 'mount', args: { entityId: 31 }, id: 1 }])
    expect(sandbox.update(handles([[1, 'ok', { entityId: 31, name: 'horse' }]])))
      .toEqual({ kind: 'complete', result: { mounted: true, entityId: 31 } })
  })
})
