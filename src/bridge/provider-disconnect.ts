import type { LastDisconnect } from '../contracts/protocol.ts'

/**
 * A duplicate login is a terminal ownership conflict, not a transient network
 * failure: auto-restarting here makes two sessions kick each other forever.
 */
const DUPLICATE_LOGIN = /duplicate[_\s-]?login|logged in from another location|another location|异地登录|你已在异地登录|已在另一处登录/i

export function isDuplicateLoginKick(last: LastDisconnect | undefined): boolean {
  return last?.kind === 'kick' && DUPLICATE_LOGIN.test(last.reason)
}
