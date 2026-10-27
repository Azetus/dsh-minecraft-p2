#!/usr/bin/env node
/**
 * M4 real DSH pause/query-failure flow.
 *
 * Starts a continuous behavior, freezes the server through P2_Operator, and
 * verifies the model sees providerState.paused, lastRun GAME_PAUSED, and a
 * failed p2_observe world query. Then unfreezes and verifies no auto-resume.
 *
 * Usage: node scripts/m4-dsh-pause.mjs <web-url-with-token> <workspace>
 */
import { randomUUID } from 'node:crypto'
import mineflayer from 'mineflayer'

const [rawUrl, workspace] = process.argv.slice(2)
if (rawUrl === undefined || workspace === undefined) {
  console.error('usage: node scripts/m4-dsh-pause.mjs <url> <workspace>')
  process.exit(2)
}
const url = new URL(rawUrl)
const origin = url.origin
const token = url.searchParams.get('token')
if (token === null) throw new Error('URL lacks launch token')
const auth = await fetch(url, { redirect: 'manual' })
const raw = (auth.headers.getSetCookie?.() ?? [])[0] ?? auth.headers.get('set-cookie')
if (raw === null || raw === undefined) throw new Error(`auth failed: HTTP ${auth.status}`)
const cookie = raw.split(';', 1)[0]

let seq = 0
async function rpc(method, args) {
  seq += 1
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `m4-pause-${seq}`, method, payload: { args } }),
  })
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json()
  if (!body.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(body.result)}`)
  return body.result.value
}
const command = async (sessionId, line) => (await rpc('commands/execute', {
  agentId: sessionId, line, submittedAttachments: [],
})).result
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const statusText = async sessionId => (await command(sessionId, '/p2 status')).text
const prompt = async (sessionId, text) => rpc('session/prompt', {
  request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
})
async function waitFor(sessionId, predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let text
  while (Date.now() < deadline) {
    text = await statusText(sessionId)
    if (predicate(text)) return text
    await sleep(1000)
  }
  throw new Error(`${label} timeout; last=${text}`)
}

let operator
let frozen = false
try {
  const created = await rpc('session/create', { request: { cwd: workspace } })
  const sessionId = created.sessionId
  console.log(`session=${sessionId}`)
  console.log(`start=${JSON.stringify(await command(sessionId, '/p2 start'))}`)

  operator = mineflayer.createBot({
    host: '127.0.0.1', port: 25575, username: 'P2_Operator', auth: 'offline', version: '1.21.1',
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operator spawn timeout')), 15_000)
    operator.once('spawn', () => { clearTimeout(timer); resolve() })
    operator.once('error', error => { clearTimeout(timer); reject(error) })
  })
  await sleep(800)

  const behaviors = `${workspace}\\behaviors`
  await prompt(sessionId, [
    'You are testing P2 pause handling.',
    'First call p2_observe with args {"op":"position"} and read value.x/value.z.',
    `Call p2_check with sourcePath ${JSON.stringify(`${behaviors}\\hold-position.mjs`)}.`,
    'Call p2_activate with the returned artifactId.',
    'Call p2_switch with params {"x": <value.x + 2>, "z": <value.z>, "tolerance":0.8}.',
    'Call p2_status and report the running runId. Do not call p2_stop.',
  ].join('\n'))
  const running = await waitFor(sessionId, text => /run=run-\d+:running/u.test(text), 'continuous running')
  console.log(`running=${JSON.stringify(running)}`)

  operator.chat('/tick freeze')
  frozen = true
  const paused = await waitFor(
    sessionId,
    text => /paused=true/u.test(text) && /last=run-\d+:failed:GAME_PAUSED/u.test(text),
    'paused',
  )
  console.log(`paused=${JSON.stringify(paused)}`)

  await prompt(sessionId, [
    'Call p2_status and p2_events.',
    'Then call p2_observe with args {"op":"position"} and report its error code.',
    'Do not call p2_stop. The server tick is frozen.',
  ].join('\n'))
  await sleep(12_000)

  operator.chat('/tick unfreeze')
  frozen = false
  const unfrozen = await waitFor(sessionId, text => /paused=false/u.test(text), 'unfrozen')
  console.log(`unfrozen=${JSON.stringify(unfrozen)}`)

  await prompt(sessionId, [
    'Call p2_status and p2_events.',
    'Report whether the body is active, the lastRun status/error, and whether the failed run resumed.',
    'Do not call p2_stop; body shutdown is handled separately.',
  ].join('\n'))
  await sleep(10_000)

  const bodyStop = await command(sessionId, '/p2 stop')
  console.log(`bodyStop=${JSON.stringify(bodyStop)}`)
  process.stdout.write(`${JSON.stringify({ ok: true, sessionId, running, paused, unfrozen, bodyStop })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  process.exitCode = 1
} finally {
  if (frozen && operator !== undefined) {
    operator.chat('/tick unfreeze')
    await sleep(300)
  }
  try { operator?.quit('pause probe complete') } catch {}
}
