import { describe, expect, it } from 'vitest'

import type { LastDisconnect } from '../src/contracts/protocol.ts'
import { isDuplicateLoginKick } from '../src/bridge/provider-disconnect.ts'

function kick(reason: string): LastDisconnect {
  return {
    at: 1,
    kind: 'kick',
    reason,
    eventLoopLagMs: 0,
    serverAge: 1,
    paused: false,
    ageIdleMs: 0,
  }
}

describe('provider disconnect policy', () => {
  it('recognizes duplicate_login in key, English and Chinese forms', () => {
    expect(isDuplicateLoginKick(kick('multiplayer.disconnect.duplicate_login'))).toBe(true)
    expect(isDuplicateLoginKick(kick('{"translate":"multiplayer.disconnect.duplicate_login"}'))).toBe(true)
    expect(isDuplicateLoginKick(kick('You logged in from another location'))).toBe(true)
    expect(isDuplicateLoginKick(kick('你已在异地登录'))).toBe(true)
  })

  it('does not suppress unrelated kicks or non-kick causes', () => {
    expect(isDuplicateLoginKick(kick('Kicked by Console: Cheating'))).toBe(false)
    expect(isDuplicateLoginKick({
      ...kick('You logged in from another location'),
      kind: 'end',
    })).toBe(false)
    expect(isDuplicateLoginKick(undefined)).toBe(false)
  })
})
