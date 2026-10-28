/**
 * Built-in act: move to a horizontal target with the `moveTo` op.
 *
 * Single file, no imports: the runner evaluates it in an isolated context and
 * injects `defineAct`. Declared operations are enforced by the op broker.
 */
defineAct({
  manifest: {
    id: 'move-to',
    description: 'Move to a horizontal target and stop.',
    queryOps: ['position'],
    controlOps: ['moveTo', 'stop'],
    limits: { totalMs: 30000 },
  },
  create(args) {
    var handle = null
    var stopped = false
    return {
      start: function (ctx) {
        handle = ctx.control('moveTo', {
          x: args.x,
          z: args.z,
          tolerance: args.tolerance === undefined ? 0.6 : args.tolerance,
          timeoutMs: args.timeoutMs === undefined ? 15000 : args.timeoutMs,
          blockedMs: args.blockedMs === undefined ? 1500 : args.blockedMs,
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
