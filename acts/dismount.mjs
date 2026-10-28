/** Built-in act: leave the current vehicle. */
defineAct({
  manifest: {
    id: 'dismount',
    description: 'Dismount the current vehicle and report the result.',
    queryOps: [],
    controlOps: ['dismount', 'stop'],
    limits: { totalMs: 5000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        handle = ctx.control('dismount', {})
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
