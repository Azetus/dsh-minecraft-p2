/**
 * M5.5 act: clear one stair step.
 *
 * Digs the foot-level block at (x, y, z) and the block directly above it,
 * giving a two-high passage. Only one dig is outstanding at a time: the next
 * dig is submitted from `update` after the previous one finished. After each
 * dig the target cell is read back, and only cells that are actually empty
 * count as dug. It never picks a direction or a depth; the behavior does that.
 */
defineAct({
  manifest: {
    id: 'dig-stair-step',
    description: 'Dig the foot-level block and the block above it at one stair-step position.',
    queryOps: ['block'],
    controlOps: ['dig', 'stop'],
    limits: { totalMs: 20000 },
  },
  create: function (rawArgs) {
    var args = rawArgs === null || typeof rawArgs !== 'object' ? {} : rawArgs
    var airNames = { air: true, cave_air: true, void_air: true }
    var phase = 'check'
    var digIndex = 0
    var dug = 0
    var attempts = 0
    var digHandle = null
    var verifyId = null
    var stopped = false
    var empty = [false, false]
    var checks = []

    function isEmpty(value) {
      if (value === null || value === undefined) return true
      if (typeof value !== 'object') return false
      return airNames[value.name] === true
    }

    function findResult(list, id) {
      if (id === null || id === undefined) return null
      for (var index = 0; index < list.length; index += 1) {
        if (list[index].id === id) return list[index]
      }
      return null
    }

    function cellAt(index) {
      return { x: args.x, y: args.y + index, z: args.z }
    }

    function startDig(ctx) {
      digHandle = ctx.control('dig', cellAt(digIndex))
      phase = 'dig'
    }

    function nextSolid() {
      var index = digIndex + 1
      while (index <= 1) {
        if (!empty[index]) return index
        index += 1
      }
      return -1
    }

    function result() {
      return { dug: dug, pos: { x: args.x, y: args.y, z: args.z } }
    }

    return {
      start: function (ctx) {
        if (typeof args.x !== 'number' || typeof args.y !== 'number' || typeof args.z !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'dig-stair-step requires pos {x,y,z}' } }
        }
        checks.push({ id: ctx.query('block', cellAt(0)), index: 0 })
        checks.push({ id: ctx.query('block', cellAt(1)), index: 1 })
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        var found = null
        var index
        if (phase === 'check') {
          for (index = 0; index < checks.length; index += 1) {
            found = findResult(list, checks[index].id)
            if (found === null) return { kind: 'running' }
            if (found.status === 'failed') return { kind: 'failed', error: found.error }
            empty[checks[index].index] = isEmpty(found.value)
          }
          if (empty[0] && empty[1]) {
            // The step is already cleared: idempotent success, nothing was dug.
            return { kind: 'complete', result: { dug: 0 } }
          }
          digIndex = empty[0] ? 1 : 0
          startDig(ctx)
          return { kind: 'running' }
        }
        if (phase === 'dig') {
          found = findResult(list, digHandle)
          if (found === null) return { kind: 'running' }
          if (found.status === 'failed') return { kind: 'failed', error: found.error }
          if (found.status !== 'ok') return { kind: 'running' }
          verifyId = ctx.query('block', cellAt(digIndex))
          phase = 'verify'
          return { kind: 'running' }
        }
        found = findResult(list, verifyId)
        if (found === null) return { kind: 'running' }
        if (found.status === 'failed') return { kind: 'failed', error: found.error }
        if (!isEmpty(found.value)) {
          // The dig reported success but the cell is still solid: retry once.
          if (attempts < 1) {
            attempts += 1
            startDig(ctx)
            return { kind: 'running' }
          }
          return { kind: 'failed', error: { code: 'DIG_INCOMPLETE', message: 'target cell is still solid after dig succeeded' } }
        }
        dug += 1
        attempts = 0
        verifyId = null
        var next = nextSolid()
        if (next < 0) return { kind: 'complete', result: result() }
        digIndex = next
        startDig(ctx)
        return { kind: 'running' }
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
