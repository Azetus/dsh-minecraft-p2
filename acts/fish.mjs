/** Built-in act: fish until the op reports a catch or times out. */
defineAct({
  manifest: {
    id: 'fish',
    description: 'Fish and report the catch.',
    queryOps: [],
    controlOps: ['fish', 'stop'],
    limits: { totalMs: 60000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        var request = {}
        if (a.timeoutMs !== undefined) {
          if (!(typeof a.timeoutMs === 'number' && a.timeoutMs >= 0)) {
            return {
              kind: 'failed',
              error: { code: 'BAD_ARGS', message: 'fish timeoutMs must be a non-negative number' },
            }
          }
          request.timeoutMs = a.timeoutMs
        }
        handle = ctx.control('fish', request)
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
