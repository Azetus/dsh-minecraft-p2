/**
 * Escape water at a bank: alternate a short jump with a step backwards, so the
 * bot can climb one- or two-block shores instead of only the pool rim.
 */
defineAct({
  manifest: {
    id: 'leave-water',
    description: 'Jump and step back in cycles to climb out of water.',
    queryOps: [],
    controlOps: ['move', 'back', 'stop'],
    limits: { totalMs: 8000 },
  },
  create: function () {
    var handle = null
    var phase = 'jump'
    var cycles = 0
    var stopped = false
    function find(list, id) {
      for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i]
      return null
    }
    function startJump(ctx) {
      phase = 'jump'
      handle = ctx.control('move', { direction: 'jump', durationMs: 350 })
    }
    function startBack(ctx) {
      phase = 'back'
      handle = ctx.control('back', { durationMs: 700 })
    }
    return {
      start: function (ctx) {
        startJump(ctx)
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        var item = handle === null ? null : find(list, handle)
        if (item === null) return { kind: 'running' }
        if (item.status === 'failed') return { kind: 'failed', error: item.error }
        if (item.status !== 'ok') return { kind: 'running' }
        if (phase === 'jump') {
          startBack(ctx)
          return { kind: 'running' }
        }
        cycles += 1
        if (cycles >= 4) return { kind: 'complete', result: { left: true } }
        startJump(ctx)
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
