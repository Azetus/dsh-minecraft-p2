/**
 * Built-in act: keep attacking one entity at the sword cooldown until it dies,
 * leaves reach, or the act budget ends. The loop lives inside the act so the
 * behavior pays one act start instead of one per swing.
 */
defineAct({
  manifest: {
    id: 'attack-target',
    description: 'Repeatedly attack one entity until it dies, leaves reach, or the act ends.',
    queryOps: ['entities'],
    controlOps: ['attack', 'stop'],
    limits: { totalMs: 15000 },
  },
  create: function (args) {
    var a = args === null || typeof args !== 'object' ? {} : args
    var targetId = typeof a.entityId === 'number' ? a.entityId : null
    var reach = typeof a.reach === 'number' && a.reach > 0 ? a.reach : 3.5
    var intervalMs = typeof a.intervalMs === 'number' ? Math.max(300, Math.min(1200, a.intervalMs)) : 600
    var queryHandle = 0
    var nextQueryAt = 0
    var nextAttackAt = 0
    var attacks = 0
    var seen = false
    var distance = null
    var stopped = false

    function findResult(list, id) {
      for (var index = 0; index < list.length; index += 1) {
        if (list[index] && list[index].id === id) return list[index]
      }
      return null
    }

    return {
      start: function (ctx) {
        if (targetId === null) {
          return { kind: 'failed', error: { code: 'BAD_ARGS', message: 'attack-target requires numeric entityId' } }
        }
        queryHandle = ctx.query('entities', { maxDistance: 16, count: 32 })
        nextQueryAt = ctx.now() + 250
        return { kind: 'running' }
      },
      update: function (ctx, input) {
        var list = input && input.handles ? input.handles : []
        var now = ctx.now()

        if (queryHandle !== 0) {
          var found = findResult(list, queryHandle)
          if (found !== null) {
            queryHandle = 0
            if (found.status === 'failed') return { kind: 'failed', error: found.error }
            var entries = found.status === 'ok' && Array.isArray(found.value) ? found.value : []
            var match = null
            for (var index = 0; index < entries.length; index += 1) {
              if (entries[index] && entries[index].id === targetId) {
                match = entries[index]
                break
              }
            }
            if (match === null) {
              // Not seen yet means the caller handed us a stale id; seen means it died.
              return { kind: 'complete', result: { attacks: attacks, killed: seen } }
            }
            seen = true
            distance = typeof match.distance === 'number' ? match.distance : null
          }
        }

        if (queryHandle === 0 && now >= nextQueryAt) {
          queryHandle = ctx.query('entities', { maxDistance: 16, count: 32 })
          nextQueryAt = now + 250
        }

        if (distance !== null && distance > reach) {
          return { kind: 'complete', result: { attacks: attacks, outOfReach: true, distance: distance } }
        }

        if (distance !== null && now >= nextAttackAt) {
          ctx.control('attack', { entityId: targetId })
          attacks += 1
          nextAttackAt = now + intervalMs
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
