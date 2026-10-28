/** Built-in act: walk forward for an optional duration. */
defineAct({
  manifest: {
    id: 'walk-forward',
    description: 'Walk forward for an optional duration and report the position.',
    queryOps: [],
    controlOps: ['forward', 'stop'],
    limits: { totalMs: 15000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        var request = {}
        if (a.durationMs !== undefined) {
          if (!(typeof a.durationMs === 'number' && a.durationMs >= 0)) {
            return {
              kind: 'failed',
              error: { code: 'BAD_ARGS', message: 'walk-forward durationMs must be a non-negative number' },
            }
          }
          request.durationMs = a.durationMs
        }
        handle = ctx.control('forward', request)
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
