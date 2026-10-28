#!/usr/bin/env node
/**
 * M5.5 baseline smoke for the shared op/act layer.
 * Requires Minecraft LAN on 127.0.0.1:25575 with an opped P2_Operator.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import mineflayer from 'mineflayer'

const WORKSPACE = process.cwd()
const HOST = '127.0.0.1'
const PORT = 25575
const VERSION = '1.21.1'
const FORMAT = process.env.SMOKE_FORMAT === 'js' ? 'js' : 'ir'
const SMOKE_DIR = join(WORKSPACE, '.m5-smoke')
const RUNS_DIR = join(WORKSPACE, '.m5-runs')
mkdirSync(SMOKE_DIR, { recursive: true })
mkdirSync(RUNS_DIR, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class Body {
  constructor() {
    this.child = spawn(process.execPath, [join(WORKSPACE, 'lib', 'body', 'body.mjs')], {
      cwd: WORKSPACE,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.pending = new Map()
    this.epoch = undefined
    this.logs = []
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => this.onLine(line))
    createInterface({ input: this.child.stderr, crlfDelay: Infinity }).on('line', line => this.logs.push(line))
    this.child.once('exit', code => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error(`body exited with ${code}`))
      }
      this.pending.clear()
    })
  }

  onLine(line) {
    if (line.trim() === '') return
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.requestId === undefined) return
    const pending = this.pending.get(message.requestId)
    if (pending === undefined) return
    this.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.error !== undefined) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, error: message.error }))
    else pending.resolve(message.result)
  }

  request(method, params, options = {}) {
    const requestId = `smoke-${randomUUID()}`
    const envelope = { protocol: 1, requestId, method, params }
    if (this.epoch !== undefined) envelope.bodyEpoch = this.epoch
    if (options.commandId !== undefined) envelope.commandId = options.commandId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`${method} timed out`))
      }, options.timeoutMs ?? 30_000)
      this.pending.set(requestId, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify(envelope)}\n`)
    })
  }

  async hello() {
    const result = await this.request('hello', {
      protocols: [1],
      owner: { sessionId: 'baseline-smoke', agentId: 'harness', cwd: WORKSPACE },
    })
    this.epoch = result.bodyEpoch
    this.heartbeat = setInterval(() => {
      this.request('heartbeat', { seq: Date.now() }).catch(() => {})
    }, 2000)
    return result
  }

  close() {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      this.child.stdin.write(`${JSON.stringify({ protocol: 1, requestId: `smoke-${randomUUID()}`, method: 'shutdown', bodyEpoch: this.epoch, commandId: `shutdown-${Date.now()}`, params: {} })}\n`)
    } catch {}
    setTimeout(() => { try { this.child.kill() } catch {} }, 500)
  }
}

async function connectBot(name) {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: name, auth: 'offline', version: VERSION })
  bot.chatLog = []
  bot.on('messagestr', message => bot.chatLog.push(message))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} spawn timeout`)), 20_000)
    bot.once('spawn', () => { clearTimeout(timer); resolve() })
    bot.once('error', error => { clearTimeout(timer); reject(error) })
  })
  return bot
}

async function command(bot, line, waitMs = 250) {
  bot.chat(line.startsWith('/') ? line : `/${line}`)
  await sleep(waitMs)
}

async function waitFor(fn, label, timeoutMs = 30_000, interval = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await sleep(interval)
  }
  throw new Error(`${label} timed out`)
}

function behaviorIR(id, root, parameters, locals, completion) {
  return {
    id,
    description: `smoke ${id}`,
    mode: completion === undefined ? 'continuous' : 'finite',
    parameters,
    locals,
    root,
    ...(completion === undefined ? {} : { completion }),
  }
}

function doneCompletion() {
  return { kind: 'predicate', condition: { kind: 'expr', expr: { kind: 'local', name: 'done' } } }
}

function actNode(id, definitionId, args) {
  return { kind: 'act', id, act: { definitionId }, args }
}

function writeBehaviors() {
  if (FORMAT === 'js') {
    const sources = {
      'smoke-move': `defineBehavior({
  manifest: { id: 'smoke-move', mode: 'finite', parameters: { x: { type: 'number', required: true }, z: { type: 'number', required: true } } },
  *run(ctx) {
    yield ctx.act('move-to', { x: ctx.params.x, z: ctx.params.z, timeoutMs: 8000 })
    return ctx.succeed({ done: true })
  },
})`,
      'smoke-mine': `defineBehavior({
  manifest: { id: 'smoke-mine', mode: 'finite', parameters: { pos: { type: 'json', required: true } } },
  *run(ctx) {
    yield ctx.act('mine-one', { pos: ctx.params.pos })
    return ctx.succeed({ done: true })
  },
})`,
      'smoke-place': `defineBehavior({
  manifest: { id: 'smoke-place', mode: 'finite', parameters: { pos: { type: 'json', required: true }, item: { type: 'string', required: true } } },
  *run(ctx) {
    yield ctx.act('place-block', { pos: ctx.params.pos, item: ctx.params.item })
    return ctx.succeed({ done: true })
  },
})`,
      'smoke-attack': `defineBehavior({
  manifest: { id: 'smoke-attack', mode: 'finite', parameters: { entityId: { type: 'number', required: true } } },
  *run(ctx) {
    yield ctx.act('attack-one', { entityId: ctx.params.entityId })
    return ctx.succeed({ done: true })
  },
})`,
      'smoke-equip': `defineBehavior({
  manifest: { id: 'smoke-equip', mode: 'finite', parameters: { item: { type: 'string', required: true } } },
  *run(ctx) {
    yield ctx.act('equip-item', { item: ctx.params.item, destination: 'hand' })
    return ctx.succeed({ done: true })
  },
})`,
      'smoke-use': `defineBehavior({
  manifest: { id: 'smoke-use', mode: 'finite', parameters: { durationMs: { type: 'number', required: true } } },
  *run(ctx) {
    yield ctx.act('use-item', { durationMs: ctx.params.durationMs })
    return ctx.succeed({ done: true })
  },
})`,
      'smoke-patrol': `defineBehavior({
  manifest: { id: 'smoke-patrol', mode: 'continuous', parameters: { x1: { type: 'number', required: true }, z1: { type: 'number', required: true }, x2: { type: 'number', required: true }, z2: { type: 'number', required: true } } },
  *run(ctx) {
    while (true) {
      yield ctx.act('move-to', { x: ctx.params.x1, z: ctx.params.z1, timeoutMs: 8000 })
      yield ctx.wait(200)
      yield ctx.act('move-to', { x: ctx.params.x2, z: ctx.params.z2, timeoutMs: 8000 })
      yield ctx.wait(200)
    }
  },
})`,
    }
    for (const [name, code] of Object.entries(sources)) {
      writeFileSync(join(SMOKE_DIR, `${name}.mjs`), `${code}\n`)
    }
    return Object.fromEntries(Object.keys(sources).map(name => [name, true]))
  }
  const done = { done: { type: 'boolean', initial: false } }
  const behaviors = {
    'smoke-move': behaviorIR('smoke-move', {
      kind: 'sequence', id: 'root', children: [
        actNode('move', 'move-to', { x: { kind: 'param', name: 'x' }, z: { kind: 'param', name: 'z' }, timeoutMs: { kind: 'literal', value: 8000 } }),
        { kind: 'assign', id: 'done', target: 'done', value: { kind: 'literal', value: true } },
      ],
    }, { x: { type: 'number', required: true }, z: { type: 'number', required: true } }, done, doneCompletion()),
    'smoke-mine': behaviorIR('smoke-mine', {
      kind: 'sequence', id: 'root', children: [
        actNode('mine', 'mine-one', { pos: { kind: 'param', name: 'pos' } }),
        { kind: 'assign', id: 'done', target: 'done', value: { kind: 'literal', value: true } },
      ],
    }, { pos: { type: 'json', required: true } }, done, doneCompletion()),
    'smoke-place': behaviorIR('smoke-place', {
      kind: 'sequence', id: 'root', children: [
        actNode('place', 'place-block', { pos: { kind: 'param', name: 'pos' }, item: { kind: 'param', name: 'item' } }),
        { kind: 'assign', id: 'done', target: 'done', value: { kind: 'literal', value: true } },
      ],
    }, { pos: { type: 'json', required: true }, item: { type: 'string', required: true } }, done, doneCompletion()),
    'smoke-attack': behaviorIR('smoke-attack', {
      kind: 'sequence', id: 'root', children: [
        actNode('attack', 'attack-one', { entityId: { kind: 'param', name: 'entityId' } }),
        { kind: 'assign', id: 'done', target: 'done', value: { kind: 'literal', value: true } },
      ],
    }, { entityId: { type: 'number', required: true } }, done, doneCompletion()),
    'smoke-equip': behaviorIR('smoke-equip', {
      kind: 'sequence', id: 'root', children: [
        actNode('equip', 'equip-item', { item: { kind: 'param', name: 'item' }, destination: { kind: 'literal', value: 'hand' } }),
        { kind: 'assign', id: 'done', target: 'done', value: { kind: 'literal', value: true } },
      ],
    }, { item: { type: 'string', required: true } }, done, doneCompletion()),
    'smoke-use': behaviorIR('smoke-use', {
      kind: 'sequence', id: 'root', children: [
        actNode('use', 'use-item', { durationMs: { kind: 'param', name: 'durationMs' } }),
        { kind: 'assign', id: 'done', target: 'done', value: { kind: 'literal', value: true } },
      ],
    }, { durationMs: { type: 'number', required: true } }, done, doneCompletion()),
    'smoke-patrol': behaviorIR('smoke-patrol', {
      kind: 'repeat', id: 'loop', child: {
        kind: 'sequence', id: 'leg', children: [
          actNode('to-a', 'move-to', { x: { kind: 'param', name: 'x1' }, z: { kind: 'param', name: 'z1' }, timeoutMs: { kind: 'literal', value: 8000 } }),
          { kind: 'wait', id: 'wait-a', durationMs: 200 },
          actNode('to-b', 'move-to', { x: { kind: 'param', name: 'x2' }, z: { kind: 'param', name: 'z2' }, timeoutMs: { kind: 'literal', value: 8000 } }),
          { kind: 'wait', id: 'wait-b', durationMs: 200 },
        ],
      },
    }, { x1: { type: 'number', required: true }, z1: { type: 'number', required: true }, x2: { type: 'number', required: true }, z2: { type: 'number', required: true } }, {}),
  }
  for (const [name, definition] of Object.entries(behaviors)) {
    writeFileSync(join(SMOKE_DIR, `${name}.mjs`), `export default ${JSON.stringify(definition, null, 2)}\n`)
  }
  return behaviors
}

const results = []
function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${ok ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

async function main() {
  const operator = await connectBot('P2_Operator')
  const body = new Body()
  const evidence = { startedAt: new Date().toISOString(), format: FORMAT, checks: results, queries: {}, runs: {}, errors: [] }
  let base
  try {
    const hello = await body.hello()
    evidence.hello = hello
    await waitFor(() => (operator.players.P2_Bot === undefined ? undefined : true), 'P2_Bot online', 20_000)
    await command(operator, 'time set day', 150)
    await command(operator, 'gamerule doDaylightCycle false', 150)
    await command(operator, 'gamerule doMobSpawning false', 150)
    await command(operator, 'difficulty peaceful', 150)
    await command(operator, 'clear P2_Bot', 200)
    await command(operator, 'kill @e[type=minecraft:cow]', 150)
    await command(operator, 'tp P2_Bot 110 100 110', 400)
    const position = (await body.request('observe', { op: 'position', args: {} })).value
    base = { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) }
    evidence.queries.position = position
    record('A1', 'position query', typeof position.x === 'number' && typeof position.dimension === 'string', position)

    for (const op of ['inventory', 'health', 'time']) {
      const result = await body.request('observe', { op, args: {} })
      evidence.queries[op] = result.value
      record('A2', `${op} query`, result.value !== undefined && result.meta?.validUntil !== undefined, result)
    }
    const below = (await body.request('observe', { op: 'block', args: { x: base.x, y: base.y - 1, z: base.z } })).value
    evidence.queries.block = below
    record('A3', 'block query', below !== null && typeof below.name === 'string', below)
    const blocks = await body.request('observe', { op: 'blocks', args: { names: ['stone', 'dirt'], radius: 8, count: 8 } })
    evidence.queries.blocks = blocks.value
    record('A4', 'blocks query', Array.isArray(blocks.value) && blocks.value.length > 0, blocks.value)

    const acts = ['move-to', 'mine-one', 'stop', 'place-block', 'attack-one', 'equip-item', 'use-item']
    const actIds = {}
    for (const name of acts) {
      const checked = await body.request('check', { sourcePath: join(WORKSPACE, 'acts', `${name}.mjs`), artifactKind: 'act' }, { commandId: `check-${name}` })
      await body.request('activate', { artifactId: checked.artifactId }, { commandId: `activate-${name}` })
      actIds[name] = checked.artifactId
    }
    record('B1', 'check and activate baseline acts', Object.keys(actIds).length === acts.length, actIds)

    const policy = await body.request('check', { sourcePath: join(WORKSPACE, 'policies', 'item-count.mjs'), artifactKind: 'policy' }, { commandId: 'check-policy' })
    let policyRejected = false
    try { await body.request('activate', { artifactId: policy.artifactId }, { commandId: 'activate-policy' }) } catch { policyRejected = true }
    record('B2', 'policy is not activatable', policyRejected, null)

    const behaviorFiles = writeBehaviors()
    const behaviorIds = {}
    for (const name of Object.keys(behaviorFiles)) {
      const checked = await body.request('check', { sourcePath: join(SMOKE_DIR, `${name}.mjs`), artifactKind: 'behavior', ...(FORMAT === 'js' ? { format: 'js' } : {}) }, { commandId: `check-${name}` })
      await body.request('activate', { artifactId: checked.artifactId }, { commandId: `activate-${name}` })
      behaviorIds[name] = checked.artifactId
    }
    record(`B3`, `check smoke behaviors (${FORMAT})`, Object.keys(behaviorIds).length === Object.keys(behaviorFiles).length, behaviorIds)

    const run = async (name, params, timeoutMs = 20_000) => {
      const switched = await body.request('switch', { artifactId: behaviorIds[name], params }, { commandId: `switch-${name}-${Date.now()}` })
      if (!switched.accepted || switched.runId === null) throw new Error(`switch rejected: ${JSON.stringify(switched)}`)
      const runId = switched.runId
      let lastStatus
      try {
        const final = await waitFor(async () => {
          const status = await body.request('status', {})
          lastStatus = status
          if (status.lastRun?.runId === runId) return status.lastRun
          return undefined
        }, `${name} terminal`, timeoutMs)
        evidence.runs[name] = { runId, final }
        return final
      } catch (error) {
        evidence.runs[name] = { runId, lastStatus }
        console.error(`SMOKE RUN ${name} status: ${JSON.stringify(lastStatus)}`)
        throw error
      }
    }

    const move = await run('smoke-move', { x: base.x + 3, z: base.z })
    const movedPos = (await body.request('observe', { op: 'position', args: {} })).value
    record('C1', 'move-to success', move.status === 'succeeded' && Math.hypot(movedPos.x - (base.x + 3), movedPos.z - base.z) < 1.2, { move, movedPos })

    await command(operator, `setblock ${base.x + 2} ${base.y} ${base.z} minecraft:dirt`, 200)
    const mine = await run('smoke-mine', { pos: { x: base.x + 2, y: base.y, z: base.z } })
    const minedBlock = (await body.request('observe', { op: 'block', args: { x: base.x + 2, y: base.y, z: base.z } })).value
    record('C2', 'mine-one success', mine.status === 'succeeded' && (minedBlock === null || minedBlock.name === 'air'), { mine, minedBlock })

    await command(operator, 'give P2_Bot minecraft:dirt 16', 200)
    const placePos = { x: base.x + 2, y: base.y, z: base.z + 2 }
    const place = await run('smoke-place', { pos: placePos, item: 'dirt' })
    const placedBlock = (await body.request('observe', { op: 'block', args: placePos })).value
    record('C3', 'place-block success', place.status === 'succeeded' && placedBlock?.name === 'dirt', { place, placedBlock })

    await command(operator, `summon minecraft:cow ${base.x + 3} ${base.y} ${base.z} {NoAI:1b}`, 300)
    const cows = (await body.request('observe', { op: 'entities', args: { name: 'cow' } })).value
    const cow = cows.find(entity => entity.position !== null)
    const attack = cow === undefined ? { status: 'missing-cow' } : await run('smoke-attack', { entityId: cow.id })
    record('C4', 'attack-one success', attack.status === 'succeeded', { cow: cow === undefined ? null : cow.id, attack })

    await command(operator, 'give P2_Bot minecraft:stone_sword 1', 200)
    const equip = await run('smoke-equip', { item: 'stone_sword' })
    record('C5', 'equip-item success', equip.status === 'succeeded', equip)

    await command(operator, 'give P2_Bot minecraft:bread 2', 200)
    const equipBread = await run('smoke-equip', { item: 'bread' })
    const use = await run('smoke-use', { durationMs: 600 })
    record('C6', 'use-item success', equipBread.status === 'succeeded' && use.status === 'succeeded', { equipBread, use })

    await command(operator, `fill ${base.x + 5} ${base.y} ${base.z - 2} ${base.x + 5} ${base.y + 2} ${base.z + 2} minecraft:barrier`, 250)
    const blocked = await run('smoke-move', { x: base.x + 8, z: base.z }, 20_000)
    await command(operator, `fill ${base.x + 5} ${base.y} ${base.z - 2} ${base.x + 5} ${base.y + 2} ${base.z + 2} minecraft:air`, 250)
    const recovered = await run('smoke-move', { x: base.x + 6, z: base.z }, 20_000)
    record('C7', 'move-to blocked then recover', blocked.status === 'failed' && blocked.error?.code === 'MOVE_TO_BLOCKED' && recovered.status === 'succeeded', { blocked, recovered })

    const patrol = await body.request('switch', {
      artifactId: behaviorIds['smoke-patrol'],
      params: { x1: base.x + 2, z1: base.z, x2: base.x + 6, z2: base.z },
    }, { commandId: `switch-patrol-${Date.now()}` })
    await sleep(1500)
    await body.request('behavior.stop', { runId: patrol.runId }, { commandId: `stop-patrol-${Date.now()}` })
    const patrolFinal = await waitFor(async () => {
      const status = await body.request('status', {})
      return status.lastRun?.runId === patrol.runId ? status.lastRun : undefined
    }, 'patrol cancel', 20_000)
    record('D1', 'cancel running patrol', patrolFinal.status === 'cancelled', patrolFinal)

    const long = await body.request('switch', {
      artifactId: behaviorIds['smoke-patrol'],
      params: { x1: base.x + 2, z1: base.z, x2: base.x + 6, z2: base.z },
    }, { commandId: `switch-long-${Date.now()}` })
    await sleep(60_000)
    const longStatus = await body.request('status', {})
    await body.request('behavior.stop', { runId: long.runId }, { commandId: `stop-long-${Date.now()}` })
    const longFinal = await waitFor(async () => {
      const status = await body.request('status', {})
      return status.lastRun?.runId === long.runId ? status.lastRun : undefined
    }, 'long cancel', 20_000)
    record('F1', 'long patrol 60s then cancel', longStatus.activeRun?.runId === long.runId && longFinal.status === 'cancelled', { longStatus: longStatus.activeRun, longFinal })

    let missingRejected = false
    try {
      const missing = await body.request('switch', { artifactId: behaviorIds['smoke-move'], params: {} }, { commandId: 'missing-param' })
      missingRejected = missing.accepted === false
    } catch { missingRejected = true }
    record('B4', 'switch rejects missing required param', missingRejected, null)
  } catch (error) {
    evidence.errors.push(error instanceof Error ? error.message : String(error))
    console.error(`SMOKE ERROR: ${error instanceof Error ? error.message : String(error)}`)
    if (body.logs.length > 0) console.error(body.logs.slice(-20).join('\n'))
  } finally {
    try { await command(operator, 'kill @e[type=minecraft:cow]', 150) } catch {}
    try { await command(operator, 'clear P2_Bot', 150) } catch {}
    try { await command(operator, `fill ${base?.x ?? 100} ${base?.y ?? 100} ${base?.z ?? 100} ${(base?.x ?? 100) + 9} ${(base?.y ?? 100) + 3} ${(base?.z ?? 100) + 9} minecraft:air`, 200) } catch {}
    body.close()
    try { operator.quit('smoke done') } catch {}
  }
  evidence.finishedAt = new Date().toISOString()
  evidence.ok = results.every(entry => entry.ok) && evidence.errors.length === 0
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const path = join(RUNS_DIR, `baseline-smoke-${stamp}.json`)
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`evidence: ${path}`)
  console.log(`SMOKE ${evidence.ok ? 'PASS' : 'FAIL'} (${results.filter(entry => entry.ok).length}/${results.length})`)
  process.exitCode = evidence.ok ? 0 : 1
}

await main()
