/** Built-in act: clear one equipment slot. */
defineAct({
  manifest: {
    id: 'unequip',
    description: 'Unequip the held item or the requested slot.',
    queryOps: [],
    controlOps: ['unequip', 'stop'],
    limits: { totalMs: 5000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        var request = {}
        if (a.destination !== undefined) {
          if (typeof a.destination !== 'string' || a.destination.length === 0) {
            return {
              kind: 'failed',
              error: { code: 'BAD_ARGS', message: 'unequip destination must be a non-empty string' },
            }
          }
          request.destination = a.destination
        }
        handle = ctx.control('unequip', request)
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
