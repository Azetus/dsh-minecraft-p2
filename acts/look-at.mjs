/** Built-in act: aim the view at one entity or one exact point. */
defineAct({
  manifest: {
    id: 'look-at',
    description: 'Point the view at an entity or at exact coordinates.',
    queryOps: [],
    controlOps: ['lookAt', 'stop'],
    limits: { totalMs: 5000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        var hasEntity = a.entityId !== undefined
        var hasCoords = a.x !== undefined || a.y !== undefined || a.z !== undefined
        if (hasEntity === hasCoords) {
          return {
            kind: 'failed',
            error: { code: 'BAD_ARGS', message: 'look-at requires exactly one of entityId or x/y/z' },
          }
        }
        if (hasEntity) {
          if (typeof a.entityId !== 'number') {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'look-at entityId must be a number' } }
          }
          handle = ctx.control('lookAt', { entityId: a.entityId })
          return { kind: 'running' }
        }
        if (typeof a.x !== 'number' || typeof a.y !== 'number' || typeof a.z !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'look-at requires numeric x, y and z' } }
        }
        handle = ctx.control('lookAt', { x: a.x, y: a.y, z: a.z })
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
