/** Built-in act: mount one entity. */
defineAct({
  manifest: {
    id: 'mount',
    description: 'Mount one entity and confirm the mount.',
    queryOps: [],
    controlOps: ['mount', 'stop'],
    limits: { totalMs: 15000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof args.entityId !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'mount requires numeric entityId' } }
        }
        handle = ctx.control('mount', { entityId: args.entityId })
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        for (var index = 0; index < list.length; index += 1) {
          var item = list[index]
          if (item.id !== handle) continue
          if (item.status === 'ok') {
            return { kind: 'complete', result: { mounted: true, entityId: args.entityId } }
          }
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
