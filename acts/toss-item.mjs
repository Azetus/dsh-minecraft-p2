/** Built-in act: toss one item stack out of the inventory. */
defineAct({
  manifest: {
    id: 'toss-item',
    description: 'Toss an item stack and report how much was thrown.',
    queryOps: [],
    controlOps: ['toss', 'stop'],
    limits: { totalMs: 10000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof args.item !== 'string' || args.item.length === 0) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'toss-item requires an item name' } }
        }
        var request = { item: args.item }
        if (args.count !== undefined) {
          if (typeof args.count !== 'number' || args.count <= 0) {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'toss-item count must be a positive number' } }
          }
          request.count = args.count
        }
        handle = ctx.control('toss', request)
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
