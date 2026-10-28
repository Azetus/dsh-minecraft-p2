/** Built-in act: equip one inventory item. */
defineAct({
  manifest: {
    id: 'equip-item',
    description: 'Equip one item to the requested destination.',
    queryOps: [],
    controlOps: ['equip', 'stop'],
    limits: { totalMs: 5000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof args.item !== 'string' || args.item.length === 0) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'equip-item requires an item name' } }
        }
        var request = { item: args.item }
        if (typeof args.destination === 'string') request.destination = args.destination
        handle = ctx.control('equip', request)
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
