#!/usr/bin/env node
/**
 * Drive the dev Web API end to end: authenticate, create a Session, then run
 * `/p2 start`, `/p2 status`, and `/p2 stop` through the real command surface.
 *
 * Usage: node scripts/dev-api-smoke.mjs <web-url-with-token> <workspace>
 */
const [rawUrl, workspace] = process.argv.slice(2)
if (rawUrl === undefined || workspace === undefined) {
  console.error('usage: node scripts/dev-api-smoke.mjs <web-url-with-token> <workspace>')
  process.exit(2)
}

const url = new URL(rawUrl)
const origin = url.origin
const token = url.searchParams.get('token')
if (token === null) {
  console.error('the URL must contain the launch token')
  process.exit(2)
}

let cookie
const auth = await fetch(url, { redirect: 'manual' })
const setCookie = auth.headers.getSetCookie?.() ?? []
if (setCookie.length > 0) cookie = setCookie[0].split(';', 1)[0]
else {
  const raw = auth.headers.get('set-cookie')
  if (raw !== null) cookie = raw.split(';', 1)[0]
}
if (cookie === undefined) {
  console.error(`authentication failed: HTTP ${auth.status}`)
  process.exit(1)
}

let rpcSeq = 0
async function rpc(method, args) {
  rpcSeq += 1
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `dev-api-smoke-${rpcSeq}`,
      method,
      payload: { args },
    }),
  })
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json()
  if (!body.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(body.result)}`)
  return body.result.value
}

async function command(sessionId, line) {
  const value = await rpc('commands/execute', {
    agentId: sessionId,
    line,
    submittedAttachments: [],
  })
  return value.result
}

try {
  const created = await rpc('session/create', { request: { cwd: workspace } })
  const sessionId = created.sessionId
  console.log(`session: ${sessionId}`)

  const initial = await command(sessionId, '/p2 status')
  console.log(`/p2 status before start: ${JSON.stringify(initial)}`)
  if (initial?.kind !== 'success' || !String(initial.text).includes('inactive')) {
    throw new Error('body was not inactive before start')
  }

  const setup = await command(sessionId, '/p2 setup')
  console.log(`/p2 setup: ${JSON.stringify(setup)}`)
  if (setup?.kind !== 'success') throw new Error('setup did not succeed')

  const started = await command(sessionId, '/p2 start')
  console.log(`/p2 start: ${JSON.stringify(started)}`)
  if (started?.kind !== 'success') throw new Error('start did not succeed')

  const status = await command(sessionId, '/p2 status')
  console.log(`/p2 status: ${JSON.stringify(status)}`)
  if (status?.kind !== 'success' || !String(status.text).includes('P2 body active')) {
    throw new Error('status did not report an active body')
  }

  const stopped = await command(sessionId, '/p2 stop')
  console.log(`/p2 stop: ${JSON.stringify(stopped)}`)
  if (stopped?.kind !== 'success') throw new Error('stop did not succeed')

  const after = await command(sessionId, '/p2 status')
  console.log(`/p2 status after stop: ${JSON.stringify(after)}`)
  if (after?.kind !== 'success' || !String(after.text).includes('inactive')) {
    throw new Error('status did not report an inactive body after stop')
  }
  console.log('dev-api-smoke: ok')
} catch (error) {
  console.error(`dev-api-smoke: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
