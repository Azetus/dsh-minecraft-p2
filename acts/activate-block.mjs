/** Built-in act: right-click one block position. */
defineAct({
  manifest: {
    id: 'activate-block',
    description: 'Activate the block at an exact position.',
    queryOps: [],
    controlOps: ['activate', 'stop'],
    limits: { totalMs: 5000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof a.x !== 'number' || typeof a.y !== 'number' || typeof a.z !== 'number') {
          return {
            kind: 'failed',
            error: { code: 'BAD_ARGS', message: 'activate-block requires numeric x, y and z' },
          }
        }
        handle = ctx.control('activate', { x: a.x, y: a.y, z: a.z })
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
