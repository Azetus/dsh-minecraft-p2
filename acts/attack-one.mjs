/** Built-in act: attack one entity once. */
defineAct({
  manifest: {
    id: 'attack-one',
    description: 'Attack one entity once and report the hit.',
    queryOps: [],
    controlOps: ['attack', 'stop'],
    limits: { totalMs: 5000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof args.entityId !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'attack-one requires numeric entityId' } }
        }
        handle = ctx.control('attack', { entityId: args.entityId })
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
