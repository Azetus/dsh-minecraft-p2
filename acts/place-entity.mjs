/** Built-in act: place a boat or minecart at a position. */
defineAct({
  manifest: {
    id: 'place-entity',
    description: 'Place a vehicle entity at an exact position.',
    queryOps: [],
    controlOps: ['place-entity', 'stop'],
    limits: { totalMs: 5000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof a.x !== 'number' || typeof a.y !== 'number' || typeof a.z !== 'number') {
          return {
            kind: 'failed',
            error: { code: 'BAD_ARGS', message: 'place-entity requires numeric x, y and z' },
          }
        }
        var request = { x: a.x, y: a.y, z: a.z }
        if (a.face !== undefined) {
          if (typeof a.face !== 'string' || a.face.length === 0) {
            return {
              kind: 'failed',
              error: { code: 'BAD_ARGS', message: 'place-entity face must be a non-empty string' },
            }
          }
          request.face = a.face
        }
        handle = ctx.control('place-entity', request)
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
