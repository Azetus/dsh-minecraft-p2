/**
 * Category: state safety.
 * Protects: load success is charged+arrow with no shot; unknown charged state
 * never activates; stop cancels without release.
 */

import { describe, expect, it } from 'vitest'

import type { BodyApi, EntityInfo, Item } from '../src/body/api.ts'
import { loadCrossbow } from '../src/mind/ranged/crossbow.ts'

type Mode = 'release-load' | 'hold-load' | 'already-loaded' | 'unknown' | 'firework' | 'unexpected-fire'

function fake(mode: Mode): {
  body: BodyApi
  starts: () => number
  releases: () => number
  cancels: () => number
  arrows: () => EntityInfo[]
} {
  let charged: string[] | undefined = mode === 'unknown'
    ? undefined
    : mode === 'already-loaded' ? ['arrow']
      : mode === 'firework' ? ['firework_rocket'] : []
  let starts = 0
  let releases = 0
  let cancels = 0
  const arrows: EntityInfo[] = []
  const held = (): Item => ({
    slot: 0,
    name: 'crossbow',
    count: 1,
    ...(charged === undefined ? {} : { chargedProjectiles: [...charged] }),
  })
  const body = {
    self: () => ({
      pos: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      yaw: 0,
      pitch: 0,
      onGround: true,
      inWater: false,
      inLava: false,
    }),
    identity: () => ({ worldId: 'w', characterId: 'c' }),
    blockAt: () => ({ name: 'air', loaded: true }),
    biomeAt: () => null,
    blocksIn: () => [],
    findBlocks: () => [],
    inventory: () => [{ slot: 1, name: 'arrow', count: 8 }],
    offhand: () => undefined,
    held,
    entities: () => arrows,
    entityById: () => undefined,
    canSee: () => true,
    equip: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    itemUseStart: async () => {
      starts += 1
      if (mode === 'unexpected-fire') {
        arrows.push({
          id: 'stray-arrow', name: 'arrow', position: { x: 0, y: 65, z: 0 },
          width: 0.5, height: 0.5,
        })
      } else if (mode === 'hold-load') {
        charged = ['arrow']
      }
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    itemUseRelease: async () => {
      releases += 1
      if (mode === 'release-load') charged = ['arrow']
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    itemUseCancel: async () => {
      cancels += 1
      return { state: 'ok' as const, elapsedMs: 1 }
    },
    moveTo: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    lookAt: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    lookYaw: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    dig: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    place: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    useItem: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    offhandHold: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    unequip: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    craft: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    useOn: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    attack: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    sleep: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    containerAt: async () => ({ state: 'failed' as const, code: 'NO' }),
    containerTransfer: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    fatalStep: async () => ({ state: 'ok' as const, elapsedMs: 1 }),
    beginWrite: () => {},
    endWrite: () => {},
    say: () => {},
    on: () => {},
    off: () => {},
  } as unknown as BodyApi
  return {
    body,
    starts: () => starts,
    releases: () => releases,
    cancels: () => cancels,
    arrows: () => arrows,
  }
}

describe('loadCrossbow action', () => {
  it('loads on release (1.21.1 behaviour)', async () => {
    const item = fake('release-load')
    const result = await loadCrossbow(item.body, { chargeWaitMs: 120, settleWaitMs: 120, pollMs: 10 })
    expect(result.state).toBe('succeeded')
    expect(result.observed).toMatchObject({ alreadyLoaded: false, released: true, shotObserved: false })
    expect(item.releases()).toBe(1)
  })

  it('detects a load completed during the hold (26.1.2 behaviour)', async () => {
    const item = fake('hold-load')
    const result = await loadCrossbow(item.body, { chargeWaitMs: 120, settleWaitMs: 120, pollMs: 10 })
    expect(result.state).toBe('succeeded')
    expect(result.observed).toMatchObject({ alreadyLoaded: false, released: true, shotObserved: false })
    expect(item.releases()).toBe(1)
  })

  it('accepts an already loaded crossbow without using it', async () => {
    const item = fake('already-loaded')
    const result = await loadCrossbow(item.body)
    expect(result.state).toBe('succeeded')
    expect(result.observed).toMatchObject({ alreadyLoaded: true, released: false, shotObserved: false })
    expect(item.starts()).toBe(0)
    expect(item.releases()).toBe(0)
  })

  it('fails closed on unknown charged state', async () => {
    const item = fake('unknown')
    const result = await loadCrossbow(item.body)
    expect(result.state).toBe('failed')
    expect(result.code).toBe('CROSSBOW_LOAD_STATE_UNKNOWN')
    expect(item.starts()).toBe(0)
  })

  it('rejects a firework already loaded', async () => {
    const item = fake('firework')
    const result = await loadCrossbow(item.body)
    expect(result.state).toBe('failed')
    expect(result.code).toBe('CROSSBOW_UNSUPPORTED_PROJECTILE')
    expect(item.starts()).toBe(0)
  })

  it('detects an unexpected shot during loading and cancels', async () => {
    const item = fake('unexpected-fire')
    const result = await loadCrossbow(item.body, { chargeWaitMs: 120, settleWaitMs: 120, pollMs: 10 })
    expect(result.state).toBe('failed')
    expect(result.code).toBe('CROSSBOW_UNEXPECTED_FIRE')
    expect(item.cancels()).toBeGreaterThan(0)
  })

  it('cancels on stop without releasing', async () => {
    const item = fake('release-load')
    let stopped = false
    setTimeout(() => { stopped = true }, 20)
    const result = await loadCrossbow(item.body, {
      chargeWaitMs: 200,
      settleWaitMs: 120,
      pollMs: 10,
      isStopped: () => stopped,
    })
    expect(result.state).toBe('interrupted')
    expect(item.releases()).toBe(0)
    expect(item.cancels()).toBeGreaterThan(0)
  })
})
