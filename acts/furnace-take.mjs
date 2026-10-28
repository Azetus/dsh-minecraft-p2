/** Built-in act: take the output stack out of a furnace. */
defineAct({
  manifest: {
    id: 'furnace-take',
    description: 'Take the output stack from a furnace.',
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
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'furnace-take requires pos {x,y,z}' } }
        }
        handle = ctx.control('container-transfer', {
          x: pos.x,
          y: pos.y,
          z: pos.z,
          action: 'take-output',
        })
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
