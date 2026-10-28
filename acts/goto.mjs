/** Built-in act: pathfind to an exact position. */
defineAct({
  manifest: {
    id: 'goto',
    description: 'Pathfind to a position and report the arrival.',
    queryOps: [],
    controlOps: ['goto', 'stop'],
    limits: { totalMs: 60000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof a.x !== 'number' || typeof a.y !== 'number' || typeof a.z !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'goto requires numeric x, y and z' } }
        }
        var request = { x: a.x, y: a.y, z: a.z }
        if (a.range !== undefined) {
          if (!(typeof a.range === 'number' && a.range >= 0)) {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'goto range must be a non-negative number' } }
          }
          request.range = a.range
        }
        if (a.timeoutMs !== undefined) {
          if (!(typeof a.timeoutMs === 'number' && a.timeoutMs >= 0)) {
            return {
              kind: 'failed',
              error: { code: 'BAD_ARGS', message: 'goto timeoutMs must be a non-negative number' },
            }
          }
          request.timeoutMs = a.timeoutMs
        }
        handle = ctx.control('goto', request)
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
