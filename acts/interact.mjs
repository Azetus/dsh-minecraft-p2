/** Built-in act: interact with one entity, optionally equipping an item first. */
defineAct({
  manifest: {
    id: 'interact',
    description: 'Interact with one entity, optionally equipping an item to the hand first.',
    queryOps: [],
    controlOps: ['equip', 'interact', 'stop'],
    limits: { totalMs: 15000 },
  },
  create: function (args) {
    var equipHandle = null
    var interactHandle = null
    var phase = 'equip'
    var stopped = false

    function startInteract(ctx) {
      interactHandle = ctx.control('interact', { entityId: args.entityId })
      phase = 'interact'
    }

    return {
      start: function (ctx) {
        if (typeof args.entityId !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'interact requires numeric entityId' } }
        }
        if (args.item !== undefined) {
          if (typeof args.item !== 'string' || args.item.length === 0) {
            return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'interact item must be a non-empty item name' } }
          }
          equipHandle = ctx.control('equip', { item: args.item, destination: 'hand' })
          phase = 'equip'
          return { kind: 'running' }
        }
        startInteract(ctx)
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        var current = phase === 'equip' ? equipHandle : interactHandle
        var found = null
        for (var index = 0; index < list.length; index += 1) {
          if (list[index].id !== current) continue
          found = list[index]
          break
        }
        if (found === null) return { kind: 'running' }
        if (found.status === 'failed') return { kind: 'failed', error: found.error }
        if (found.status !== 'ok') return { kind: 'running' }
        if (phase === 'equip') {
          startInteract(ctx)
          return { kind: 'running' }
        }
        return { kind: 'complete', result: found.value === undefined ? null : found.value }
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
