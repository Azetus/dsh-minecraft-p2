/** One Minecraft server target supplied at body start, never from config.json. */
export type McTarget = { host: string; port: number }

const MAX_HOST_LENGTH = 253
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/u

/** Render a target for operator text; IPv6 hosts are bracketed. */
export function formatTarget(target: McTarget): string {
  return target.host.includes(':') ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`
}

/**
 * Parse the slash-command tail: `<host>:<port>`, `[::1]:25575`, or
 * `<host> <port>`. The agent tool passes host/port as separate fields.
 */
export function parseTargetArgs(args: readonly string[]): { target: McTarget } | { error: string } {
  if (args.length === 0) return { error: '用法: /p2 start <host>:<port>' }
  if (args.length === 1) return parseTargetToken(args[0] as string)
  if (args.length === 2) return makeTarget(args[0] as string, args[1] as string)
  return { error: '用法: /p2 start <host>:<port> 或 /p2 start <host> <port>' }
}

/** Parse the separate host/port fields used by the `p2_body` tool. */
export function parseTargetFields(host: unknown, port: unknown): { target: McTarget } | { error: string } {
  if (typeof host !== 'string' || host.length === 0) return { error: 'host is required' }
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (typeof port !== 'number' && typeof port !== 'string') return { error: 'port is required' }
  return makeTarget(unwrapped, String(port))
}

function parseTargetToken(token: string): { target: McTarget } | { error: string } {
  const text = token.trim()
  if (text.length === 0) return { error: 'target is empty' }
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 0) return { error: 'IPv6 target is missing ]' }
    const rest = text.slice(close + 1)
    if (!rest.startsWith(':')) return { error: 'IPv6 target must be [host]:port' }
    return makeTarget(text.slice(1, close), rest.slice(1))
  }
  const colon = text.lastIndexOf(':')
  if (colon <= 0) return { error: '用法: /p2 start <host>:<port>' }
  const host = text.slice(0, colon)
  if (host.includes(':')) return { error: 'IPv6 target must be [host]:port' }
  return makeTarget(host, text.slice(colon + 1))
}

function makeTarget(host: string, portText: string): { target: McTarget } | { error: string } {
  const hostText = host.trim()
  if (hostText.length === 0) return { error: 'host is required' }
  if (hostText.length > MAX_HOST_LENGTH) return { error: 'host is too long' }
  if (CONTROL_OR_SPACE.test(hostText)) return { error: 'host contains whitespace or control characters' }
  if (hostText.includes('/') || hostText.includes('://')) return { error: 'host must not be a URL' }
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { error: 'port must be an integer between 1 and 65535' }
  }
  return { target: { host: hostText, port } }
}
