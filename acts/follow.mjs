/** Built-in act: follow one entity until stopped. */
defineAct({
  manifest: {
    id: 'follow',
    description: 'Follow an entity and confirm that following started.',
    queryOps: [],
    controlOps: ['follow', 'stop'],
    limits: { totalMs: 60000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof a.entityId !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'follow requires a numeric entityId' } }
        }
        var request = { entityId: a.entityId }
        if (a.distance !== undefined) {
          if (!(typeof a.distance === 'number' && a.distance >= 0)) {
            return {
              kind: 'failed',
              error: { code: 'BAD_ARGS', message: 'follow distance must be a non-negative number' },
            }
          }
          request.distance = a.distance
        }
        if (a.timeoutMs !== undefined) {
          if (!(typeof a.timeoutMs === 'number' && a.timeoutMs >= 0)) {
            return {
              kind: 'failed',
              error: { code: 'BAD_ARGS', message: 'follow timeoutMs must be a non-negative number' },
            }
          }
          request.timeoutMs = a.timeoutMs
        }
        handle = ctx.control('follow', request)
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        for (var index = 0; index < list.length; index += 1) {
          var item = list[index]
          if (item.id !== handle) continue
          if (item.status === 'ok') return { kind: 'complete', result: { followed: true, entityId: a.entityId } }
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
