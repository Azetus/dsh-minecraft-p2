/**
 * campaign: the long-run survival content driver.
 *
 * One control op with a `stage` argument. Each stage is idempotent: it first
 * inspects the live world/inventory, then only performs the missing work. The
 * op drives the live Mineflayer connection directly (trusted developer content)
 * and returns the raw observation evidence used by the acceptance verifier.
 *
 * Stages:
 *   shelter  - wood, crafting table, wooden pickaxe, dug 3x3x2 room with door
 *              and torch, table moved inside; records `bot.__p2.camp`
 *   bed      - 3 wool from sheep, bed inside the room, sleep, then a real
 *              death+respawn read-back proving the bed is the spawn point
 *   tools    - three stone tools crafted at the table
 *   copper   - locate and mine a copper ore, read back the block and drops
 *   smelt    - furnace + fuel + raw copper -> copper ingot, read back
 */
defineOp({
  manifest: {
    schemaVersion: 1,
    kind: 'op',
    name: 'campaign',
    opKind: 'control',
    effects: 'active',
    stop: 'poll',
    capabilities: [],
    parameters: {
      type: 'object',
      properties: { stage: { type: 'string' } },
      required: ['stage'],
    },
    limits: { totalMs: 1800000 },
  },
  start: function (ctx, args) {
    const host = ctx.host
    const log = m => {
      const text = '[campaign] ' + String(m)
      try { ctx.log(text) } catch (e) { /* logging is best effort */ }
      try { if (host && host.debug) host.debug(text) } catch (e) { /* ignore */ }
    }
    const fail = (code, message, detail) => {
      const error = new Error(message)
      error.code = code
      error.category = 'runtime'
      if (detail !== undefined) error.details = detail
      return error
    }
    if (!host || !host.bot) {
      let hostOutcome = { status: 'failed', error: { code: 'OP_HOST_UNAVAILABLE', category: 'capability', message: 'campaign requires the live-connection bridge' } }
      return { poll: () => hostOutcome, stop: () => {} }
    }
    const bot = host.bot
    const Vec3 = host.Vec3 || bot.entity.position.constructor
    const state = (bot.__p2 = bot.__p2 || {})
    const stage = args && typeof args.stage === 'string' ? args.stage : ''
    const startedAt = Date.now()
    const evidence = { stage: stage, startedAt: startedAt, steps: [], events: [] }
    let stopped = false
    let outcome = { status: 'running' }

    const note = (step, detail) => {
      const entry = { at: Date.now(), step: step }
      if (detail !== undefined) entry.detail = detail
      evidence.steps.push(entry)
      if (evidence.steps.length > 200) evidence.steps.shift()
      log(step + (detail === undefined ? '' : ' ' + JSON.stringify(detail)))
    }
    const event = (kind, detail) => {
      evidence.events.push({ at: Date.now(), kind: kind, detail: detail === undefined ? null : detail })
      log('event ' + kind + ' ' + JSON.stringify(detail === undefined ? null : detail))
    }
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    function guard(promise, ms, code) {
      return Promise.race([
        promise,
        sleep(ms).then(() => { throw fail(code || 'STALLED', 'operation exceeded ' + ms + 'ms') }),
      ])
    }
    const checkStop = () => { if (stopped) throw fail('OP_CANCELLED', 'campaign was stopped') }
    const now = () => Date.now()

    // ---------------------------------------------------------------- geometry
    function feet() { const p = bot.entity.position; return { x: p.x, y: p.y, z: p.z } }
    function cell() { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }
    function at(x, y, z) { const b = bot.blockAt(new Vec3(x, y, z)); return b === null || b === undefined ? null : b }
    function nameAt(x, y, z) { const b = at(x, y, z); return b === null ? null : b.name }
    const AIR = { air: 1, cave_air: 1, void_air: 1 }
    const FLUID = { water: 1, lava: 1, flowing_water: 1, flowing_lava: 1, bubble_column: 1 }
    const isAir = n => n !== null && AIR[n] === 1
    const isFluid = n => n !== null && FLUID[n] === 1
    const isSolid = n => n !== null && !isAir(n) && !isFluid(n)
    function logNames() {
      const names = []
      for (const key of Object.keys(bot.registry.blocksByName)) {
        if (/(_log|_stem|_wood|_hyphae)$/.test(key)) names.push(key)
      }
      return names
    }
    function logIds() {
      const ids = []
      for (const name of logNames()) {
        const def = bot.registry.blocksByName[name]
        if (def && typeof def.id === 'number') ids.push(def.id)
      }
      return ids
    }

    // ---------------------------------------------------------------- movement
    let movements = null
    function ensureMovements() {
      if (movements !== null) return movements
      if (!host.Movements || !bot.pathfinder) return null
      movements = new host.Movements(bot)
      movements.canDig = false
      movements.allow1by1towers = false
      movements.allowParkour = false
      movements.allowSprinting = true
      movements.maxDropDown = 3
      bot.pathfinder.setMovements(movements)
      return movements
    }
    async function gotoNear(x, y, z, range, timeoutMs) {
      checkStop()
      if (!bot.pathfinder || !host.goals) throw fail('GOTO_UNAVAILABLE', 'pathfinder is not available')
      ensureMovements()
      try { bot.pathfinder.setGoal(new host.goals.GoalNear(x, y, z, range)) } catch (e) { throw fail('GOTO_GOAL_FAILED', String(e && e.message)) }
      const began = now()
      let idleSince = 0
      let lastCheck = now()
      let lastPos = feet()
      let stalledSince = 0
      while (true) {
        checkStop()
        const p = feet()
        if (Math.hypot(p.x - x, p.y - y, p.z - z) <= range + 0.7) {
          try { bot.pathfinder.stop() } catch (e) { /* goal already cleared */ }
          return true
        }
        if (now() - began > timeoutMs) {
          try { bot.pathfinder.stop() } catch (e) { /* ignore */ }
          return false
        }
        if (now() - lastCheck > 800) {
          const moved = Math.hypot(p.x - lastPos.x, p.y - lastPos.y, p.z - lastPos.z)
          lastCheck = now()
          lastPos = p
          if (moved < 0.2) {
            if (stalledSince === 0) stalledSince = now()
            else if (now() - stalledSince > 4000) {
              try { bot.pathfinder.stop() } catch (e) { /* ignore */ }
              return false
            }
          } else {
            stalledSince = 0
          }
        }
        let moving = true
        try { moving = bot.pathfinder.isMoving() } catch (e) { moving = false }
        if (!moving) {
          if (idleSince === 0) idleSince = now()
          else if (now() - idleSince > 1500) {
            try { bot.pathfinder.stop() } catch (e) { /* ignore */ }
            return false
          }
        } else {
          idleSince = 0
        }
        await sleep(100)
      }
    }
    async function walkToward(x, y, z, range, timeoutMs) {
      const began = now()
      let lastPos = feet()
      let stuckSince = 0
      while (now() - began < timeoutMs) {
        checkStop()
        const p = feet()
        const d = Math.hypot(p.x - x, p.y - y, p.z - z)
        if (d <= range) break
        const dx = x - p.x
        const dz = z - p.z
        const horizontal = Math.hypot(dx, dz) || 1
        const ax = Math.floor(p.x + (dx / horizontal) * 1.2)
        const az = Math.floor(p.z + (dz / horizontal) * 1.2)
        const fy = Math.floor(p.y)
        try { await guard(bot.lookAt(new Vec3(p.x + dx, p.y + 0.3, p.z + dz), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
        const ahead = at(ax, fy, az)
        const aheadHead = at(ax, fy + 1, az)
        const blockedAhead = ahead !== null && !isAir(ahead.name) && !FLUID[ahead.name]
        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)
        bot.setControlState('jump', blockedAhead || (aheadHead !== null && !isAir(aheadHead.name)))
        await sleep(240)
        const moved = Math.hypot(feet().x - lastPos.x, feet().y - lastPos.y, feet().z - lastPos.z)
        lastPos = feet()
        if (moved < 0.12) {
          if (stuckSince === 0) stuckSince = now()
          else if (now() - stuckSince > 1000) {
            // dig the obstruction, but never open a fluid
            const tries = [[ax, fy, az], [ax, fy + 1, az], [Math.floor(p.x), fy, Math.floor(p.z)], [Math.floor(p.x), fy + 1, Math.floor(p.z)]]
            for (const cellPos of tries) {
              const name = nameAt(cellPos[0], cellPos[1], cellPos[2])
              if (name === null || isAir(name) || isFluid(name) || name === 'bedrock') continue
              try { await dig(cellPos[0], cellPos[1], cellPos[2]) } catch (error) { /* keep trying */ }
              break
            }
            bot.setControlState('jump', true)
            await sleep(250)
            stuckSince = 0
          }
        } else {
          stuckSince = 0
        }
      }
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
      bot.setControlState('jump', false)
      return Math.hypot(feet().x - x, feet().y - y, feet().z - z) <= range + 0.6
    }
    async function tunnelTo(x, y, z, maxSteps) {
      const limit = maxSteps || 24
      for (let i = 0; i < limit; i += 1) {
        checkStop()
        const p = feet()
        if (Math.hypot(p.x - x, p.z - z) < 2.4 && Math.abs(p.y - y) < 2.5) return true
        const dx = x - p.x
        const dz = z - p.z
        const dir = Math.abs(dx) >= Math.abs(dz) ? { x: dx > 0 ? 1 : -1, z: 0 } : { x: 0, z: dz > 0 ? 1 : -1 }
        const c = cell()
        const nx = c.x + dir.x
        const nz = c.z + dir.z
        let blocked = false
        for (const level of [c.y + 1, c.y]) {
          const name = nameAt(nx, level, nz)
          if (name === null) break
          if (isAir(name)) continue
          if (isFluid(name)) return false
          if (name === 'bedrock') return false
          try {
            await dig(nx, level, nz)
          } catch (error) {
            if (error && error.code === 'OP_CANCELLED') throw error
            blocked = true
            break
          }
        }
        if (blocked) return false
        const belowNext = nameAt(nx, c.y - 1, nz)
        if (belowNext === null || isAir(belowNext)) return false
        try { await guard(bot.lookAt(new Vec3(nx + 0.5, bot.entity.position.y + 0.2, nz + 0.5), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
        bot.setControlState('forward', true)
        await sleep(360)
        bot.setControlState('forward', false)
        await sleep(120)
      }
      const end = feet()
      return Math.hypot(end.x - x, end.z - z) < 3.0
    }
    async function pathTo(x, y, z, range, timeoutMs) {
      checkStop()
      if (!bot.pathfinder || !host.goals) return false
      ensureMovements()
      let timer = null
      try {
        const goal = new host.goals.GoalNear(x, y, z, range)
        timer = setTimeout(() => { try { bot.pathfinder.stop() } catch (e) { /* ignore */ } }, timeoutMs)
        await bot.pathfinder.goto(goal)
        return true
      } catch (error) {
        return false
      } finally {
        if (timer !== null) { try { clearTimeout(timer) } catch (e) { /* ignore */ } }
      }
    }
    async function approach(x, y, z, range, timeoutMs) {
      if (await pathTo(x, y, z, range, Math.min(12000, timeoutMs))) return true
      if (await walkToward(x, y, z, range, Math.min(10000, timeoutMs))) return true
      return await tunnelTo(x, y, z, 24)
    }
    async function gotoBlock(x, y, z, range, timeoutMs) {
      return await approach(x + 0.5, y + 0.5, z + 0.5, range, timeoutMs)
    }
    async function escapeShaft() {
      const c = cell()
      for (const dir of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
        checkStop()
        const nx = c.x + dir.x
        const nz = c.z + dir.z
        const feetName = nameAt(nx, c.y, nz)
        const headName = nameAt(nx, c.y + 1, nz)
        if (feetName === null || headName === null) continue
        if (isFluid(feetName) || isFluid(headName)) continue
        if (feetName === 'bedrock') continue
        try {
          if (!isAir(feetName)) await dig(nx, c.y, nz)
          if (!isAir(headName)) await dig(nx, c.y + 1, nz)
          await sleep(120)
          const from = feet()
          try { await guard(bot.lookAt(new Vec3(from.x + dir.x * 2, from.y + 0.2, from.z + dir.z * 2), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
          bot.setControlState('forward', true)
          bot.setControlState('jump', true)
          await sleep(600)
          bot.setControlState('forward', false)
          bot.setControlState('jump', false)
          await sleep(200)
          const now2 = feet()
          if (Math.hypot(now2.x - from.x, now2.z - from.z) > 0.8) {
            note('shaft-escape', { dir: dir, from: from, to: now2 })
            return true
          }
        } catch (error) {
          if (error && error.code === 'OP_CANCELLED') throw error
        }
      }
      return false
    }
    async function unstick() {
      const p = feet()
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const here = at(fx, fy, fz)
      const head = at(fx, fy + 1, fz)
      const below = at(fx, fy - 1, fz)
      const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      const trapped = below !== null && !isAir(below.name) && !isFluid(below.name)
        && neighbours.every(([dx, dz]) => {
          const feetName = nameAt(fx + dx, fy, fz + dz)
          const headName = nameAt(fx + dx, fy + 1, fz + dz)
          return feetName !== null && headName !== null && !isAir(feetName) && !isAir(headName)
        })
      if (trapped) {
        if (await escapeShaft()) return
      }
      if (here !== null && !isAir(here.name) && !isFluid(here.name) && here.name !== 'bedrock') {
        try { await dig(fx, fy, fz) } catch (error) { /* ignore */ }
      }
      if (head !== null && !isAir(head.name) && !isFluid(head.name) && head.name !== 'bedrock') {
        try { await dig(fx, fy + 1, fz) } catch (error) { /* ignore */ }
      }
      if (below !== null && /(leaves|vine)/.test(below.name)) {
        // Standing in a canopy: dig out and step off the leaves for a moment.
        for (const dir of [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }]) {
          const ax = fx + dir.x
          const az = fz + dir.z
          for (const level of [fy, fy + 1]) {
            const name = nameAt(ax, level, az)
            if (name !== null && !isAir(name) && !isFluid(name) && name !== 'bedrock' && /(leaves|vine)/.test(name)) {
              try { await dig(ax, level, az) } catch (error) { /* ignore */ }
            }
          }
        }
        const p2 = feet()
        try { await guard(bot.lookAt(new Vec3(p2.x + 2, p2.y + 0.3, p2.z), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        await sleep(1200)
        bot.setControlState('forward', false)
        bot.setControlState('jump', false)
        await sleep(300)
      }
    }
    async function walkTo(dx, dz, targetX, targetZ, timeoutMs) {
      checkStop()
      const p = feet()
      try { await guard(bot.lookAt(new Vec3(p.x + dx * 1.6, p.y + 0.2, p.z + dz * 1.6), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* look is best effort */ }
      bot.setControlState('forward', true)
      const began = now()
      while (now() - began < timeoutMs) {
        checkStop()
        const c = cell()
        if (c.x === targetX && c.z === targetZ) break
        await sleep(40)
      }
      bot.setControlState('forward', false)
      await sleep(120)
    }

    // --------------------------------------------------------------- inventory
    function items() { return bot.inventory.items() }
    function count(name) {
      let total = 0
      for (const item of items()) if (item.name === name) total += item.count
      return total
    }
    function countLike(pattern) {
      let total = 0
      for (const item of items()) if (pattern.test(item.name)) total += item.count
      return total
    }
    function findItem(name) { return items().find(item => item.name === name) }
    async function equip(name) {
      const item = findItem(name)
      if (item === undefined) throw fail('ITEM_NOT_FOUND', 'missing item in inventory: ' + name)
      await guard(bot.equip(item, 'hand'), 5000, 'EQUIP_TIMEOUT')
      await sleep(100)
    }
    function inventorySnapshot() {
      return items().map(item => ({ name: item.name, count: item.count }))
    }
    function timeSnapshot() {
      const t = bot.time || {}
      return {
        timeOfDay: typeof t.timeOfDay === 'number' ? t.timeOfDay : null,
        worldAge: typeof t.age === 'number' ? t.age : null,
        doDaylightCycle: t.doDaylightCycle === undefined ? null : t.doDaylightCycle,
      }
    }
    function positionSnapshot() {
      const p = feet()
      const e = bot.entity || {}
      return {
        x: p.x, y: p.y, z: p.z,
        yaw: typeof e.yaw === 'number' ? e.yaw : null,
        onGround: typeof e.onGround === 'boolean' ? e.onGround : null,
        inWater: typeof e.isInWater === 'boolean' ? e.isInWater : null,
        inLava: typeof e.isInLava === 'boolean' ? e.isInLava : null,
        health: bot.health === undefined ? null : bot.health,
        food: bot.food === undefined ? null : bot.food,
        oxygen: bot.oxygenLevel === undefined ? null : bot.oxygenLevel,
      }
    }

    // ---------------------------------------------------------------- crafting
    function itemId(name) {
      const def = bot.registry.itemsByName[name]
      return def === undefined ? undefined : def.id
    }
    function tableNearby() {
      const def = bot.registry.blocksByName['crafting_table']
      if (def === undefined) return null
      const found = bot.findBlocks({ matching: def.id, maxDistance: 5, count: 2 })
      if (!found.length) return null
      return at(found[0].x, found[0].y, found[0].z)
    }
    async function craft(name, times) {
      const id = itemId(name)
      if (id === undefined) throw fail('UNKNOWN_ITEM', 'unknown item ' + name)
      const table = tableNearby()
      let recipe = null
      if (table !== null) recipe = bot.recipesFor(id, null, 1, table)[0]
      if (recipe === undefined || recipe === null) recipe = bot.recipesFor(id, null, 1, null)[0] || null
      if (recipe === null) throw fail('NO_RECIPE', 'no craftable recipe for ' + name)
      if (recipe.requiresTable && table === null) throw fail('CRAFT_NO_TABLE', name + ' requires a crafting table in reach')
      const before = count(name)
      await guard(bot.craft(recipe, times, recipe.requiresTable ? table : null), 30000, 'CRAFT_TIMEOUT')
      await sleep(200)
      const after = count(name)
      event('craft', { item: name, times: times, before: before, after: after })
      if (after <= before) throw fail('CRAFT_NO_RESULT', 'crafting ' + name + ' produced nothing')
      return after - before
    }
    function logPlankName(logName) {
      return logName.replace(/(_log|_stem|_wood|_hyphae)$/, '_planks')
    }
    async function ensurePlanks(target) {
      let guard = 0
      while (countLike(/_planks$/) < target) {
        checkStop()
        guard += 1
        if (guard > 24) throw fail('NO_LOGS', 'no logs left to make planks')
        const logs = items().filter(item => /(_log|_stem|_wood|_hyphae)$/.test(item.name))
        if (!logs.length) throw fail('NO_LOGS', 'no logs in inventory')
        await craft(logPlankName(logs[0].name), 1)
      }
      return countLike(/_planks$/)
    }
    async function ensureSticks(target) {
      let guard = 0
      while (count('stick') < target) {
        checkStop()
        guard += 1
        if (guard > 8) throw fail('NO_STICKS', 'could not craft sticks')
        await ensurePlanks(2)
        await craft('stick', 1)
      }
    }

    // ---------------------------------------------------------------- placing
    const FACES = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }
    function itemForBlock(blockName) { return blockName }
    async function place(x, y, z, itemName, face) {
      checkStop()
      const f = FACES[face || 'up'] || FACES.up
      const target = at(x, y, z)
      if (target !== null && !isAir(target.name) && !isFluid(target.name)) {
        throw fail('TARGET_OCCUPIED', 'target ' + x + ',' + y + ',' + z + ' is ' + target.name)
      }
      const rx = x - f[0]
      const ry = y - f[1]
      const rz = z - f[2]
      const ref = at(rx, ry, rz)
      if (ref === null || !isSolid(ref.name)) throw fail('NO_SUPPORT', 'no solid support at ' + rx + ',' + ry + ',' + rz)
      if (count(itemName) <= 0) throw fail('ITEM_NOT_FOUND', 'no ' + itemName + ' to place')
      await equip(itemName)
      if (dist(feet(), { x: x + 0.5, y: y + 0.5, z: z + 0.5 }) > 4.0) {
        const ok = await gotoBlock(x, y, z, 2.4, 20000)
        if (!ok) throw fail('PLACE_OUT_OF_REACH', 'cannot reach ' + x + ',' + y + ',' + z)
      }
      try { await guard(bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
      await guard(bot.placeBlock(ref, new Vec3(f[0], f[1], f[2])), 5000, 'PLACE_TIMEOUT')
      await sleep(150)
      const after = at(x, y, z)
      if (after === null || isAir(after.name)) throw fail('PLACE_FAILED', 'nothing at ' + x + ',' + y + ',' + z)
      return after
    }
    function freeSpotNear(radius, avoid) {
      const c = cell()
      for (let r = 1; r <= radius; r += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          for (let dz = -r; dz <= r; dz += 1) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue
            const x = c.x + dx
            const z = c.z + dz
            for (let dy = 1; dy >= -1; dy -= 1) {
              const y = c.y + dy
              const here = nameAt(x, y, z)
              const above = nameAt(x, y + 1, z)
              const below = nameAt(x, y - 1, z)
              if (!isAir(here) || !isAir(above) || !isSolid(below)) continue
              if (avoid !== undefined && avoid(x, y, z)) continue
              return { x: x, y: y, z: z }
            }
          }
        }
      }
      return null
    }

    // ----------------------------------------------------------------- digging
    async function dig(x, y, z) {
      checkStop()
      const block = at(x, y, z)
      if (block === null) throw fail('BLOCK_UNKNOWN', 'block not loaded at ' + x + ',' + y + ',' + z)
      if (isAir(block.name)) return { dug: false, name: block.name }
      if (isFluid(block.name)) throw fail('DIG_INTO_FLUID', block.name + ' at ' + x + ',' + y + ',' + z)
      if (block.name === 'bedrock') throw fail('BEDROCK', 'cannot dig bedrock')
      if (dist(feet(), { x: x + 0.5, y: y + 0.5, z: z + 0.5 }) > 4.2) {
        const ok = await gotoBlock(x, y, z, 2.2, 25000)
        if (!ok) throw fail('DIG_OUT_OF_REACH', 'cannot reach ' + x + ',' + y + ',' + z)
      }
      try { await guard(bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await guard(bot.dig(block, true), 8000, 'DIG_TIMEOUT')
        } catch (error) {
          const code = error && error.code ? String(error.code) : ''
          if (code === 'DIG_TIMEOUT') {
            // The server may have broken the block even though the client did not
            // settle the dig promise; read back before declaring failure.
            for (let poll = 0; poll < 50; poll += 1) {
              const readBack = at(x, y, z)
              if (readBack === null || isAir(readBack.name)) return { dug: true, name: block.name }
              await sleep(100)
            }
          }
          if (code.indexOf('DIG') === 0 || code.indexOf('BLOCK') === 0) throw fail('DIG_FAILED', String(error.message || error))
        }
        for (let poll = 0; poll < 25; poll += 1) {
          const after = at(x, y, z)
          if (after === null || isAir(after.name)) return { dug: true, name: block.name }
          await sleep(60)
        }
      }
      throw fail('DIG_FAILED', 'block still present at ' + x + ',' + y + ',' + z)
    }
    async function collectDrops(radius) {
      await sleep(250)
      const p = feet()
      const drops = Object.values(bot.entities)
        .filter(entity => entity && entity.name === 'item' && entity.position && dist(p, entity.position) <= (radius || 6))
        .slice(0, 4)
      for (const drop of drops) {
        checkStop()
        try { await gotoNear(drop.position.x, drop.position.y, drop.position.z, 0.8, 2000) } catch (e) { /* best effort */ }
        await sleep(100)
      }
    }
    async function digStepDown(dirx, dirz) {
      const c = cell()
      const nx = c.x + dirx
      const nz = c.z + dirz
      // head, feet and the floor step ahead; refuse to open fluids or a big drop.
      const belowStep = nameAt(nx, c.y - 2, nz)
      if (!isSolid(belowStep)) {
        if (isFluid(belowStep) || belowStep === null) throw fail('STAIR_RISK', 'no floor ahead at ' + nx + ',' + (c.y - 2) + ',' + nz)
      }
      await dig(nx, c.y + 1, nz)
      await dig(nx, c.y, nz)
      await dig(nx, c.y - 1, nz)
      await walkTo(dirx, dirz, nx, nz, 2500)
      await sleep(150)
    }
    async function collectCobble(target) {
      let guard = 0
      while (count('cobblestone') < target) {
        checkStop()
        guard += 1
        if (guard > 60) throw fail('NO_COBBLE', 'could not find stone to mine')
        const ids = []
        for (const name of ['stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff']) {
          const def = bot.registry.blocksByName[name]
          if (def !== undefined) ids.push(def.id)
        }
        const found = bot.findBlocks({ matching: block => ids.indexOf(block.type) >= 0, maxDistance: 8, count: 16 })
        let targetBlock = null
        for (const point of found) {
          const b = at(point.x, point.y, point.z)
          if (b === null) continue
          if (dist(feet(), b.position) <= 4.0) { targetBlock = b; break }
        }
        if (targetBlock === null) {
          // nothing in reach: descend one step (or approach the nearest stone)
          let approached = false
          if (found.length) {
            const nearest = found[0]
            approached = await gotoBlock(nearest.x, nearest.y, nearest.z, 2.0, 12000)
          }
          if (!approached) {
            const dirs = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }]
            let dug = false
            for (const dir of dirs) {
              try { await digStepDown(dir.x, dir.z); dug = true; break } catch (error) {
                if (error && error.code === 'OP_CANCELLED') throw error
              }
            }
            if (!dug) throw fail('NO_COBBLE_ROUTE', 'cannot reach stone')
          }
          continue
        }
        try {
          await dig(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z)
          await collectDrops(4)
        } catch (error) {
          if (error && error.code === 'OP_CANCELLED') throw error
        }
      }
    }

    // ------------------------------------------------------------------- food
    const FOOD = /^(cooked_|raw_)?(beef|porkchop|mutton|chicken|rabbit)$|^(bread|apple|baked_potato|carrot|golden_apple)$/
    async function eatIfNeeded() {
      const food = bot.food === undefined ? 20 : bot.food
      if (food > 16) return false
      const candidates = items().filter(item => FOOD.test(item.name))
      if (!candidates.length) return false
      const choice = candidates.sort((a, b) => b.count - a.count)[0]
      try {
        await guard(bot.equip(choice, 'hand'), 5000, 'EQUIP_TIMEOUT')
        await sleep(120)
        await guard(bot.consume(), 5000, 'CONSUME_TIMEOUT')
        await sleep(200)
        event('eat', { item: choice.name, foodBefore: food, foodAfter: bot.food })
        return true
      } catch (error) {
        log('eat failed: ' + String(error && error.message))
        return false
      }
    }

    // ------------------------------------------------------------------- wood
    async function waitForWorldReady() {
      for (let i = 0; i < 60; i += 1) {
        checkStop()
        const c = cell()
        const below = at(c.x, c.y - 1, c.z)
        if (below !== null && below.name !== undefined) {
          const nearby = bot.findBlocks({ matching: block => block.type !== 0, maxDistance: 16, count: 8 })
          if (nearby.length > 0) {
            note('world-ready', { waitedMs: i * 300, position: feet() })
            return true
          }
        }
        await sleep(300)
      }
      return false
    }
    async function ensureLogs(target) {
      const failedTrees = {}
      let guard = 0
      const searchBegan = now()
      while (countLike(/(_log|_stem|_wood|_hyphae)$/) < target) {
        checkStop()
        guard += 1
        if (guard > 24) throw fail('NO_TREE', 'no reachable tree found')
        if (now() - searchBegan > 240000) throw fail('NO_TREE', 'tree search exceeded 4 minutes')
        const ids = logIds()
        if (!ids.length) throw fail('NO_TREE', 'no log block definitions')
        let found = []
        for (let attempt = 0; attempt < 6 && found.length === 0; attempt += 1) {
          found = bot.findBlocks({ matching: block => ids.indexOf(block.type) >= 0, maxDistance: 64, count: 64 })
          if (found.length === 0) await sleep(1200)
        }
        if (found.length === 0) {
          // move toward unloaded ground and rescan
          const p = feet()
          const angle = (guard * 2.39) % (Math.PI * 2)
          note('roam-for-trees', { from: p, angle: angle })
          await approach(p.x + Math.cos(angle) * 24, p.y, p.z + Math.sin(angle) * 24, 4, 25000).catch(() => false)
          await sleep(800)
          continue
        }
        let best = null
        let bestD = 1e9
        let fallback = null
        let fallbackD = 1e9
        for (const point of found) {
          const key = point.x + ',' + point.y + ',' + point.z
          if (failedTrees[key] === 1) continue
          const d = dist(feet(), point)
          const belowName = nameAt(point.x, point.y - 1, point.z)
          const isBase = belowName !== null && isSolid(belowName) && !/(leaves|vine)/.test(belowName)
          if (d < fallbackD) { fallbackD = d; fallback = point }
          if (isBase && d < bestD) { bestD = d; best = point }
        }
        if (best === null) best = fallback
        if (best === null) {
          // every loaded tree failed: move away and look for another area
          const p = feet()
          await gotoNear(p.x + 14, p.y, p.z + 8, 4, 20000).catch(() => false)
          await sleep(600)
          continue
        }
        note('approach-tree', { x: best.x, y: best.y, z: best.z, distance: Math.round(bestD) })
        const ok = await gotoBlock(best.x, best.y, best.z, 2.2, 25000)
        if (!ok) {
          const tunnelled = await tunnelTo(best.x, best.y, best.z, 28).catch(() => false)
          if (!tunnelled) {
            failedTrees[best.x + ',' + best.y + ',' + best.z] = 1
            note('tree-unreachable', { x: best.x, y: best.y, z: best.z })
            continue
          }
        }
        let chopped = 0
        for (let i = 0; i < 5; i += 1) {
          checkStop()
          const b = at(best.x, best.y + i, best.z)
          if (b === null || !/(_log|_stem|_wood|_hyphae)$/.test(b.name)) break
          try {
            await dig(best.x, best.y + i, best.z)
            chopped += 1
          } catch (error) {
            if (error && error.code === 'OP_CANCELLED') throw error
            break
          }
        }
        if (chopped === 0) failedTrees[best.x + ',' + best.y + ',' + best.z] = 1
        await collectDrops(6)
        note('chop', { x: best.x, y: best.y, z: best.z, chopped: chopped, logs: countLike(/(_log|_stem|_wood|_hyphae)$/) })
        await eatIfNeeded()
      }
      return countLike(/(_log|_stem|_wood|_hyphae)$/)
    }

    // ------------------------------------------------------------- camp access
    // ------------------------------------------------------------- camp layout
    function campSite() {
      return state.camp === undefined ? null : state.camp.site
    }
    function insideRoom() {
      const camp = state.camp
      if (!camp) return false
      const c = cell()
      const room = camp.room
      return c.x >= room.min.x && c.x <= room.max.x && c.z >= room.min.z && c.z <= room.max.z
        && c.y >= room.min.y && c.y <= room.max.y
    }
    function doorProperties(block) {
      try {
        const value = block && typeof block.getProperties === 'function' ? block.getProperties() : {}
        return value || {}
      } catch (error) {
        return {}
      }
    }
    function doorIsOpen() {
      const camp = state.camp
      if (!camp) return null
      const b = at(camp.door[0].x, camp.door[0].y, camp.door[0].z)
      if (b === null || !/_door$/.test(b.name)) return null
      const props = doorProperties(b)
      if (props.open === true || props.open === 'true') return true
      return false
    }
    function doorItemName() {
      const item = items().find(candidate => /_door$/.test(candidate.name))
      return item === undefined ? null : item.name
    }
    async function setDoor(open) {
      const camp = state.camp
      if (!camp) return false
      const foot = camp.door[0]
      if (dist(feet(), { x: foot.x + 0.5, y: foot.y + 0.5, z: foot.z + 0.5 }) > 4.0) {
        await gotoNear(foot.x + 0.5, foot.y + 0.2, foot.z + 0.5, 1.2, 12000).catch(() => false)
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        checkStop()
        const b = at(foot.x, foot.y, foot.z)
        if (b === null || !/_door$/.test(b.name)) return false
        if (doorIsOpen() === open) return true
        try { await guard(bot.activateBlock(b), 3000, 'ACTIVATE_TIMEOUT') } catch (error) { /* may be out of reach */ }
        await sleep(300)
      }
      return doorIsOpen() === open
    }
    async function climbOut() {
      const s = campSite()
      if (s === null) return false
      const p = feet()
      try { await guard(bot.lookAt(new Vec3(p.x - 2, p.y + 0.6, p.z), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(1600)
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
      await sleep(250)
      return !insideRoom()
    }
    async function dropIn() {
      const s = campSite()
      if (s === null) return false
      const notchX = s.x0 - 2
      const notchZ = s.z0 + 1
      await gotoNear(notchX + 0.5, s.y0 + 1.2, notchZ + 0.5, 1.0, 20000).catch(() => false)
      try { await guard(bot.lookAt(new Vec3(s.x0 - 0.5, s.y0 - 1.5, notchZ + 0.5), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
      bot.setControlState('forward', true)
      await sleep(900)
      bot.setControlState('forward', false)
      await sleep(300)
      return true
    }
    async function leaveShelter() {
      if (!state.camp) return false
      if (!insideRoom()) return true
      await setDoor(true)
      await climbOut()
      if (insideRoom()) {
        await climbOut()
      }
      note('left-shelter', { position: positionSnapshot(), inside: insideRoom() })
      return !insideRoom()
    }
    async function enterShelter() {
      if (!state.camp) return false
      if (insideRoom()) return true
      const s = campSite()
      await approach(s.x0 - 2.5, s.y0 + 1.2, s.z0 + 1.5, 1.6, 30000).catch(() => false)
      await dropIn()
      await setDoor(true).catch(() => false)
      await walkToward(s.x0 + 1.0, s.y0 - 2, s.z0 + 1.5, 1.0, 8000)
      await setDoor(false).catch(() => false)
      return insideRoom()
    }
    async function gotoCampApproach() {
      const s = campSite()
      if (s === null) return false
      await approach(s.x0 - 2.5, s.y0 + 1.2, s.z0 + 1.5, 1.6, 30000).catch(() => false)
      return true
    }

    // ---------------------------------------------------------------- shelter
    function scorePit(x0, y0, z0) {
      let score = 0
      for (let x = x0; x <= x0 + 2; x += 1) {
        for (let z = z0; z <= z0 + 2; z += 1) {
          for (let y = y0; y >= y0 - 2; y -= 1) {
            const name = nameAt(x, y, z)
            if (name === null || isFluid(name) || name === 'bedrock') return -1
            if (isSolid(name)) score += 2
          }
        }
      }
      for (let x = x0 - 1; x <= x0 + 3; x += 1) {
        for (let z = z0 - 1; z <= z0 + 3; z += 1) {
          if (x >= x0 && x <= x0 + 2 && z >= z0 && z <= z0 + 2) continue
          const name = nameAt(x, y0, z)
          if (name !== null && isSolid(name)) score += 1
        }
      }
      const trench = [
        { x: x0 - 1, y: y0 - 2, z: z0 + 1 },
        { x: x0 - 1, y: y0 - 1, z: z0 + 1 },
        { x: x0 - 2, y: y0 - 1, z: z0 + 1 },
        { x: x0 - 2, y: y0, z: z0 + 1 },
        { x: x0 - 3, y: y0, z: z0 + 1 },
      ]
      for (const cellPos of trench) {
        const name = nameAt(cellPos.x, cellPos.y, cellPos.z)
        if (name === null || isFluid(name)) return -1
        if (isSolid(name)) score += 1
      }
      return score
    }
    function chooseShelterSite() {
      const c = cell()
      let best = null
      let bestScore = -1
      for (let r = 0; r <= 8; r += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          for (let dz = -r; dz <= r; dz += 1) {
            if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue
            const x0 = c.x + dx
            const z0 = c.z + dz
            const y0 = c.y - 1
            if (!isSolid(nameAt(x0, y0, z0))) continue
            const score = scorePit(x0, y0, z0)
            if (score > bestScore) { bestScore = score; best = { x0: x0, y0: y0, z0: z0, score: score } }
          }
        }
        if (best !== null && bestScore >= 110) break
      }
      return best
    }
    async function buildShelter(site) {
      const x0 = site.x0
      const y0 = site.y0
      const z0 = site.z0
      note('shelter-site', site)
      await approach(x0 + 0.5, y0 + 1.2, z0 + 0.5, 1.0, 20000).catch(() => false)
      // 1) dig the 3x3x3 shaft (surface, head and feet layers)
      for (let y = y0; y >= y0 - 2; y -= 1) {
        for (let x = x0; x <= x0 + 2; x += 1) {
          for (let z = z0; z <= z0 + 2; z += 1) {
            checkStop()
            try { await dig(x, y, z) } catch (error) {
              if (error && error.code === 'OP_CANCELLED') throw error
              log('pit dig failed at ' + x + ',' + y + ',' + z + ': ' + String(error && error.message))
              throw error
            }
          }
        }
        await collectDrops(4)
        await eatIfNeeded()
      }
      // 2) stepped entrance trench: junction, one step, surface notch
      const doorFoot = { x: x0 - 1, y: y0 - 2, z: z0 + 1 }
      const doorHead = { x: doorFoot.x, y: y0 - 1, z: doorFoot.z }
      const trench = [
        { x: x0 - 1, y: y0 - 2, z: z0 + 1 },
        { x: x0 - 1, y: y0 - 1, z: z0 + 1 },
        { x: x0 - 2, y: y0 - 1, z: z0 + 1 },
        { x: x0 - 2, y: y0, z: z0 + 1 },
        { x: x0 - 3, y: y0, z: z0 + 1 },
      ]
      for (const cellPos of trench) {
        checkStop()
        try { await dig(cellPos.x, cellPos.y, cellPos.z) } catch (error) {
          if (error && error.code === 'OP_CANCELLED') throw error
        }
      }
      await collectDrops(4)
      const room = { min: { x: x0, y: y0 - 2, z: z0 }, max: { x: x0 + 2, y: y0 - 1, z: z0 + 2 } }
      // 3) ceiling: perimeter first (references the rim), then the centre
      const ceiling = []
      for (let x = x0; x <= x0 + 2; x += 1) {
        for (let z = z0; z <= z0 + 2; z += 1) {
          if (x === x0 + 1 && z === z0 + 1) continue
          ceiling.push({ x: x, z: z })
        }
      }
      ceiling.push({ x: x0 + 1, z: z0 + 1 })
      for (const cellPos of ceiling) {
        checkStop()
        const current = nameAt(cellPos.x, y0, cellPos.z)
        if (current !== null && !isAir(current)) continue
        const fill = count('cobblestone') > 0 ? 'cobblestone' : (count('dirt') > 0 ? 'dirt' : null)
        if (fill === null) throw fail('NO_CEILING_BLOCK', 'no blocks left for the ceiling')
        let placed = false
        for (const face of ['east', 'west', 'north', 'south', 'up']) {
          const f = FACES[face]
          if (!isSolid(nameAt(cellPos.x - f[0], y0 - f[1], cellPos.z - f[2]))) continue
          try {
            await place(cellPos.x, y0, cellPos.z, fill, face)
            placed = true
            break
          } catch (error) {
            if (error && error.code === 'OP_CANCELLED') throw error
          }
        }
        if (!placed) throw fail('CEILING_FAILED', 'could not close the ceiling at ' + cellPos.x + ',' + cellPos.z)
      }
      // 4) boundary: floor, walls and the remaining ceiling cells must be closed
      const doorSet = {}
      doorSet[doorFoot.x + ',' + doorFoot.y + ',' + doorFoot.z] = 1
      doorSet[doorHead.x + ',' + doorHead.y + ',' + doorHead.z] = 1
      const ring = []
      for (let x = x0; x <= x0 + 2; x += 1) {
        for (let z = z0; z <= z0 + 2; z += 1) {
          ring.push({ x: x, y: y0 - 3, z: z })
          ring.push({ x: x, y: y0, z: z })
        }
      }
      for (let y = y0 - 2; y <= y0 - 1; y += 1) {
        for (let z = z0; z <= z0 + 2; z += 1) {
          ring.push({ x: x0 - 1, y: y, z: z })
          ring.push({ x: x0 + 3, y: y, z: z })
        }
        for (let x = x0; x <= x0 + 2; x += 1) {
          ring.push({ x: x, y: y, z: z0 - 1 })
          ring.push({ x: x, y: y, z: z0 + 3 })
        }
      }
      const holes = []
      for (const cellPos of ring) {
        if (doorSet[cellPos.x + ',' + cellPos.y + ',' + cellPos.z] === 1) continue
        const name = nameAt(cellPos.x, cellPos.y, cellPos.z)
        if (name === null || isAir(name) || isFluid(name)) holes.push({ x: cellPos.x, y: cellPos.y, z: cellPos.z, name: name })
      }
      note('room-boundary', { room: room, holes: holes })
      let filled = 0
      for (const hole of holes) {
        checkStop()
        const fill = count('cobblestone') > 0 ? 'cobblestone' : (count('dirt') > 0 ? 'dirt' : null)
        if (fill === null) break
        let placed = false
        for (const face of ['up', 'down', 'east', 'west', 'north', 'south']) {
          const f = FACES[face]
          if (!isSolid(nameAt(hole.x - f[0], hole.y - f[1], hole.z - f[2]))) continue
          try {
            await place(hole.x, hole.y, hole.z, fill, face)
            placed = true
            filled += 1
            break
          } catch (error) {
            if (error && error.code === 'OP_CANCELLED') throw error
          }
        }
        if (!placed) log('could not backfill ' + hole.x + ',' + hole.y + ',' + hole.z)
      }
      note('backfilled', { filled: filled })
      // 5) door in the entrance wall
      note('door-check', { foot: doorFoot, head: doorHead, support: nameAt(doorFoot.x, doorFoot.y - 1, doorFoot.z), item: doorItemName() })
      let doorOk = false
      const existingDoor = at(doorFoot.x, doorFoot.y, doorFoot.z)
      if (existingDoor !== null && /_door$/.test(existingDoor.name)) {
        doorOk = true
      } else {
        if (doorItemName() === null) {
          await ensurePlanks(6)
          const plank = items().find(item => /_planks$/.test(item.name))
          if (!plank) throw fail('NO_DOOR', 'no planks for a door')
          await craft(plank.name.replace('_planks', '_door'), 1)
        }
        const item = doorItemName()
        if (item === null) throw fail('NO_DOOR', 'no door item after crafting')
        await equip(item)
        note('door-equipped', { item: item, held: bot.heldItem ? bot.heldItem.name : null })
        let ref = at(doorFoot.x, doorFoot.y - 1, doorFoot.z)
        if (ref === null || !isSolid(ref.name)) {
          const fill = count('cobblestone') > 0 ? 'cobblestone' : (count('dirt') > 0 ? 'dirt' : null)
          if (fill !== null) {
            try { await place(doorFoot.x, doorFoot.y - 1, doorFoot.z, fill, 'up') } catch (error) { if (error && error.code === 'OP_CANCELLED') throw error }
            ref = at(doorFoot.x, doorFoot.y - 1, doorFoot.z)
          }
        }
        if (ref === null || !isSolid(ref.name)) throw fail('DOOR_NO_SUPPORT', 'no floor under the door')
        try { await guard(bot.lookAt(new Vec3(doorFoot.x + 0.5, doorFoot.y + 0.5, doorFoot.z + 0.5), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
        try {
          await guard(bot.placeBlock(ref, new Vec3(0, 1, 0)), 5000, 'PLACE_TIMEOUT')
          note('door-placed', { foot: nameAt(doorFoot.x, doorFoot.y, doorFoot.z), head: nameAt(doorHead.x, doorHead.y, doorHead.z) })
        } catch (error) {
          log('door placeBlock failed: ' + String(error && error.message))
        }
        await sleep(250)
        doorOk = nameAt(doorFoot.x, doorFoot.y, doorFoot.z) === item
          && nameAt(doorHead.x, doorHead.y, doorHead.z) === item
      }
      if (!doorOk) throw fail('DOOR_FAILED', 'the door is not in both cells')
      let toggled = false
      const doorBlock = at(doorFoot.x, doorFoot.y, doorFoot.z)
      if (doorBlock !== null) {
        try {
          await guard(bot.activateBlock(doorBlock), 3000, 'ACTIVATE_TIMEOUT')
          await sleep(300)
          const opened = at(doorFoot.x, doorFoot.y, doorFoot.z)
          await guard(bot.activateBlock(opened || doorBlock), 3000, 'ACTIVATE_TIMEOUT')
          await sleep(300)
          toggled = true
          event('door-toggle', { x: doorFoot.x, y: doorFoot.y, z: doorFoot.z })
        } catch (error) {
          log('door toggle failed: ' + String(error && error.message))
        }
      }
      // 6) move the crafting table inside; everything else is crafted here
      const tableInside = { x: x0 + 2, y: y0 - 2, z: z0 + 2 }
      const outsideTable = tableNearby()
      if (outsideTable !== null && !(outsideTable.position.x === tableInside.x && outsideTable.position.y === tableInside.y && outsideTable.position.z === tableInside.z)) {
        try {
          await dig(outsideTable.position.x, outsideTable.position.y, outsideTable.position.z)
          await collectDrops(4)
          if (count('crafting_table') > 0 && isAir(nameAt(tableInside.x, tableInside.y, tableInside.z))) {
            await place(tableInside.x, tableInside.y, tableInside.z, 'crafting_table', 'up')
          }
        } catch (error) {
          if (error && error.code === 'OP_CANCELLED') throw error
          log('moving the table failed: ' + String(error && error.message))
        }
      }
      // 7) torch (charcoal can be made inside from the pit's own cobble)
      let torchOk = false
      for (let x = room.min.x; x <= room.max.x && !torchOk; x += 1) {
        for (let z = room.min.z; z <= room.max.z && !torchOk; z += 1) {
          const name = nameAt(x, room.min.y, z)
          if (name === 'torch' || name === 'wall_torch') { torchOk = true; break }
        }
      }
      if (!torchOk) {
        if (count('torch') === 0) {
          if (count('coal') + count('charcoal') === 0) {
            note('furnace-cobble-missing', { cobblestone: count('cobblestone') })
            if (count('cobblestone') >= 8) {
              if (tableNearby() === null) throw fail('NO_TABLE', 'no crafting table in reach inside the room')
              if (count('furnace') === 0) await craft('furnace', 1)
              const furnaceSpot = { x: room.max.x, y: room.min.y, z: room.min.z }
              if (count('furnace') > 0 && isAir(nameAt(furnaceSpot.x, furnaceSpot.y, furnaceSpot.z))) {
                await place(furnaceSpot.x, furnaceSpot.y, furnaceSpot.z, 'furnace', 'up')
              }
              const furnaceBlock = findFurnaceNear()
              if (furnaceBlock !== null) {
                const furnace = await guard(bot.openFurnace(furnaceBlock), 10000, 'FURNACE_TIMEOUT')
                try {
                  const logItem = items().find(item => /(_log|_stem|_wood|_hyphae)$/.test(item.name))
                  const fuel = items().find(item => /_planks$/.test(item.name))
                  if (logItem && fuel) {
                    await furnace.putFuel(itemId(fuel.name), null, 1)
                    await furnace.putInput(itemId(logItem.name), null, 1)
                    const began = now()
                    while (now() - began < 25000) {
                      await sleep(1000)
                      if (furnace.outputItem()) break
                    }
                    const taken = await furnace.takeOutput()
                    if (taken) event('charcoal', { item: taken.name, count: taken.count })
                  }
                } finally {
                  await furnace.close().catch(() => {})
                }
              }
            }
          }
          if (count('coal') + count('charcoal') === 0) throw fail('NO_COAL', 'no coal or charcoal for a torch')
          if (count('stick') === 0) await ensureSticks(1)
          await craft('torch', 1)
        }
        const torchSpot = { x: room.min.x, y: room.min.y, z: room.max.z }
        if (isAir(nameAt(torchSpot.x, torchSpot.y, torchSpot.z))) {
          await place(torchSpot.x, torchSpot.y, torchSpot.z, 'torch', 'up')
          torchOk = true
        }
      }
      if (!torchOk) throw fail('NO_TORCH', 'could not place a torch inside the room')
      // 8) close the door and stand inside
      await setDoor(false)
      if (!insideRoom()) {
        await walkToward(x0 + 1.0, y0 - 2, z0 + 1.5, 1.2, 8000).catch(() => false)
      }
      const blockEvidence = []
      for (let x = room.min.x - 1; x <= room.max.x + 1; x += 1) {
        for (let z = room.min.z - 1; z <= room.max.z + 1; z += 1) {
          for (let y = room.min.y - 1; y <= room.max.y + 1; y += 1) {
            blockEvidence.push({ x: x, y: y, z: z, name: nameAt(x, y, z) })
          }
        }
      }
      const camp = {
        site: site,
        room: room,
        door: [doorFoot, doorHead],
        table: tableInside,
        torch: torchOk,
        doorToggled: toggled,
        builtAt: now(),
      }
      state.camp = camp
      evidence.camp = camp
      evidence.blocks = blockEvidence
      evidence.position = positionSnapshot()
      evidence.time = timeSnapshot()
      evidence.inventory = inventorySnapshot()
      evidence.inside = insideRoom()
      note('shelter-done', { room: room, door: doorFoot, inside: evidence.inside })
      if (!evidence.inside) throw fail('NOT_INSIDE', 'bot is not inside the finished room')
      return evidence
    }
    // ------------------------------------------------------------------- wool
    async function ensureWool(target) {
      let guard = 0
      while (countLike(/_wool$/) < target) {
        checkStop()
        guard += 1
        if (guard > 8) throw fail('NO_SHEEP', 'could not find enough sheep')
        const p = feet()
        const sheep = Object.values(bot.entities).filter(entity => entity && entity.name === 'sheep' && entity.position && dist(p, entity.position) < 64)
        let targetEntity = null
        let bestD = 1e9
        for (const sheepEntity of sheep) {
          const d = dist(p, sheepEntity.position)
          if (d < bestD) { bestD = d; targetEntity = sheepEntity }
        }
        if (targetEntity === null) {
          const angle = (guard * 2.39) % (Math.PI * 2)
          note('roam-for-sheep', { x: p.x + Math.cos(angle) * 40, z: p.z + Math.sin(angle) * 40 })
          await approach(p.x + Math.cos(angle) * 40, p.y, p.z + Math.sin(angle) * 40, 3, 45000).catch(() => false)
          continue
        }
        note('hunt-sheep', { id: targetEntity.id, distance: Math.round(bestD), wool: countLike(/_wool$/) })
        for (let round = 0; round < 40; round += 1) {
          checkStop()
          const live = bot.entities[targetEntity.id]
          if (live === undefined) break
          const d = dist(feet(), live.position)
          if (d > 3) {
            const ok = await approach(live.position.x, live.position.y, live.position.z, 2.0, 8000)
            if (!ok) break
          }
          try { await guard(bot.lookAt(live.position.offset(0, 1.0, 0), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
          try { await bot.attack(live) } catch (e) { /* ignore */ }
          await sleep(650)
          await eatIfNeeded()
        }
        await collectDrops(8)
        if (countLike(/_wool$/) === 0 && guard > 3) throw fail('WOOL_NOT_COLLECTED', 'sheep died but no wool was collected')
      }
      return countLike(/_wool$/)
    }
    async function ensureBed() {
      const wool = countLike(/_wool$/)
      if (wool < 3) await ensureWool(3)
      if (countLike(/_bed$/) === 0) {
        await ensurePlanks(3)
        const woolItem = items().find(item => /_wool$/.test(item.name))
        if (!woolItem) throw fail('NO_WOOL', 'no wool after hunting')
        const bedName = woolItem.name.replace('_wool', '_bed')
        await craft(bedName, 1)
      }
      const bedItem = items().find(item => /_bed$/.test(item.name))
      if (!bedItem) throw fail('NO_BED', 'bed was not crafted')
      return bedItem.name
    }
    async function placeBedInside(bedName) {
      const camp = state.camp
      if (!camp) throw fail('NO_CAMP', 'the shelter must exist before the bed')
      const room = camp.room
      const runs = []
      for (let x = room.min.x; x <= room.max.x; x += 1) {
        for (let z = room.min.z; z <= room.max.z; z += 1) {
          const here = nameAt(x, room.min.y, z)
          const below = nameAt(x, room.min.y - 1, z)
          if (!isAir(here)) continue
          if (!isSolid(below)) continue
          for (const dir of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
            const nx = x + dir.x
            const nz = z + dir.z
            if (nx < room.min.x || nx > room.max.x || nz < room.min.z || nz > room.max.z) continue
            const next = nameAt(nx, room.min.y, nz)
            const nextBelow = nameAt(nx, room.min.y - 1, nz)
            if (!isAir(next) || !isSolid(nextBelow)) continue
            runs.push({ foot: { x: x, y: room.min.y, z: z }, head: { x: nx, y: room.min.y, z: nz } })
          }
        }
      }
      if (!runs.length) throw fail('NO_BED_SPACE', 'no 2-cell space inside the room')
      const inside = p => p.x >= room.min.x && p.x <= room.max.x && p.z >= room.min.z && p.z <= room.max.z
      for (const run of runs) {
        checkStop()
        const existing = nameAt(run.foot.x, run.foot.y, run.foot.z)
        if (bedName === existing) {
          const other = nameAt(run.head.x, run.head.y, run.head.z)
          if (other === bedName && inside(run.head)) {
            const bedCells = [{ x: run.foot.x, y: run.foot.y, z: run.foot.z }, { x: run.head.x, y: run.head.y, z: run.head.z }]
            state.bed = { cells: bedCells, placedAt: now() }
            evidence.bed = state.bed
            return bedCells
          }
          continue
        }
        if (isSolid(existing)) continue
        const stand = { x: run.head.x + 0.5, y: run.head.y, z: run.head.z + 0.5 }
        await approach(stand.x, stand.y, stand.z, 0.9, 12000).catch(() => false)
        await equip(bedName)
        try { await guard(bot.lookAt(new Vec3(run.head.x + 0.5, run.head.y + 0.5, run.head.z + 0.5), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
        const ref = at(run.foot.x, run.foot.y - 1, run.foot.z)
        if (ref === null || !isSolid(ref.name)) continue
        try { await guard(bot.placeBlock(ref, new Vec3(0, 1, 0)), 5000, 'PLACE_TIMEOUT') } catch (error) { log('bed place error: ' + String(error && error.message)); continue }
        await sleep(250)
        const footNow = nameAt(run.foot.x, run.foot.y, run.foot.z)
        if (footNow !== bedName) continue
        let headNow = null
        for (const dir of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
          const name = nameAt(run.foot.x + dir.x, run.foot.y, run.foot.z + dir.z)
          if (name === bedName) headNow = { x: run.foot.x + dir.x, y: run.foot.y, z: run.foot.z + dir.z }
        }
        if (headNow === null) {
          await awaitdigCell(run.foot.x, run.foot.y, run.foot.z)
          continue
        }
        if (inside(headNow)) {
          const bedCells = [{ x: run.foot.x, y: run.foot.y, z: run.foot.z }, headNow]
          state.bed = { cells: bedCells, placedAt: now() }
          evidence.bed = state.bed
          return bedCells
        }
        for (const cellPos of [{ x: run.foot.x, y: run.foot.y, z: run.foot.z }, headNow]) {
          const name = nameAt(cellPos.x, cellPos.y, cellPos.z)
          if (name === bedName) {
            try { await dig(cellPos.x, cellPos.y, cellPos.z) } catch (error) { if (error && error.code === 'OP_CANCELLED') throw error }
          }
        }
        await collectDrops(4)
        await equip(bedName).catch(() => {})
      }
      throw fail('BED_PLACE_FAILED', 'could not place the bed inside the room')
    }
    async function awaitdigCell(x, y, z) {
      try { await dig(x, y, z) } catch (error) { if (error && error.code === 'OP_CANCELLED') throw error }
    }
    async function sleepUntilMorning(bedCells) {
      const bedBlock = at(bedCells[0].x, bedCells[0].y, bedCells[0].z) || at(bedCells[1].x, bedCells[1].y, bedCells[1].z)
      if (bedBlock === null) throw fail('NO_BED_BLOCK', 'bed block disappeared')
      let attempts = 0
      while (true) {
        checkStop()
        attempts += 1
        if (attempts > 320) throw fail('SLEEP_TIMEOUT', 'could not sleep')
        const t = bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : 0
        if (bot.isSleeping === true) break
        if (t >= 12541 && t <= 23458) {
          try {
            await guard(bot.sleep(bedBlock), 12000, 'SLEEP_CALL_TIMEOUT')
            await sleep(400)
            if (bot.isSleeping === true) break
          } catch (error) {
            log('sleep attempt failed: ' + String(error && error.message))
            await sleep(1500)
            continue
          }
        } else {
          await eatIfNeeded()
          await sleep(2000)
          continue
        }
      }
      const sleptAt = now()
      event('sleep', { at: sleptAt, timeOfDay: bot.time.timeOfDay })
      const began = now()
      while (now() - began < 45000) {
        checkStop()
        if (bot.isSleeping !== true) break
        await sleep(200)
      }
      await sleep(500)
      event('wake', { at: now(), timeOfDay: bot.time.timeOfDay, isSleeping: bot.isSleeping })
      state.lastSleepBed = { cells: bedCells, at: sleptAt }
      return { sleptAt: sleptAt, timeOfDay: bot.time.timeOfDay }
    }
    async function respawnReadback(bedCells) {
      const before = positionSnapshot()
      note('respawn-test-start', before)
      const deaths = []
      const onDeath = () => { deaths.push({ at: now(), position: positionSnapshot() }) }
      try { bot.on('death', onDeath) } catch (error) { /* ignore */ }
      try {
        const spot = freeSpotNear(6, (x, y, z) => {
          const camp = state.camp
          if (!camp) return false
          const room = camp.room
          return x >= room.min.x - 3 && x <= room.max.x + 2
            && z >= room.min.z - 1 && z <= room.max.z + 1
            && y >= room.min.y - 2 && y <= room.max.y + 3
        })
        if (spot === null) throw fail('NO_PILLAR_SPOT', 'no free spot near the shelter')
        const ok = await approach(spot.x + 0.5, spot.y + 1.05, spot.z + 0.5, 0.7, 20000)
        if (!ok) throw fail('NO_PILLAR_SPOT', 'cannot reach the pillar spot')
        const blockNames = ['cobblestone', 'dirt', 'stone', 'andesite', 'granite', 'diorite', 'tuff']
        const totalBlocks = () => { let n = 0; for (const name of blockNames) n += count(name); return n }
        if (totalBlocks() < 34) {
          try { await collectCobble(34) } catch (error) { if (error && error.code === 'OP_CANCELLED') throw error }
        }
        let pillarItem = blockNames.find(name => count(name) > 0)
        if (pillarItem === undefined) throw fail('NO_PILLAR_BLOCKS', 'no blocks to pillar with')
        await equip(pillarItem)
        const startY = Math.floor(bot.entity.position.y)
        let built = 0
        for (let i = 0; i < 38; i += 1) {
          checkStop()
          if (bot.health !== undefined && bot.health <= 0) break
          const p = bot.entity.position
          const x = Math.floor(p.x)
          const y = Math.floor(p.y)
          const z = Math.floor(p.z)
          const support = at(x, y - 1, z)
          if (support === null || !isSolid(support.name)) break
          if (count(pillarItem) <= 0) {
            const nextItem = blockNames.find(name => count(name) > 0)
            if (nextItem === undefined) break
            pillarItem = nextItem
            await equip(pillarItem)
          }
          bot.setControlState('jump', true)
          const deadline = now() + 1500
          while (bot.entity.position.y < y + 1.05 && now() < deadline) await sleep(10)
          bot.setControlState('jump', false)
          if (bot.entity.position.y < y + 1.0) { await sleep(150); continue }
          try {
            await guard(bot.placeBlock(support, new Vec3(0, 1, 0)), 5000, 'PLACE_TIMEOUT')
            await sleep(110)
            const placedName = nameAt(x, y, z)
            if (placedName !== null && !isAir(placedName)) built += 1
          } catch (error) {
            if (error && error.code === 'OP_CANCELLED') throw error
          }
          const landDeadline = now() + 1200
          while (bot.entity.position.y < y + 0.99 && now() < landDeadline) await sleep(10)
          if (built >= 36) break
        }
        note('pillar-built', { blocks: built, y: bot.entity.position.y, startY: startY })
        if (built < 30) throw fail('PILLAR_TOO_SHORT', 'pillar only reached ' + built + ' blocks')
        try { await guard(bot.lookAt(new Vec3(bot.entity.position.x + 3, bot.entity.position.y, bot.entity.position.z), true), 2000, 'LOOK_TIMEOUT') } catch (e) { /* ignore */ }
        bot.setControlState('forward', true)
        await sleep(900)
        bot.setControlState('forward', false)
        const began = now()
        let died = false
        while (now() - began < 20000) {
          checkStop()
          if (deaths.length > 0) { died = true; break }
          if (bot.health !== undefined && bot.health <= 0) { died = true; break }
          await sleep(120)
        }
        if (!died) throw fail('DEATH_NOT_REACHED', 'the fall did not kill the bot')
        const deathPos = deaths.length > 0 ? deaths[0] : positionSnapshot()
        event('death', deathPos)
        const respawnBegan = now()
        let respawned = false
        while (now() - respawnBegan < 20000) {
          checkStop()
          if (bot.health !== undefined && bot.health > 0 && bot.entity.position.y > 20) { respawned = true; break }
          try { bot.respawn() } catch (error) { /* already respawning */ }
          await sleep(400)
        }
        if (!respawned) throw fail('RESPAWN_FAILED', 'the bot did not respawn')
        await sleep(800)
        const after = positionSnapshot()
        const rc = cell()
        let okBed = false
        for (const bedCell of bedCells) {
          if (Math.abs(rc.x - bedCell.x) <= 1 && Math.abs(rc.z - bedCell.z) <= 1 && Math.abs(rc.y - bedCell.y) <= 1) okBed = true
        }
        const worldSpawn = bot.spawnPoint ? { x: bot.spawnPoint.x, y: bot.spawnPoint.y, z: bot.spawnPoint.z } : null
        const result = {
          ok: okBed,
          position: [rc.x, rc.y, rc.z],
          exact: after,
          bedCells: bedCells,
          worldSpawn: worldSpawn,
          deathPosition: deathPos,
          at: now(),
        }
        state.respawnCheck = result
        evidence.respawn = result
        event('respawn', result)
        return result
      } finally {
        try { bot.removeListener('death', onDeath) } catch (error) { /* ignore */ }
      }
    }

    // ------------------------------------------------------------------ stages
    async function stageShelter() {
      // 5 logs -> 20 planks: table 4 + pickaxe 3 + sticks 2 + door 6 = 15,
      // leaving one log for charcoal and planks for fuel.
      await ensureLogs(5)
      await ensurePlanks(15)
      if (count('crafting_table') === 0 && tableNearby() === null) {
        await craft('crafting_table', 1)
      }
      if (tableNearby() === null) {
        const spot = freeSpotNear(4)
        if (spot === null) throw fail('NO_TABLE_SPOT', 'no place for the crafting table')
        await place(spot.x, spot.y, spot.z, 'crafting_table', 'up')
        note('table-placed', spot)
      }
      await ensureSticks(4)
      if (countLike(/^wooden_pickaxe$/) === 0) await craft('wooden_pickaxe', 1)
      if (countLike(/_door$/) === 0) {
        const plank = items().find(item => /_planks$/.test(item.name))
        if (!plank) throw fail('NO_DOOR', 'no planks for the door')
        await ensurePlanks(6)
        await craft(plank.name.replace('_planks', '_door'), 1)
      }
      if (count('coal') + count('charcoal') === 0) {
        const coalDef = bot.registry.blocksByName['coal_ore']
        if (coalDef !== undefined) {
          const found = bot.findBlocks({ matching: coalDef.id, maxDistance: 24, count: 4 })
          for (const point of found.slice(0, 2)) {
            checkStop()
            try {
              if (await pathTo(point.x, point.y, point.z, 2.0, 20000)) {
                await dig(point.x, point.y, point.z)
                await collectDrops(5)
                if (count('coal') > 0) break
              }
            } catch (error) { if (error && error.code === 'OP_CANCELLED') throw error }
          }
        }
      }
      if (count('coal') + count('charcoal') === 0 && count('cobblestone') < 8) {
        await collectCobble(8)
      }
      const site = chooseShelterSite()
      if (site === null) throw fail('NO_SHELTER_SITE', 'no suitable shelter site nearby')
      return await buildShelter(site)
    }
    function findFurnaceNear() {
      for (const name of ['furnace', 'blast_furnace', 'smoker']) {
        const def = bot.registry.blocksByName[name]
        if (def === undefined) continue
        const found = bot.findBlocks({ matching: def.id, maxDistance: 8, count: 1 })
        if (found.length) return at(found[0].x, found[0].y, found[0].z)
      }
      return null
    }

    async function stageBed() {
      await leaveShelter()
      await ensureWool(3)
      await ensurePlanks(3)
      await enterShelter()
      const bedName = await ensureBed()
      const bedCells = await placeBedInside(bedName)
      note('bed-placed', { cells: bedCells })
      await setDoor(false)
      await eatIfNeeded()
      const sleepInfo = await sleepUntilMorning(bedCells)
      evidence.sleep = sleepInfo
      await sleep(500)
      await leaveShelter()
      const respawn = await respawnReadback(bedCells)
      evidence.inventory = inventorySnapshot()
      evidence.position = positionSnapshot()
      evidence.time = timeSnapshot()
      evidence.blocks = []
      for (let x = state.camp.room.min.x - 1; x <= state.camp.room.max.x + 1; x += 1) {
        for (let z = state.camp.room.min.z - 1; z <= state.camp.room.max.z + 1; z += 1) {
          for (let y = state.camp.room.min.y - 1; y <= state.camp.room.max.y + 1; y += 1) {
            evidence.blocks.push({ x: x, y: y, z: z, name: nameAt(x, y, z) })
          }
        }
      }
      if (!respawn.ok) throw fail('SPAWN_NOT_BED', 'respawn point is not the bed', respawn)
      return evidence
    }

    async function stageTools() {
      const camp = state.camp
      if (!camp) throw fail('NO_CAMP', 'build the shelter before the tools')
      await leaveShelter()
      await collectCobble(8)
      await enterShelter()
      await ensureSticks(5)
      await ensurePlanks(3)
      const wanted = ['stone_pickaxe', 'stone_axe', 'stone_sword']
      evidence.crafted = []
      for (const name of wanted) {
        checkStop()
        if (count(name) > 0) continue
        const before = count(name)
        await craft(name, 1)
        evidence.crafted.push({ item: name, at: now(), before: before, after: count(name) })
      }
      evidence.inventory = inventorySnapshot()
      evidence.position = positionSnapshot()
      evidence.time = timeSnapshot()
      const ok = count('stone_pickaxe') > 0 && count('stone_axe') > 0 && count('stone_sword') > 0
      if (!ok) throw fail('TOOLS_INCOMPLETE', 'not all three stone tools are in the inventory')
      return evidence
    }

    async function stageCopper() {
      await leaveShelter()
      // scan for copper at increasing radius; if none loaded, dig a stair down.
      let target = null
      let scanned = 0
      for (let attempt = 0; attempt < 14 && target === null; attempt += 1) {
        checkStop()
        const ids = []
        for (const name of ['copper_ore', 'deepslate_copper_ore']) {
          const def = bot.registry.blocksByName[name]
          if (def !== undefined) ids.push(def.id)
        }
        const found = bot.findBlocks({ matching: block => ids.indexOf(block.type) >= 0, maxDistance: 48, count: 12 })
        scanned = found.length
        if (found.length) {
          let best = null
          let bestD = 1e9
          for (const point of found) {
            const d = dist(feet(), point)
            if (d < bestD) { bestD = d; best = point }
          }
          target = { x: best.x, y: best.y, z: best.z }
          break
        }
        // dig one stair step toward a descending direction and rescan
        const c = cell()
        const dirs = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }]
        let dug = false
        for (const dir of dirs) {
          try {
            await digStepDown(dir.x, dir.z)
            dug = true
            break
          } catch (error) {
            if (error && error.code === 'OP_CANCELLED') throw error
          }
        }
        if (!dug) throw fail('COPPER_DESCENT_BLOCKED', 'cannot dig deeper')
        await eatIfNeeded()
      }
      if (target === null) throw fail('COPPER_NOT_FOUND', 'no copper ore found after ' + scanned + ' scans')
      note('copper-target', target)
      // tunnel to the ore: descend / approach in stair steps, then dig it
      let guard = 0
      while (dist(feet(), { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }) > 3.2) {
        checkStop()
        guard += 1
        if (guard > 120) throw fail('COPPER_TUNNEL_STUCK', 'could not get to the copper ore')
        const p = feet()
        const dx = target.x + 0.5 - p.x
        const dz = target.z + 0.5 - p.z
        const dy = target.y + 0.5 - p.y
        if (dy < -1.2) {
          const dir = Math.abs(dx) >= Math.abs(dz) ? { x: dx > 0 ? 1 : -1, z: 0 } : { x: 0, z: dz > 0 ? 1 : -1 }
          await digStepDown(dir.x, dir.z)
        } else {
          // horizontal tunnel toward the target
          const dir = Math.abs(dx) >= Math.abs(dz) ? { x: dx > 0 ? 1 : -1, z: 0 } : { x: 0, z: dz > 0 ? 1 : -1 }
          const c = cell()
          const nx = c.x + dir.x
          const nz = c.z + dir.z
          await dig(nx, c.y + 1, nz)
          await dig(nx, c.y, nz)
          if (!isSolid(nameAt(nx, c.y - 1, nz))) await dig(nx, c.y - 1, nz)
          await walkTo(dir.x, dir.z, nx, nz, 2500)
        }
        await eatIfNeeded()
      }
      const ore = at(target.x, target.y, target.z)
      if (ore === null) throw fail('COPPER_BLOCK_GONE', 'copper block disappeared')
      const blockBefore = { x: target.x, y: target.y, z: target.z, name: ore.name }
      const before = inventorySnapshot()
      await dig(target.x, target.y, target.z)
      await collectDrops(8)
      const afterBlock = nameAt(target.x, target.y, target.z)
      const after = inventorySnapshot()
      evidence.copper = {
        blockBefore: blockBefore,
        blockAfter: afterBlock,
        inventoryBefore: before,
        inventoryAfter: after,
        rawCopper: count('raw_copper'),
        copperOre: count('copper_ore'),
      }
      evidence.position = positionSnapshot()
      evidence.time = timeSnapshot()
      note('copper-done', evidence.copper)
      if (count('raw_copper') + count('copper_ore') < 1) throw fail('NO_COPPER_DROP', 'copper ore was mined but no raw copper/copper ore was collected')
      if (afterBlock !== null && /copper_ore$/.test(afterBlock) === false) {
        // expected: the block is now air
      }
      return evidence
    }

    async function stageSmelt() {
      const camp = state.camp
      if (!camp) throw fail('NO_CAMP', 'no camp for smelting')
      if (count('raw_copper') + count('copper_ore') < 1) throw fail('NO_COPPER', 'nothing to smelt')
      await enterShelter()
      if (count('cobblestone') < 8) {
        await leaveShelter()
        await collectCobble(8)
        await enterShelter()
      }
      let table = tableNearby()
      if (table === null) {
        if (count('crafting_table') === 0) {
          await ensurePlanks(4)
          await craft('crafting_table', 1)
        }
        const spot = freeSpotNear(3)
        if (spot !== null) await place(spot.x, spot.y, spot.z, 'crafting_table', 'up')
        table = tableNearby()
      }
      if (count('furnace') === 0) await craft('furnace', 1)
      let furnaceBlock = findFurnaceNear()
      if (furnaceBlock === null) {
        const spot = freeSpotNear(3)
        if (spot === null) throw fail('NO_FURNACE_SPOT', 'no place for the furnace')
        await place(spot.x, spot.y, spot.z, 'furnace', 'up')
        furnaceBlock = findFurnaceNear()
      }
      if (furnaceBlock === null) throw fail('NO_FURNACE', 'no furnace placed')
      const inputName = count('raw_copper') > 0 ? 'raw_copper' : 'copper_ore'
      const before = inventorySnapshot()
      const furnace = await guard(bot.openFurnace(furnaceBlock), 10000, 'FURNACE_TIMEOUT')
      let smelted = null
      try {
        // fuel: coal, charcoal or planks
        const fuelItem = items().find(item => item.name === 'coal' || item.name === 'charcoal')
          || items().find(item => /_planks$/.test(item.name))
          || items().find(item => /(_log|_stem|_wood|_hyphae)$/.test(item.name))
        if (!fuelItem) throw fail('NO_FUEL', 'no fuel for the furnace')
        await furnace.putFuel(itemId(fuelItem.name), null, 1)
        await sleep(300)
        const inputItem = findItem(inputName)
        if (!inputItem) throw fail('NO_INPUT', 'no ' + inputName)
        await furnace.putInput(itemId(inputName), null, 1)
        await sleep(500)
        const began = now()
        while (now() - began < 30000) {
          checkStop()
          await sleep(1000)
          const output = furnace.outputItem()
          if (output) {
            smelted = { item: output.name, count: output.count, at: now() }
            break
          }
          await eatIfNeeded()
        }
        if (smelted === null) throw fail('SMELT_TIMEOUT', 'the furnace produced nothing in time')
        const taken = await furnace.takeOutput()
        if (!taken) throw fail('TAKE_OUTPUT_FAILED', 'could not take the furnace output')
        smelted.taken = { item: taken.name, count: taken.count }
      } finally {
        await furnace.close().catch(() => {})
      }
      const after = inventorySnapshot()
      evidence.smelt = {
        furnace: { x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z },
        fuel: null,
        input: inputName,
        smelted: smelted,
        inventoryBefore: before,
        inventoryAfter: after,
      }
      evidence.inventory = inventorySnapshot()
      evidence.position = positionSnapshot()
      evidence.time = timeSnapshot()
      evidence.copperIngot = count('copper_ingot')
      note('smelt-done', { smelted: smelted, ingot: count('copper_ingot') })
      if (count('copper_ingot') < 1) throw fail('NO_INGOT', 'no copper ingot in the inventory')
      return evidence
    }

    // -------------------------------------------------------------------- run
    const heartbeat = setInterval(() => {
      if (stopped) return
      try {
        const step = evidence.steps.length ? evidence.steps[evidence.steps.length - 1].step : 'starting'
        if (host.debug) host.debug('[campaign-heartbeat] ' + JSON.stringify({ stage: stage, step: step, pos: feet(), elapsedMs: now() - startedAt }))
      } catch (error) { /* diagnostics are best effort */ }
    }, 3000)
    async function run() {
      checkStop()
      note('start', { stage: stage })
      await waitForWorldReady()
      try {
        await guard(unstick(), 4000, 'UNSTICK_TIMEOUT')
      } catch (error) {
        if (error && error.code === 'OP_CANCELLED') throw error
        log('unstick failed: ' + String(error && error.message))
      }
      if (stage === 'shelter') return await stageShelter()
      if (stage === 'bed') return await stageBed()
      if (stage === 'tools') return await stageTools()
      if (stage === 'copper') return await stageCopper()
      if (stage === 'smelt') return await stageSmelt()
      throw fail('BAD_ARGS', 'unknown campaign stage: ' + stage)
    }

    const handle = {
      poll: function () {
        if (outcome.status === 'running' && evidence.steps.length >= 0) {
          outcome.progress = { step: evidence.steps.length ? evidence.steps[evidence.steps.length - 1].step : 'starting' }
        }
        return outcome
      },
      stop: function () {
        if (stopped) return
        stopped = true
        try { clearInterval(heartbeat) } catch (e) { /* ignore */ }
        try { if (bot.pathfinder) bot.pathfinder.stop() } catch (e) { /* ignore */ }
        try { bot.clearControlStates() } catch (e) { /* ignore */ }
        try { bot.stopDigging() } catch (e) { /* ignore */ }
        try { bot.deactivateItem() } catch (e) { /* ignore */ }
      },
    }
    run().then(result => {
      try { clearInterval(heartbeat) } catch (e) { /* ignore */ }
      if (stopped) {
        outcome = { status: 'failed', error: { code: 'OP_CANCELLED', category: 'control', message: 'campaign was stopped' } }
        return
      }
      result.finishedAt = now()
      result.inventory = inventorySnapshot()
      result.position = positionSnapshot()
      result.time = timeSnapshot()
      try {
        const serialized = JSON.stringify(evidence)
        if (host.debug) host.debug('[campaign-evidence] ' + serialized)
      } catch (error) { /* evidence serialization is best effort */ }
      evidence.finishedAt = result.finishedAt === undefined ? now() : result.finishedAt
      result.inventory = inventorySnapshot()
      result.position = positionSnapshot()
      result.time = timeSnapshot()
      outcome = { status: 'succeeded', result: result }
      log('stage ' + stage + ' succeeded in ' + (now() - startedAt) + 'ms')
    }).catch(error => {
      try { clearInterval(heartbeat) } catch (e) { /* ignore */ }
      const code = error && error.code ? String(error.code) : 'CAMPAIGN_FAILED'
      const message = error && error.message ? String(error.message) : String(error)
      outcome = {
        status: 'failed',
        error: {
          code: code,
          category: error && error.category ? String(error.category) : 'runtime',
          message: message,
          ...(error && error.details === undefined ? {} : { details: error.details }),
        },
        result: evidence,
      }
      try {
        const serialized = JSON.stringify(evidence)
        if (host.debug) host.debug('[campaign-evidence] ' + serialized)
      } catch (serializedError) { /* ignore */ }
      log('stage ' + stage + ' failed: ' + code + ' ' + message)
    })
    return handle
  },
})




















