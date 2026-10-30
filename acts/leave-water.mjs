/**
 * Escape a 1-deep water hole: jump onto the rim, then step backwards.
 * Content act: the strategy decides when water is dangerous.
 */
defineAct({
  manifest: {
    id: 'leave-water',
    description: 'Jump out of shallow water and step back onto solid ground.',
    queryOps: [],
    controlOps: ['move', 'back', 'stop'],
    limits: { totalMs: 6000 },
  },
  create: function () {
    var jump = null
    var back = null
    var phase = 'jump'
    var stopped = false
    function find(list, id) {
      for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i]
      return null
    }
    return {
      start: function (ctx) {
        jump = ctx.control('move', { direction: 'jump', durationMs: 350 })
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        var item = jump === null ? null : find(list, jump)
        if (item !== null && item.status === 'failed') return { kind: 'failed', error: item.error }
        if (phase === 'jump' && item !== null && item.status === 'ok') {
          phase = 'back'
          back = ctx.control('back', { durationMs: 1200 })
          return { kind: 'running' }
        }
        var backItem = back === null ? null : find(list, back)
        if (backItem !== null && backItem.status === 'failed') return { kind: 'failed', error: backItem.error }
        if (phase === 'back' && backItem !== null && backItem.status === 'ok') {
          return { kind: 'complete', result: { left: true } }
        }
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
