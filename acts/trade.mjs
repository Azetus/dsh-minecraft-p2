/** Built-in act: trade one offer with a villager. */
defineAct({
  manifest: {
    id: 'trade',
    description: 'Trade one villager offer and report the trade.',
    queryOps: [],
    controlOps: ['trade', 'stop'],
    limits: { totalMs: 15000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof args.entityId !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'trade requires numeric entityId' } }
        }
        if (typeof args.index !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'trade requires numeric index' } }
        }
        var request = { entityId: args.entityId, index: args.index }
        if (args.count !== undefined) {
          if (typeof args.count !== 'number' || args.count <= 0) {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'trade count must be a positive number' } }
          }
          request.count = args.count
        }
        handle = ctx.control('trade', request)
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
