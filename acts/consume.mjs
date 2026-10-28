/** Built-in act: eat or drink, optionally equipping the item first. */
defineAct({
  manifest: {
    id: 'consume',
    description: 'Consume the held item, equipping the requested item first.',
    queryOps: [],
    controlOps: ['equip', 'consume', 'stop'],
    limits: { totalMs: 15000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var handle = null
    var phase = 'consume'
    var stopped = false
    return {
      start: function (ctx) {
        if (a.item !== undefined) {
          if (typeof a.item !== 'string' || a.item.length === 0) {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'consume item must be a non-empty string' } }
          }
          handle = ctx.control('equip', { item: a.item, destination: 'hand' })
          phase = 'equip'
          return { kind: 'running' }
        }
        handle = ctx.control('consume', {})
        phase = 'consume'
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        for (var index = 0; index < list.length; index += 1) {
          var item = list[index]
          if (item.id !== handle) continue
          if (item.status === 'failed') return { kind: 'failed', error: item.error }
          if (item.status !== 'ok') continue
          if (phase === 'equip') {
            handle = ctx.control('consume', {})
            phase = 'consume'
            return { kind: 'running' }
          }
          return { kind: 'complete', result: item.value === undefined ? null : item.value }
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
