import { describe, expect, it } from 'vitest'

import { contentVersion } from '../src/mind/content-version.ts'

/**
 * Category: data integrity (journal identity).
 * Protects: the plan content hash is stable across filesystem key order and
 * changes when the plan content changes.
 */
describe('plan content version', () => {
  it('hashes the same plans identically regardless of key order', () => {
    const left = { z: 1, a: { c: [3, 4], b: 2 } }
    const right = { a: { b: 2, c: [3, 4] }, z: 1 }
    expect(contentVersion(left)).toBe(contentVersion(right))
  })

  it('changes when a plan changes', () => {
    const base = { tiny: { id: 'tiny', version: 1 } }
    const changed = { tiny: { id: 'tiny', version: 2 } }
    expect(contentVersion(base)).not.toBe(contentVersion(changed))
  })
})
