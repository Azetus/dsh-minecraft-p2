/**
 * Built-in act: sleep in a bed.
 *
 * With an explicit position the act submits `sleep` directly. Without one it
 * asks for the nearest bed block, picks the closest result locally, then
 * submits `sleep` at that bed.
 */
defineAct({
  manifest: {
    id: 'sleep',
    description: 'Sleep in a bed, using the nearest bed when no position is given.',
    queryOps: ['blocks'],
    controlOps: ['sleep', 'stop'],
    limits: { totalMs: 120000 },
  },
  create: function (args) {
    var beds = [
      'white_bed',
      'orange_bed',
      'magenta_bed',
      'light_blue_bed',
      'yellow_bed',
      'lime_bed',
      'pink_bed',
      'gray_bed',
      'light_gray_bed',
      'cyan_bed',
      'purple_bed',
      'blue_bed',
      'brown_bed',
      'green_bed',
      'red_bed',
      'black_bed',
    ]
    var phase = 'query'
    var queryHandle = null
    var sleepHandle = null
    var stopped = false

    function isList(value) {
      return typeof value === 'object' && value !== null && typeof value.length === 'number'
    }

    function nearest(list) {
      var best = null
      for (var index = 0; index < list.length; index += 1) {
        var entry = list[index]
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.x !== 'number' || typeof entry.y !== 'number' || typeof entry.z !== 'number') continue
        if (best === null) {
          best = entry
          continue
        }
        var distance = typeof entry.distance === 'number' ? entry.distance : null
        var bestDistance = typeof best.distance === 'number' ? best.distance : null
        if (distance !== null && (bestDistance === null || distance < bestDistance)) best = entry
      }
      return best
    }

    function startSleep(ctx, x, y, z) {
      sleepHandle = ctx.control('sleep', { x: x, y: y, z: z })
      phase = 'sleep'
    }

    return {
      start: function (ctx) {
        if (args.pos !== undefined) {
          var pos = args.pos
          if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'sleep pos must be a block position {x,y,z}' } }
          }
          startSleep(ctx, pos.x, pos.y, pos.z)
          return { kind: 'running' }
        }
        queryHandle = ctx.query('blocks', { names: beds, radius: 16, count: 1 })
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        var current = phase === 'query' ? queryHandle : sleepHandle
        var found = null
        for (var index = 0; index < list.length; index += 1) {
          if (list[index].id !== current) continue
          found = list[index]
          break
        }
        if (found === null) return { kind: 'running' }
        if (found.status === 'failed') return { kind: 'failed', error: found.error }
        if (found.status !== 'ok') return { kind: 'running' }
        if (phase === 'query') {
          var value = found.value
          if (!isList(value) || value.length === 0) {
            return { kind: 'failed', error: { code: 'SLEEP_NO_BED', message: 'no bed was found within 16 blocks' } }
          }
          var bed = nearest(value)
          if (bed === null) {
            return { kind: 'failed', error: { code: 'SLEEP_NO_BED', message: 'no bed with a usable position was found' } }
          }
          startSleep(ctx, bed.x, bed.y, bed.z)
          return { kind: 'running' }
        }
        return { kind: 'complete', result: found.value === undefined ? null : found.value }
      },
      stop: function (ctx) {
        if (!stopped) {
          stopped = true
          ctx.control('stop', {})
        }
        return { kind: 'running' }
      },
      cleanup: function () {
        return { kind: 'complete' }
      },
    }
  },
})
