/** Built-in act: load one input stack and one fuel stack into a furnace. */
defineAct({
  manifest: {
    id: 'furnace-load',
    description: 'Load an input stack and a fuel stack into a furnace.',
    queryOps: [],
    controlOps: ['container-transfer', 'stop'],
    limits: { totalMs: 30000 },
  },
  create: function (args) {
    var inputHandle = null
    var fuelHandle = null
    var phase = 'input'
    var stopped = false

    function stackError(stack, field) {
      if (stack === null || typeof stack !== 'object') return field + ' must be a stack {item,count}'
      if (typeof stack.item !== 'string' || stack.item.length === 0) return field + ' requires an item name'
      if (typeof stack.count !== 'number' || stack.count <= 0) return field + ' count must be a positive number'
      return null
    }

    function transfer(ctx, action, stack) {
      return ctx.control('container-transfer', {
        x: args.pos.x,
        y: args.pos.y,
        z: args.pos.z,
        action: action,
        item: stack.item,
        count: stack.count,
      })
    }

    return {
      start: function (ctx) {
        var pos = args.pos
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'furnace-load requires pos {x,y,z}' } }
        }
        var inputError = stackError(args.input, 'input')
        if (inputError !== null) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: inputError } }
        }
        var fuelError = stackError(args.fuel, 'fuel')
        if (fuelError !== null) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: fuelError } }
        }
        inputHandle = transfer(ctx, 'load-input', args.input)
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        var current = phase === 'input' ? inputHandle : fuelHandle
        var found = null
        for (var index = 0; index < list.length; index += 1) {
          if (list[index].id !== current) continue
          found = list[index]
          break
        }
        if (found === null) return { kind: 'running' }
        if (found.status === 'failed') return { kind: 'failed', error: found.error }
        if (found.status !== 'ok') return { kind: 'running' }
        if (phase === 'input') {
          fuelHandle = transfer(ctx, 'load-fuel', args.fuel)
          phase = 'fuel'
          return { kind: 'running' }
        }
        return { kind: 'complete', result: { loaded: true } }
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
