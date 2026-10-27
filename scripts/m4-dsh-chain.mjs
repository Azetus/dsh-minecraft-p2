#!/usr/bin/env node
/**
 * M4 DSH behavior chain in isolated dev:
 *   p2_check -> p2_activate -> p2_switch -> p2_status/p2_events -> p2_stop
 *
 * Requires an isolated dev server with credentials, a workspace `.p2/config.json`
 * and the `behaviors/` directory inside that workspace.
 *
 * Usage: node scripts/m4-dsh-chain.mjs <web-url-with-token> <workspace>
 */
import { randomUUID } from 'node:crypto'

const [rawUrl, workspace] = process.argv.slice(2)
if (rawUrl === undefined || workspace === undefined) {
  console.error('usage: node scripts/m4-dsh-chain.mjs <url> <workspace>')
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
    body: JSON.stringify({ type: 'client-request', rpcId: `m4-chain-${seq}`, method, payload: { args } }),
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
  request: {
    requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }],
  },
})
const runField = (text, name) => new RegExp(`${name}=([^ ]+)`, 'u').exec(text)?.[1]

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

try {
  const created = await rpc('session/create', { request: { cwd: workspace } })
  const sessionId = created.sessionId
  console.log(`session=${sessionId}`)
  console.log(`start=${JSON.stringify(await command(sessionId, '/p2 start'))}`)

  const behaviors = `${workspace}\\behaviors`
  await prompt(sessionId, [
    'You are testing the P2 Minecraft behavior tools in a controlled flat world.',
    'First call p2_observe with args {"op":"position"} and read value.x/value.z.',
    `Then call p2_check with sourcePath ${JSON.stringify(`${behaviors}\\approach-target.mjs`)}.`,
    'Then call p2_activate with the returned artifactId.',
    'Then call p2_switch with that artifactId and params {"x": <value.x + 2>, "z": <value.z>, "tolerance":0.8}.',
    'Use the current observed position for the arithmetic; do not use a fixed world coordinate.',
    'Then call p2_status once and report the active run.',
    'Do not call p2_stop yet. The behavior is finite and will finish by itself.',
  ].join('\n'))
  const finite = await waitFor(sessionId, text => /last=run-\d+:succeeded/u.test(text), 'finite success')
  console.log(`finite=${JSON.stringify(finite)}`)

  await prompt(sessionId, [
    'Call p2_events and then p2_status.',
    'Report the run events and the lastRun result; do not change the target.',
  ].join('\n'))
  await sleep(12_000)

  await prompt(sessionId, [
    'Now test the continuous behavior.',
    'First call p2_observe with args {"op":"position"} and read value.x/value.z.',
    `Call p2_check with sourcePath ${JSON.stringify(`${behaviors}\\hold-position.mjs`)}.`,
    'Call p2_activate with the returned artifactId.',
    'Call p2_switch with params {"x": <value.x + 2>, "z": <value.z>, "tolerance":0.8}.',
    'Call p2_status and report the active run.',
  ].join('\n'))
  const holdA = await waitFor(sessionId, text => /run=run-\d+:running/u.test(text), 'continuous run A')
  console.log(`holdA=${JSON.stringify(holdA)}`)

  await prompt(sessionId, [
    'Change the continuous behavior target using the same activated artifact from your last p2_check.',
    'Call p2_observe with args {"op":"position"} again and read value.x/value.z.',
    'Call p2_switch with params {"x": <value.x - 2>, "z": <value.z>, "tolerance":0.8}.',
    'Call p2_status and report the new run id. Do not call p2_stop yet.',
  ].join('\n'))
  const holdB = await waitFor(sessionId, text => /run=run-\d+:running/u.test(text) && text !== holdA, 'continuous run B')
  console.log(`holdB=${JSON.stringify(holdB)}`)

  await prompt(sessionId, [
    'Call p2_status and p2_events.',
    'Then call p2_stop with the current active runId.',
    'Then call p2_status again and report whether the body is still active and lastRun status.',
  ].join('\n'))
  const stopped = await waitFor(sessionId, text => /last=run-\d+:cancelled/u.test(text) && /run=none:none/u.test(text), 'continuous stop')
  console.log(`stopped=${JSON.stringify(stopped)}`)

  const finalEvents = await command(sessionId, '/p2 stop')
  console.log(`bodyStop=${JSON.stringify(finalEvents)}`)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sessionId,
    finite,
    holdA,
    holdB,
    stopped,
    bodyStop: finalEvents,
  })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  process.exitCode = 1
}
