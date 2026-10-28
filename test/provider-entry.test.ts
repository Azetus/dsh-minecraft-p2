import { describe, expect, it } from 'vitest'

import * as providerEntry from '../src/provider/index.ts'

/**
 * The body imports the provider through this module entry and reads the
 * capability list from it. A missing export crashes the body right after the
 * bot connects, so the entry surface itself is part of the contract.
 */
describe('provider entry surface', () => {
  it('exports the capability list and provider id the body reads', () => {
    expect(Array.isArray(providerEntry.PROVIDER_CAPABILITIES)).toBe(true)
    expect(providerEntry.PROVIDER_CAPABILITIES).toContain('craft')
    expect(providerEntry.PROVIDER_CAPABILITIES).toContain('container')
    expect(typeof providerEntry.PROVIDER_ID).toBe('string')
    expect(providerEntry.PROVIDER_ID.length).toBeGreaterThan(0)
  })

  it('exports the provider class and connector', () => {
    expect(typeof providerEntry.MineflayerProvider).toBe('function')
    expect(typeof providerEntry.connectMineflayer).toBe('function')
  })
})
