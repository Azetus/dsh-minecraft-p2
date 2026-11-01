import { describe, expect, it } from 'vitest'

import { canClearBlock, parseConflictPolicy, parseMaterialPolicy } from '../src/mind/policy.ts'

/**
 * Category: data (M3-03 conflict policy).
 * Protects: explicit deny wins, explicit allow overrides only the default
 * deny set, and malformed policy is rejected before an order is accepted.
 */

describe('conflict policy', () => {
  it('defaults to no policy (skip/attempt) and parses modes', () => {
    expect(parseConflictPolicy(undefined)).toEqual({ ok: true, policy: undefined })
    expect(parseConflictPolicy({ conflict: { mode: 'clear' } })).toEqual({
      ok: true,
      policy: { mode: 'clear' },
    })
    expect(parseConflictPolicy({ conflict: { mode: 'abort' } })).toMatchObject({ ok: true })
  })

  it('rejects unknown keys and invalid modes', () => {
    expect(parseConflictPolicy({ conflict: { mode: 'explode' } }).ok).toBe(false)
    expect(parseConflictPolicy({ conflict: { allow: [1] } }).ok).toBe(false)
    expect(parseConflictPolicy({ material: {} }).ok).toBe(false)
  })

  it('defaults to deny for containers and allows an explicit override', () => {
    const parsed = parseConflictPolicy({
      conflict: { mode: 'clear', allow: ['chest'], deny: ['grass_block'] },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.policy === undefined) return
    expect(canClearBlock(parsed.policy, 'chest')).toBe(true)
    expect(canClearBlock(parsed.policy, 'grass_block')).toBe(false)
    expect(canClearBlock(parsed.policy, 'stone')).toBe(true)
    expect(canClearBlock(parsed.policy, 'diamond_block')).toBe(true)
  })

  it('parses material policy and keeps it separate from conflict policy', () => {
    expect(parseMaterialPolicy(undefined)).toEqual({ ok: true, policy: undefined })
    expect(parseMaterialPolicy({ materials: { mode: 'auto-gather', maxGatherBlocks: 8 } })).toEqual({
      ok: true,
      policy: { mode: 'auto-gather', maxGatherBlocks: 8 },
    })
    expect(parseMaterialPolicy({ materials: { mode: 'explode' } }).ok).toBe(false)
    expect(parseMaterialPolicy({ materials: { maxGatherBlocks: -1 } }).ok).toBe(false)
    // The conflict parser tolerates a materials section; the material parser
    // validates it separately.
    expect(parseConflictPolicy({ materials: { mode: 'auto-gather' } })).toEqual({ ok: true, policy: undefined })
  })
})
