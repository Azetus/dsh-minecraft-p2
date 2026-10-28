/**
 * Built-in act: place one block.
 *
 * The act examines the target and its six neighbours, picks a supporting face
 * locally, optionally equips the requested item, then submits one `place` op.
 * It does not decide what to build.
 */
defineAct({
  manifest: {
    id: 'place-block',
    description: 'Place one block at a target position, choosing a supporting face.',
    queryOps: ['block'],
    controlOps: ['equip', 'place', 'stop'],
    limits: { totalMs: 10000 },
  },
  create: function (args) {
    var faces = ['up', 'north', 'south', 'east', 'west', 'down']
    var vectors = {
      up: [0, 1, 0],
      down: [0, -1, 0],
      north: [0, 0, -1],
      south: [0, 0, 1],
      east: [1, 0, 0],
      west: [-1, 0, 0],
    }
    var phase = 'query'
    var pending = []
    var targetId = null
    var chosenFace = null
    var active = null
    var stopped = false

    function isAir(value) {
      if (value === null || value === undefined) return true
      return value.name === 'air' || value.name === 'cave_air' || value.name === 'void_air'
    }

    function findResult(list, id) {
      for (var index = 0; index < list.length; index += 1) {
        if (list[index].id === id) return list[index]
      }
      return null
    }

    function startPlace(ctx) {
      active = ctx.control('place', {
        x: args.pos.x,
        y: args.pos.y,
        z: args.pos.z,
        face: chosenFace,
      })
      phase = 'place'
    }

    return {
      start: function (ctx) {
        var pos = args.pos
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'place-block requires pos {x,y,z}' } }
        }
        targetId = ctx.query('block', { x: pos.x, y: pos.y, z: pos.z })
        pending.push({ id: targetId, kind: 'target' })
        for (var index = 0; index < faces.length; index += 1) {
          var face = faces[index]
          var vector = vectors[face]
          pending.push({
            id: ctx.query('block', { x: pos.x - vector[0], y: pos.y - vector[1], z: pos.z - vector[2] }),
            kind: 'support',
            face: face,
          })
        }
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        if (phase === 'query') {
          for (var check = 0; check < pending.length; check += 1) {
            if (findResult(list, pending[check].id) === null) return { kind: 'running' }
          }
          var target = findResult(list, targetId)
          if (target.status === 'failed') return { kind: 'failed', error: target.error }
          if (!isAir(target.value)) {
            return { kind: 'failed', error: { code: 'PLACE_UNSUPPORTED', message: 'target position is occupied' } }
          }
          for (var support = 0; support < pending.length; support += 1) {
            var entry = pending[support]
            if (entry.kind !== 'support') continue
            var result = findResult(list, entry.id)
            if (result.status === 'failed') return { kind: 'failed', error: result.error }
            if (!isAir(result.value)) {
              chosenFace = entry.face
              break
            }
          }
          if (chosenFace === null) {
            return { kind: 'failed', error: { code: 'PLACE_UNSUPPORTED', message: 'no supporting block adjacent to the target' } }
          }
          if (typeof args.item === 'string' && args.item.length > 0) {
            active = ctx.control('equip', { item: args.item, destination: 'hand' })
            phase = 'equip'
          } else {
            startPlace(ctx)
          }
          return { kind: 'running' }
        }
        var result = active === null ? null : findResult(list, active)
        if (result === null) return { kind: 'running' }
        if (result.status === 'failed') return { kind: 'failed', error: result.error }
        if (phase === 'equip') {
          startPlace(ctx)
          return { kind: 'running' }
        }
        return { kind: 'complete', result: result.value === undefined ? null : result.value }
      },
      stop: function (ctx) {
        if (!stopped) {
          stopped = true
          if (active !== null) ctx.control('stop', {})
        }
        return { kind: 'running' }
      },
      cleanup: function () {
        return { kind: 'complete' }
      },
    }
  },
})
