/** Thin act: run one campaign stage through the authored `campaign` op. */
defineAct({
  manifest: {
    id: 'campaign-step',
    description: 'Run one survival campaign stage (shelter/bed/tools/copper/smelt) and return its evidence.',
    queryOps: [],
    controlOps: ['campaign', 'stop'],
    limits: { totalMs: 1800000 },
  },
  create: function (rawArgs) {
    var args = rawArgs === null || typeof rawArgs !== 'object' ? {} : rawArgs
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        if (typeof args.stage !== 'string' || args.stage.length === 0) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'campaign-step requires a stage' } }
        }
        handle = ctx.control('campaign', { stage: args.stage })
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
