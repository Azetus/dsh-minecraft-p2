#!/usr/bin/env node
/**
 * M3 DSH-tool stop test in the isolated dev profile.
 *
 * Usage: node scripts/m3-dsh-tool-stop.mjs <web-url-with-token> <workspace> <sourcePath>
 *
 * It creates a session, runs `/p2 start` as a recorded command, then asks the
 * agent to call p2_check/p2_activate/p2_switch, waits for an active run, asks
 * it to call p2_stop, and verifies the body remains active with activeRun null.
 */
import { randomUUID } from 'node:crypto'

const [rawUrl, workspace, sourcePath] = process.argv.slice(2)
if (rawUrl === undefined || workspace === undefined || sourcePath === undefined) {
  console.error('usage: node scripts/m3-dsh-tool-stop.mjs <url> <workspace> <sourcePath>')
  process.exit(2)
}

const url = new URL(rawUrl)
const origin = url.origin
const token = url.searchParams.get('token')
if (token === null) throw new Error('URL lacks launch token')

const auth = await fetch(url, { redirect: 'manual' })
const setCookie = auth.headers.getSetCookie?.() ?? []
const rawCookie = setCookie[0] ?? auth.headers.get('set-cookie')
if (rawCookie === null || rawCookie === undefined) throw new Error(`auth failed: HTTP ${auth.status}`)
const cookie = rawCookie.split(';', 1)[0]

let rpcSeq = 0
async function rpc(method, args) {
  rpcSeq += 1
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `m3-tool-${rpcSeq}`,
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const statusText = async sessionId => (await command(sessionId, '/p2 status')).text
const runIdOf = text => /run=([^: ]+):running/u.exec(text)?.[1]

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last.ok) return last
    await sleep(1000)
  }
  throw new Error(`${label} timeout; last=${JSON.stringify(last)}`)
}

try {
  const created = await rpc('session/create', { request: { cwd: workspace } })
  const sessionId = created.sessionId
  console.log(`session: ${sessionId}`)

  const started = await command(sessionId, '/p2 start')
  console.log(`/p2 start: ${JSON.stringify(started)}`)
  if (started.kind !== 'success') throw new Error('p2 start failed')

  const firstPrompt = [
    'You are testing the P2 Minecraft tools in a controlled test world.',
    `First call p2_check with sourcePath ${JSON.stringify(sourcePath)}.`,
    'Then call p2_activate with the returned artifactId.',
    'Then call p2_switch with that artifactId and params {}.',
    'Do not call p2_stop yet. Reply with the runId and a one-line result.',
  ].join('\n')
  await rpc('session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: firstPrompt }],
    },
  })

  const active = await waitFor(async () => {
    const text = await statusText(sessionId)
    const runId = runIdOf(text)
    return { ok: runId !== undefined, text, runId }
  }, 90_000, 'active run')
  console.log(`active: ${JSON.stringify(active)}`)

  const secondPrompt = [
    `Call p2_stop with runId ${JSON.stringify(active.runId)}.`,
    'Then call p2_status and report whether the body is still active.',
    'Do not claim task completion; this is only a stop test.',
  ].join('\n')
  await rpc('session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: secondPrompt }],
    },
  })

  const stopped = await waitFor(async () => {
    const text = await statusText(sessionId)
    return { ok: /P2 body active .*run=none:none/u.test(text), text }
  }, 90_000, 'inactive run')
  console.log(`stopped: ${JSON.stringify(stopped)}`)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sessionId,
    active: active.text,
    stopped: stopped.text,
  })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  process.exitCode = 1
}
