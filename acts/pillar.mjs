/** Built-in act: pillar up by jumping and placing the held block below. */
defineAct({
  manifest: {
    id: 'pillar',
    description: 'Pillar up one or more blocks by jumping and placing the held block below the bot.',
    queryOps: [],
    controlOps: ['pillar', 'stop'],
    limits: { totalMs: 30_000 },
  },
  create: function (args) {
    var handle = null
    var stopped = false
    var count = args && typeof args.count === 'number' ? Math.min(8, Math.max(1, Math.floor(args.count))) : 1
    return {
      start: function (ctx) {
        handle = ctx.control('pillar', { count: count })
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
