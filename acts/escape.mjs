/** Thin act: run one emergency escape mode through the authored `escape` op. */
defineAct({
  manifest: {
    id: 'escape',
    description: 'Emergency escape: swim up out of water, leave lava, or run from a hostile mob.',
    queryOps: [],
    controlOps: ['escape', 'stop'],
    limits: { totalMs: 20000 },
  },
  create: function (rawArgs) {
    var args = rawArgs === null || typeof rawArgs !== 'object' ? {} : rawArgs
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof args.mode !== 'string' || args.mode.length === 0) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'escape requires a mode' } }
        }
        handle = ctx.control('escape', { mode: args.mode })
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
