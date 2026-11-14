/**
 * Category: upstream tripwire / data integrity.
 * Protects: the provider's component and legacy-NBT charged readback stays a
 * tri-state; unknown shapes must not become "empty".
 */

import { describe, expect, it } from 'vitest'

import { readChargedProjectiles } from '../src/provider/charged.ts'

const names: Record<number, string> = { 1: 'arrow', 2: 'firework_rocket' }
const nameOf = (id: number): string | undefined => names[id]

function componentItem(projectiles?: Array<{ itemId: number; itemCount?: number; components?: unknown[] }>): {
  components: unknown[]
  componentMap: Map<string, unknown>
} {
  return {
    components: projectiles === undefined
      ? []
      : [{ type: 'charged_projectiles', data: { projectiles } }],
    componentMap: new Map(),
  }
}

function nbtWithProjectiles(ids: string[]): {
  nbt: {
    type: string
    value: {
      ChargedProjectiles: {
        type: string
        value: { type: string; value: Array<{ type: string; value: Record<string, unknown> }> }
      }
    }
  }
} {
  return {
    nbt: {
      type: 'compound',
      value: {
        ChargedProjectiles: {
          type: 'list',
          value: {
            type: 'compound',
            value: ids.map(id => ({
              type: 'compound',
              value: { id: { type: 'string', value: id } },
            })),
          },
        },
      },
    },
  }
}

describe('crossbow charged readback', () => {
  it('reads component projectiles and treats a missing component as empty', () => {
    expect(readChargedProjectiles(componentItem([{ itemId: 1 }]), nameOf)).toEqual(['arrow'])
    expect(readChargedProjectiles(componentItem([]), nameOf)).toEqual([])
  })

  it('tolerates the 26.1 slot field order without a version check', () => {
    const swapped = (id: number): string | undefined => ({ 1: 'stone', 896: 'arrow' }[id])
    expect(readChargedProjectiles(
      componentItem([{ itemId: 1, itemCount: 896 }]),
      swapped,
    )).toEqual(['arrow'])
  })

  it('returns unknown for malformed or unparsed component data', () => {
    expect(readChargedProjectiles({
      components: [{ type: 'charged_projectiles', data: {} }],
      componentMap: new Map(),
    }, nameOf)).toBeUndefined()
    expect(readChargedProjectiles({ componentMap: new Map() }, nameOf)).toBeUndefined()
  })

  it('reads legacy NBT ChargedProjectiles', () => {
    expect(readChargedProjectiles(nbtWithProjectiles(['minecraft:arrow']), nameOf)).toEqual(['arrow'])
    expect(readChargedProjectiles(nbtWithProjectiles(['minecraft:firework_rocket']), nameOf))
      .toEqual(['firework_rocket'])
  })

  it('treats a null/empty legacy NBT as empty, but Charged alone as unknown', () => {
    expect(readChargedProjectiles({ nbt: null }, nameOf)).toEqual([])
    expect(readChargedProjectiles({
      nbt: {
        type: 'compound',
        value: { Charged: { type: 'byte', value: 1 } },
      },
    }, nameOf)).toBeUndefined()
  })
})
