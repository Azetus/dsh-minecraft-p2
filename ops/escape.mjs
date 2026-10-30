/**
 * escape: emergency locomotion. One control op, mode-driven, short lived.
 *
 * The op only moves the existing body: no teleport, no item, no command. It
 * reports `cleared` from a fresh read-back (oxygen/water/lava/entity distance).
 */
defineOp({
  manifest: {
    schemaVersion: 1,
    kind: 'op',
    name: 'escape',
    opKind: 'control',
    effects: 'active',
    stop: 'poll',
    capabilities: [],
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string' } },
      required: ['mode'],
    },
    limits: { totalMs: 20000 },
  },
  start: function (ctx, args) {
    const host = ctx.host
    const log = m => { try { ctx.log('[escape] ' + String(m)) } catch (e) { /* ignore */ } }
    const mode = args && typeof args.mode === 'string' ? args.mode : ''
    if (!host || !host.bot) {
      let out = { status: 'failed', error: { code: 'OP_HOST_UNAVAILABLE', category: 'capability', message: 'escape requires the live-connection bridge' } }
      return { poll: () => out, stop: () => {} }
    }
    const bot = host.bot
    const Vec3 = host.Vec3 || bot.entity.position.constructor
    const startedAt = Date.now()
    let stopped = false
    let outcome = { status: 'running' }
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const feet = () => { const p = bot.entity.position; return { x: p.x, y: p.y, z: p.z } }
    const entity = () => bot.entity || {}
    const oxygen = () => (typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : null)
    const inWater = () => entity().isInWater === true
    const inLava = () => entity().isInLava === true
    function nearestHostile() {
      const own = feet()
      let best = null
      let bestD = 1e9
      for (const id of Object.keys(bot.entities)) {
        const candidate = bot.entities[id]
        if (!candidate || candidate === bot.entity || !candidate.position) continue
        if (candidate.kind !== 'Hostile mobs') continue
        const d = Math.hypot(candidate.position.x - own.x, candidate.position.y - own.y, candidate.position.z - own.z)
        if (d < bestD) { bestD = d; best = candidate }
      }
      return best === null ? null : { entity: best, distance: bestD }
    }
    async function swimUp() {
      // Hold jump to float and push toward the surface; look straight up.
      try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch (e) { /* ignore */ }
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
      const began = Date.now()
      while (Date.now() - began < 7000 && !stopped) {
        if (!inWater() && oxygen() !== null && oxygen() >= 250) break
        if (!inWater() && !inLava()) {
          // out of the fluid; try to step onto the nearest land
          const p = feet()
          try { await bot.lookAt(new Vec3(p.x + 2, p.y + 0.5, p.z), true) } catch (e) { /* ignore */ }
          bot.setControlState('forward', true)
        }
        await sleep(150)
      }
      bot.setControlState('jump', false)
      bot.setControlState('sprint', false)
      bot.setControlState('forward', false)
    }
    async function leaveLava() {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
      const began = Date.now()
      while (Date.now() - began < 5000 && !stopped && inLava()) {
        const p = feet()
        try { await bot.lookAt(new Vec3(p.x + 2, p.y + 1, p.z), true) } catch (e) { /* ignore */ }
        bot.setControlState('forward', true)
        await sleep(150)
      }
      bot.setControlState('jump', false)
      bot.setControlState('sprint', false)
      bot.setControlState('forward', false)
    }
    async function flee() {
      const hostile = nearestHostile()
      if (hostile === null) return
      const own = feet()
      const away = {
        x: own.x - hostile.entity.position.x,
        z: own.z - hostile.entity.position.z,
      }
      const length = Math.hypot(away.x, away.z) || 1
      const dx = away.x / length
      const dz = away.z / length
      bot.setControlState('sprint', true)
      bot.setControlState('jump', true)
      const began = Date.now()
      while (Date.now() - began < 4000 && !stopped) {
        const p = feet()
        try { await bot.lookAt(new Vec3(p.x + dx * 3, p.y + 0.3, p.z + dz * 3), true) } catch (e) { /* ignore */ }
        bot.setControlState('forward', true)
        const now = nearestHostile()
        if (now === null || now.distance > 12) break
        await sleep(150)
      }
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
      bot.setControlState('jump', false)
    }
    async function run() {
      if (mode === 'water') await swimUp()
      else if (mode === 'lava') await leaveLava()
      else if (mode === 'hostile') await flee()
      else throw Object.assign(new Error('unknown escape mode: ' + mode), { code: 'BAD_ARGS' })
      await sleep(200)
      const hostile = nearestHostile()
      const result = {
        mode: mode,
        cleared: mode === 'water' ? !inWater() || oxygen() === null || oxygen() >= 200
          : mode === 'lava' ? !inLava()
            : hostile === null || hostile.distance > 8,
        position: feet(),
        oxygen: oxygen(),
        inWater: inWater(),
        inLava: inLava(),
        health: bot.health === undefined ? null : bot.health,
        nearestHostile: hostile === null ? null : Math.round(hostile.distance),
        durationMs: Date.now() - startedAt,
      }
      log(JSON.stringify(result))
      return result
    }
    run().then(result => {
      outcome = { status: 'succeeded', result: result }
    }).catch(error => {
      outcome = {
        status: 'failed',
        error: {
          code: error && error.code ? String(error.code) : 'ESCAPE_FAILED',
          category: 'runtime',
          message: error && error.message ? String(error.message) : String(error),
        },
      }
    })
    return {
      poll: () => outcome,
      stop: () => {
        stopped = true
        try { bot.clearControlStates() } catch (e) { /* ignore */ }
      },
    }
  },
})
