/** Built-in act: craft one item, optionally at an exact crafting table. */
defineAct({
  manifest: {
    id: 'craft',
    description: 'Craft an item and report the crafted result.',
    queryOps: [],
    controlOps: ['craft', 'stop'],
    limits: { totalMs: 60000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof args.item !== 'string' || args.item.length === 0) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'craft requires an item name' } }
        }
        var request = { item: args.item }
        if (args.count !== undefined) {
          if (typeof args.count !== 'number' || args.count <= 0) {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'craft count must be a positive number' } }
          }
          request.count = args.count
        }
        if (args.table !== undefined) {
          var table = args.table
          if (
            table === null ||
            typeof table !== 'object' ||
            typeof table.x !== 'number' ||
            typeof table.y !== 'number' ||
            typeof table.z !== 'number'
          ) {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'craft table must be a block position {x,y,z}' } }
          }
          request.table = { x: table.x, y: table.y, z: table.z }
        }
        handle = ctx.control('craft', request)
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
