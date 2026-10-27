#!/usr/bin/env node
/**
 * M4 real DSH blocked + recovery + cancel flow.
 *
 * A P2_Operator test bot builds a short barrier wall in front of the body,
 * the agent switches to a target beyond it (must fail MOVE_TO_BLOCKED), then
 * switches to a target behind it (must succeed), then starts a continuous
 * behavior and cancels it with p2_stop.
 *
 * Usage: node scripts/m4-dsh-failure.mjs <web-url-with-token> <workspace>
 */
import { randomUUID } from 'node:crypto'
import mineflayer from 'mineflayer'

const [rawUrl, workspace] = process.argv.slice(2)
if (rawUrl === undefined || workspace === undefined) {
  console.error('usage: node scripts/m4-dsh-failure.mjs <url> <workspace>')
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
    body: JSON.stringify({ type: 'client-request', rpcId: `m4-fail-${seq}`, method, payload: { args } }),
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
let wall
try {
  const created = await rpc('session/create', { request: { cwd: workspace } })
  const sessionId = created.sessionId
  console.log(`session=${sessionId}`)
  const started = await command(sessionId, '/p2 start')
  console.log(`start=${JSON.stringify(started)}`)

  operator = mineflayer.createBot({
    host: '127.0.0.1', port: 25575, username: 'P2_Operator', auth: 'offline', version: '1.21.1',
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operator spawn timeout')), 15_000)
    operator.once('spawn', () => { clearTimeout(timer); resolve() })
    operator.once('error', error => { clearTimeout(timer); reject(error) })
  })
  await sleep(800)
  operator.chat('/tp P2_Bot P2_Operator')
  await sleep(1000)

  const deadline = Date.now() + 20_000
  let p2
  while (Date.now() < deadline) {
    p2 = operator.players.P2_Bot?.entity?.position
    if (p2 !== undefined) break
    await sleep(500)
  }
  if (p2 === undefined) throw new Error('P2_Bot did not appear')
  const x = Math.floor(p2.x)
  const y = Math.floor(p2.y)
  const z = Math.floor(p2.z)
  wall = { x: x + 1, y, z: z - 2, x2: x + 1, y2: y + 2, z2: z + 2 }
  operator.chat(`/fill ${wall.x} ${wall.y} ${wall.z} ${wall.x2} ${wall.y2} ${wall.z2} barrier`)
  await sleep(500)
  console.log(`wall=${JSON.stringify(wall)}`)

  const behaviors = `${workspace}\\behaviors`
  let targetX = p2.x + 3
  let targetZ = p2.z
  await prompt(sessionId, [
    'You are testing a blocked P2 behavior.',
    'First call p2_observe with args {"op":"position"} and read value.x/value.z.',
    `Call p2_check with sourcePath ${JSON.stringify(`${behaviors}\\approach-target.mjs`)}.`,
    'Call p2_activate with the returned artifactId.',
    'Call p2_switch with params {"x": <value.x + 3>, "z": <value.z>, "tolerance":0.8}.',
    'A short wall is immediately in front of the bot. Do not change the target.',
    'Call p2_status and report the result; do not call p2_stop.',
  ].join('\n'))
  const blocked = await waitFor(sessionId, text => /last=run-\d+:failed:MOVE_TO_BLOCKED/u.test(text), 'blocked failure')
  console.log(`blocked=${JSON.stringify(blocked)}`)

  await prompt(sessionId, [
    'Call p2_events and then p2_status.',
    'Report the failed run and its error code. Do not change the target yet.',
  ].join('\n'))
  await sleep(12_000)

  await prompt(sessionId, [
    'The wall is still present, but the next target is behind the bot and unobstructed.',
    'Call p2_observe with args {"op":"position"} and read value.x/value.z.',
    'Call p2_switch on the same activated approach artifact with params {"x": <value.x - 2>, "z": <value.z>, "tolerance":0.8}.',
    'Call p2_status and report the new run and lastRun.',
  ].join('\n'))
  const recovered = await waitFor(sessionId, text => /last=run-\d+:succeeded/u.test(text), 'recovered success')
  console.log(`recovered=${JSON.stringify(recovered)}`)

  await prompt(sessionId, [
    'Now test cancellation of a continuous behavior.',
    'Call p2_observe with args {"op":"position"} and read value.x/value.z.',
    `Call p2_check with sourcePath ${JSON.stringify(`${behaviors}\\hold-position.mjs`)}.`,
    'Call p2_activate with the returned artifactId.',
    'Call p2_switch with params {"x": <value.x + 2>, "z": <value.z>, "tolerance":0.8}.',
    'Call p2_status and report the active run. Do not call p2_stop until I ask.',
  ].join('\n'))
  const running = await waitFor(sessionId, text => /run=run-\d+:running/u.test(text), 'continuous running')
  console.log(`running=${JSON.stringify(running)}`)

  await prompt(sessionId, [
    'Call p2_status and note the current active runId.',
    'Call p2_stop with that runId.',
    'Then call p2_status and p2_events, and report whether the body is still active and lastRun.status.',
  ].join('\n'))
  const cancelled = await waitFor(sessionId, text => /last=run-\d+:cancelled/u.test(text) && /run=none:none/u.test(text), 'cancel')
  console.log(`cancelled=${JSON.stringify(cancelled)}`)

  operator.chat(`/fill ${wall.x} ${wall.y} ${wall.z} ${wall.x2} ${wall.y2} ${wall.z2} air`)
  await sleep(300)
  wall = undefined
  const bodyStop = await command(sessionId, '/p2 stop')
  console.log(`bodyStop=${JSON.stringify(bodyStop)}`)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sessionId,
    targetX,
    targetZ,
    blocked,
    recovered,
    running,
    cancelled,
    bodyStop,
  })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  process.exitCode = 1
} finally {
  if (wall !== undefined && operator !== undefined) {
    operator.chat(`/fill ${wall.x} ${wall.y} ${wall.z} ${wall.x2} ${wall.y2} ${wall.z2} air`)
    await sleep(300)
  }
  try { operator?.quit('failure probe complete') } catch {}
}
