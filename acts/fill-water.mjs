/**
 * Fill one fluid cell with a held block. Uses the `replace` control op, which
 * allows the target to be water/lava (unlike `place`).
 */
defineAct({
  manifest: {
    id: 'fill-water',
    description: 'Replace one water/lava cell with a held block.',
    queryOps: [],
    controlOps: ['equip', 'replace', 'stop'],
    limits: { totalMs: 15000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var equipped = null
    var placed = null
    var stopped = false
    function find(list, id) {
      for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i]
      return null
    }
    return {
      start: function (ctx) {
        var pos = a.pos
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'fill-water requires pos {x,y,z}' } }
        }
        if (typeof a.item !== 'string' || a.item.length === 0) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'fill-water requires item' } }
        }
        equipped = ctx.control('equip', { item: a.item, destination: 'hand' })
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        var equipResult = equipped === null ? null : find(list, equipped)
        if (equipResult !== null && equipResult.status === 'failed') return { kind: 'failed', error: equipResult.error }
        if (placed === null && equipResult !== null && equipResult.status === 'ok') {
          placed = ctx.control('replace', { x: a.pos.x, y: a.pos.y, z: a.pos.z })
          return { kind: 'running' }
        }
        var placeResult = placed === null ? null : find(list, placed)
        if (placeResult !== null && placeResult.status === 'failed') return { kind: 'failed', error: placeResult.error }
        if (placeResult !== null && placeResult.status === 'ok') {
          return { kind: 'complete', result: placeResult.value === undefined ? { filled: true } : placeResult.value }
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
