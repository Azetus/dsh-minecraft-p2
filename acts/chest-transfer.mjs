/** Built-in act: deposit one stack into a container or withdraw one stack from it. */
defineAct({
  manifest: {
    id: 'chest-transfer',
    description: 'Deposit or withdraw one item stack using a container.',
    queryOps: [],
    controlOps: ['container-transfer', 'stop'],
    limits: { totalMs: 30000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        var pos = args.pos
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'chest-transfer requires pos {x,y,z}' } }
        }
        if (args.action !== 'deposit' && args.action !== 'withdraw') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'chest-transfer action must be deposit or withdraw' } }
        }
        if (typeof args.item !== 'string' || args.item.length === 0) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'chest-transfer requires an item name' } }
        }
        var request = {
          x: pos.x,
          y: pos.y,
          z: pos.z,
          action: args.action,
          item: args.item,
        }
        if (args.count !== undefined) {
          if (typeof args.count !== 'number' || args.count <= 0) {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'chest-transfer count must be a positive number' } }
          }
          request.count = args.count
        }
        handle = ctx.control('container-transfer', request)
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
