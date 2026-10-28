/** Built-in act: use the held item once (eat, drink or activate). */
defineAct({
  manifest: {
    id: 'use-item',
    description: 'Use the held item for a bounded duration, then release it.',
    queryOps: [],
    controlOps: ['use', 'stop'],
    limits: { totalMs: 10000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        var request = {}
        if (typeof args.durationMs === 'number') request.durationMs = args.durationMs
        if (args.offhand === true) request.offhand = true
        handle = ctx.control('use', request)
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        for (var index = 0; index < list.length; index += 1) {
          var item = list[index]
          if (item.id !== handle) continue
          if (item.status === 'ok') return { kind: 'complete', result: item.value === undefined ? null : item.value }
          if (item.status === 'failed') return { kind: 'failed', error: item.error }
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
