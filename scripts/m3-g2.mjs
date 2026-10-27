#!/usr/bin/env node
/**
 * M3 G2 first pass: only look/move/jump/stop. No mining, placing, attacking,
 * using items, or world modification.
 *
 * Usage: node scripts/m3-g2.mjs [host] [port] [username]
 */
import { randomUUID } from 'node:crypto'
import mineflayer from 'mineflayer'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? '25575')
const username = process.argv[4] ?? 'P2_Bot'
const connectionEpoch = randomUUID()

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version: '1.21.1',
  hideErrors: false,
})

let settled = false
const finish = (code, value) => {
  if (settled) return
  settled = true
  process.stdout.write(`${JSON.stringify(value)}\n`)
  try { bot.clearControlStates() } catch {}
  try { bot.quit('g2 complete') } catch {}
  setTimeout(() => process.exit(code), 50)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const position = () => {
  const p = bot.entity?.position
  return p === undefined ? null : { x: p.x, y: p.y, z: p.z }
}
const delta = (before, after) => before === null || after === null
  ? null
  : { dx: after.x - before.x, dy: after.y - before.y, dz: after.z - before.z }

const timer = setTimeout(() => finish(1, {
  ok: false,
  error: 'G2 timeout',
  connectionEpoch,
}), 20_000)

bot.once('spawn', async () => {
  clearTimeout(timer)
  const results = { ok: true, connectionEpoch, steps: {} }
  try {
    await sleep(800)
    const before = position()
    results.steps.before = {
      position: before,
      onGround: bot.entity?.onGround ?? null,
      yaw: bot.entity?.yaw ?? null,
      pitch: bot.entity?.pitch ?? null,
    }

    await bot.look(Math.PI / 2, 0.2, true)
    await sleep(150)
    results.steps.look = {
      beforeYaw: results.steps.before.yaw,
      beforePitch: results.steps.before.pitch,
      yaw: bot.entity?.yaw ?? null,
      pitch: bot.entity?.pitch ?? null,
    }
    await bot.look(0, 0, true)
    await sleep(100)

    bot.setControlState('forward', true)
    await sleep(700)
    bot.setControlState('forward', false)
    await sleep(350)
    const afterMove = position()
    results.steps.move = {
      position: afterMove,
      delta: delta(before, afterMove),
      onGround: bot.entity?.onGround ?? null,
    }

    let maxY = afterMove?.y ?? null
    let minY = afterMove?.y ?? null
    let airborne = false
    let maxVelocityY = 0
    bot.setControlState('jump', true)
    for (let i = 0; i < 20; i += 1) {
      await sleep(25)
      const y = bot.entity?.position.y
      if (y !== undefined) {
        maxY = maxY === null ? y : Math.max(maxY, y)
        minY = minY === null ? y : Math.min(minY, y)
      }
      if (bot.entity?.onGround === false) airborne = true
      maxVelocityY = Math.max(maxVelocityY, bot.entity?.velocity?.y ?? 0)
    }
    bot.setControlState('jump', false)
    for (let i = 0; i < 40 && bot.entity?.onGround !== true; i += 1) await sleep(50)
    await sleep(100)
    const afterJump = position()
    results.steps.jump = {
      position: afterJump,
      delta: delta(afterMove, afterJump),
      maxY,
      minY,
      maxVelocityY,
      airborne,
      onGround: bot.entity?.onGround ?? null,
    }

    bot.setControlState('forward', true)
    await sleep(250)
    bot.clearControlStates()
    await sleep(150)
    const stoppedAt = position()
    await sleep(1000)
    const afterStop = position()
    await sleep(1000)
    const lateStop = position()
    results.steps.stop = {
      position: afterStop,
      delta: delta(stoppedAt, afterStop),
      latePosition: lateStop,
      lateDelta: delta(afterStop, lateStop),
      velocity: bot.entity?.velocity === undefined
        ? null
        : { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z },
      controls: {
        forward: bot.getControlState('forward'),
        back: bot.getControlState('back'),
        left: bot.getControlState('left'),
        right: bot.getControlState('right'),
        jump: bot.getControlState('jump'),
        sprint: bot.getControlState('sprint'),
        sneak: bot.getControlState('sneak'),
      },
    }
    results.health = bot.health
    results.food = bot.food
    results.players = Object.keys(bot.players)
    results.difficulty = bot.game?.difficulty ?? null
    results.timeOfDay = typeof bot.time?.timeOfDay === 'bigint'
      ? Number(bot.time.timeOfDay)
      : bot.time?.timeOfDay ?? null
    finish(0, results)
  } catch (error) {
    finish(1, {
      ok: false,
      connectionEpoch,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

bot.on('kicked', reason => {
  clearTimeout(timer)
  finish(1, { ok: false, error: `kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}` })
})

bot.on('error', error => {
  clearTimeout(timer)
  finish(1, { ok: false, error: error instanceof Error ? error.message : String(error) })
})

bot.on('end', reason => {
  if (!settled) {
    clearTimeout(timer)
    finish(1, { ok: false, error: `ended before G2 completion: ${reason ?? 'unknown'}` })
  }
})
