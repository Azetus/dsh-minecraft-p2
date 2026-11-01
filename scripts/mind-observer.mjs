#!/usr/bin/env node
/**
 * Unattended observer: watch P2_Bot for a duration and report whether the
 * idle mind stayed alive and away from blocks.
 *
 * Usage: node scripts/mind-observer.mjs [port=25575] [seconds=600]
 *
 * The observer is a second player. It never sends commands or touches blocks.
 * Natural dirt -> grass spread is reported separately; only other changes count
 * as block violations.
 */
const root = new URL('..', import.meta.url)
const port = Number(process.argv[2] ?? 25575)
const durationMs = Math.max(10, Number(process.argv[3] ?? 600)) * 1000
const username = process.env.P2_OBSERVER_USERNAME ?? 'P2_Observer'

const provider = await import(new URL('lib/provider/minecraft.mjs', root).href)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const bot = await provider.connectMineflayer({
  host: '127.0.0.1',
  port,
  username,
  version: '1.21.1',
  timeoutMs: 20_000,
})
await sleep(2_000)

const Vec3 = bot.entity.position.constructor
const nameAt = (x, y, z) => {
  const block = bot.blockAt(new Vec3(x, y, z))
  return block === null ? null : block.name
}
const p2 = () => bot.players.P2_Bot?.entity

let target
for (let attempt = 0; attempt < 60 && target === undefined; attempt += 1) {
  target = p2()
  if (target === undefined) await sleep(500)
}
if (target === undefined) {
  console.log(JSON.stringify({ ok: false, error: 'P2_Bot is not visible' }, null, 2))
  bot.quit('observer done')
  process.exit(1)
}

const home = {
  x: Math.floor(target.position.x),
  y: Math.floor(target.position.y),
  z: Math.floor(target.position.z),
}
const baseline = new Map()
for (let x = home.x - 16; x <= home.x + 16; x += 1) {
  for (let z = home.z - 16; z <= home.z + 16; z += 1) {
    for (let y = home.y - 4; y <= home.y + 4; y += 1) {
      const name = nameAt(x, y, z)
      if (name !== null) baseline.set(`${x},${y},${z}`, name)
    }
  }
}

const startedAt = Date.now()
let lastPos = { x: target.position.x, z: target.position.z }
let lastMoveAt = startedAt
let maxGapMs = 0
let maxRadius = 0
let pathLength = 0
let missing = 0

for (let elapsed = 0; elapsed <= durationMs; elapsed += 5_000) {
  const entity = p2()
  if (entity === undefined) {
    missing += 1
  } else {
    const position = entity.position
    const moved = Math.hypot(position.x - lastPos.x, position.z - lastPos.z)
    const now = Date.now()
    if (moved > 0.3) {
      pathLength += moved
      lastMoveAt = now
      lastPos = { x: position.x, z: position.z }
    }
    maxGapMs = Math.max(maxGapMs, now - lastMoveAt)
    maxRadius = Math.max(maxRadius, Math.hypot(position.x - home.x, position.z - home.z))
  }
  if (elapsed < durationMs) await sleep(5_000)
}

const changed = []
let unknown = 0
for (const [key, name] of baseline) {
  const [x, y, z] = key.split(',').map(Number)
  const now = nameAt(x, y, z)
  if (now === null) { unknown += 1; continue }
  if (now !== name) changed.push({ pos: key, from: name, to: now })
}
const natural = changed.filter(entry => entry.from === 'dirt' && entry.to === 'grass_block')
const violations = changed.filter(entry => !(entry.from === 'dirt' && entry.to === 'grass_block'))

const result = {
  ok: missing === 0 && violations.length === 0 && maxRadius <= 12 && maxGapMs <= 60_000,
  port,
  durationMs,
  home,
  missingSamples: missing,
  maxRadius: Number(maxRadius.toFixed(2)),
  pathLength: Number(pathLength.toFixed(2)),
  maxGapMs,
  naturalChanges: natural.length,
  blockViolations: violations.length,
  violationSample: violations.slice(0, 10),
  unknownBaselineBlocks: unknown,
}
console.log(JSON.stringify(result, null, 2))
bot.quit('observer done')
await sleep(800)
process.exit(result.ok ? 0 : 1)
