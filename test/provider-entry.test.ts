import { describe, expect, it } from 'vitest'

import * as providerEntry from '../src/provider/index.ts'

/**
 * The body imports the provider through this module entry. A missing export
 * crashes the body right after the bot connects, so the entry surface itself
 * is part of the contract.
 */
describe('provider entry surface', () => {
  it('exports the provider id and opener', () => {
    expect(typeof providerEntry.PROVIDER_ID).toBe('string')
    expect(providerEntry.PROVIDER_ID.length).toBeGreaterThan(0)
    expect(typeof providerEntry.openMineflayerBody).toBe('function')
  })

  it('exports the provider class and connector', () => {
    expect(typeof providerEntry.MineflayerProvider).toBe('function')
    expect(typeof providerEntry.connectMineflayer).toBe('function')
  })
})


