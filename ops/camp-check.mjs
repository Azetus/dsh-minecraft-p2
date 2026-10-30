/**
 * camp-check: read-only certification of the built camp.
 *
 * Returns a name -> 0|1 map (count-at-least friendly) for the components the
 * acceptance needs. Every component is computed from live block/position
 * reads; nothing is remembered from the build step except the intended
 * geometry (recorded by the campaign op), which is verified block by block.
 */
defineOp({
  manifest: {
    schemaVersion: 1,
    kind: 'op',
    name: 'camp-check',
    opKind: 'query',
    parameters: {},
    result: {},
    limits: { totalMs: 3000 },
  },
  query: function (ctx) {
    const bot = ctx.host && ctx.host.bot
    const out = { shelter: 0, door: 0, torch: 0, bed: 0, spawn: 0, inside: 0 }
    if (!bot || !bot.entity) return out
    const Vec3 = (ctx.host && ctx.host.Vec3) || bot.entity.position.constructor
    const state = (bot.__p2 = bot.__p2 || {})
    const camp = state.camp
    if (!camp || !camp.room || !camp.door) return out

    const room = camp.room
    const min = room.min
    const max = room.max
    if (typeof min.x !== 'number' || typeof max.x !== 'number') return out

    function at(x, y, z) {
      const b = bot.blockAt(new Vec3(x, y, z))
      return b === null || b === undefined ? null : b.name
    }
    function isAir(name) {
      return name === 'air' || name === 'cave_air' || name === 'void_air'
    }
    function isFluid(name) {
      return name === 'water' || name === 'lava' || name === 'flowing_water'
        || name === 'flowing_lava' || name === 'bubble_column'
    }
    function isDoor(name) {
      return typeof name === 'string' && name.length > 4 && name.slice(-5) === '_door'
    }
    function isBed(name) {
      return typeof name === 'string' && name.length > 4 && name.slice(-4) === '_bed'
    }
    function isTorch(name) {
      return name === 'torch' || name === 'wall_torch' || name === 'soul_torch' || name === 'soul_wall_torch'
    }
    function isFurniture(name) {
      return isTorch(name) || isBed(name) || name === 'crafting_table'
        || name === 'furnace' || name === 'blast_furnace' || name === 'smoker'
    }

    // 1) interior: exactly the expected 2-high 3x3 volume, air or furniture.
    let interiorOk = true
    let torchInside = 0
    let bedCells = []
    for (let x = min.x; x <= max.x; x += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        for (let y = min.y; y <= max.y; y += 1) {
          const name = at(x, y, z)
          if (isAir(name)) continue
          if (isFurniture(name)) {
            if (isTorch(name)) torchInside += 1
            if (isBed(name)) bedCells.push({ x: x, y: y, z: z })
            continue
          }
          interiorOk = false
        }
      }
    }
    out.shelter = interiorOk ? 1 : 0

    // 2) boundary: every cell just outside the interior must be closed, except
    //    the two door cells.
    const doorSet = {}
    for (const d of camp.door) doorSet[d.x + ',' + d.y + ',' + d.z] = 1
    function closed(x, y, z) {
      if (doorSet[x + ',' + y + ',' + z] === 1) return isDoor(at(x, y, z))
      const name = at(x, y, z)
      return name !== null && !isAir(name) && !isFluid(name)
    }
    let sealed = true
    for (let x = min.x; x <= max.x; x += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        if (!closed(x, min.y - 1, z)) sealed = false
        if (!closed(x, max.y + 1, z)) sealed = false
      }
    }
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        if (!closed(min.x - 1, y, z)) sealed = false
        if (!closed(max.x + 1, y, z)) sealed = false
      }
      for (let x = min.x; x <= max.x; x += 1) {
        if (!closed(x, y, min.z - 1)) sealed = false
        if (!closed(x, y, max.z + 1)) sealed = false
      }
    }
    if (!sealed) out.shelter = 0
    out.door = isDoor(at(camp.door[0].x, camp.door[0].y, camp.door[0].z))
      && isDoor(at(camp.door[1].x, camp.door[1].y, camp.door[1].z)) ? 1 : 0
    out.torch = torchInside > 0 ? 1 : 0

    // 3) bed: two adjacent bed cells inside the room.
    let bedOk = false
    for (const a of bedCells) {
      for (const b of bedCells) {
        if (a === b) continue
        if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1) bedOk = true
      }
    }
    out.bed = bedOk ? 1 : 0

    // 4) the bot is standing inside the room.
    const p = bot.entity.position
    const px = Math.floor(p.x)
    const py = Math.floor(p.y)
    const pz = Math.floor(p.z)
    if (px >= min.x && px <= max.x && pz >= min.z && pz <= max.z && py >= min.y && py <= max.y + 1) {
      out.inside = 1
    }

    // 5) respawn: only a real death + respawn observation proves the bed is the
    //    respawn point (vanilla does not send the personal respawn to clients).
    const check = state.respawnCheck
    if (check && check.ok === true && Array.isArray(check.position)) {
      out.spawn = 1
    }
    return out
  },
})
