/** Built-in act: dig one block at an exact position. */
defineAct({
  manifest: {
    id: 'mine-one',
    description: 'Dig a single block at the given position.',
    queryOps: ['block'],
    controlOps: ['dig', 'stop'],
    limits: { totalMs: 30000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        var pos = args.pos
        if (!pos) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'mine-one requires pos {x,y,z}' } }
        }
        handle = ctx.control('dig', { x: pos.x, y: pos.y, z: pos.z })
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
