/** Built-in act: respawn after death. */
defineAct({
  manifest: {
    id: 'respawn',
    description: 'Respawn after death and report the new position.',
    queryOps: [],
    controlOps: ['respawn', 'stop'],
    limits: { totalMs: 30000 },
  },
  create: function () {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        handle = ctx.control('respawn', {})
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
