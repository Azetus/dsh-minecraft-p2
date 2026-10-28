/** Built-in act: drive a mounted vehicle with analogue input. */
defineAct({
  manifest: {
    id: 'drive',
    description: 'Drive the mounted vehicle with steering and throttle input.',
    queryOps: [],
    controlOps: ['drive', 'stop'],
    limits: { totalMs: 15000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (!(typeof a.left === 'number' && a.left >= -1 && a.left <= 1)) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'drive left must be a number in -1..1' } }
        }
        if (!(typeof a.forward === 'number' && a.forward >= -1 && a.forward <= 1)) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'drive forward must be a number in -1..1' } }
        }
        var request = { left: a.left, forward: a.forward }
        if (a.durationMs !== undefined) {
          if (!(typeof a.durationMs === 'number' && a.durationMs >= 0)) {
            return {
              kind: 'failed',
              error: { code: 'BAD_ARGS', message: 'drive durationMs must be a non-negative number' },
            }
          }
          request.durationMs = a.durationMs
        }
        handle = ctx.control('drive', request)
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
