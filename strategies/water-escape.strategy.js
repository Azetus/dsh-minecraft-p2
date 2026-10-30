/**
 * S0 deep-water escape: swim/path to the nearest dry block instead of jumping
 * in place. Falls back to `leave-water` only when no dry target is visible.
 *
 * Holding the emergency while the escape action runs is deliberate: a jump can
 * briefly report inWater=false before the bot is actually out.
 */
defineStrategy({
  manifest: {
    id: 'water-escape',
    version: '8',
    slot: 'S0',
    hazardClass: 'lethal',
    facts: ['position', 'nearbyBlocks'],
    acts: ['goto', 'leave-water'],
    description: 'swim to the nearest dry bank',
  },
  evaluate: function (ctx) {
    var facts = ctx.facts
    if (!facts || !facts.values) return { kind: 'unknown', missing: ['facts'] }
    var position = facts.values.position
    if (!position) return { kind: 'unknown', missing: ['position'] }
    // Only an S0-owned action keeps the emergency alive. A task action that is
    // just starting must not look like an emergency.
    var s0Action = ctx.activeAction && typeof ctx.activeAction.holder === 'string'
      && ctx.activeAction.holder.indexOf('S0:') === 0
    if (position.inWater !== true) {
      if (s0Action) return { kind: 'running', intent: ctx.activeAction.intent }
      return { kind: 'idle' }
    }
    if (s0Action) return { kind: 'running', intent: ctx.activeAction.intent }

    var last = ctx.lastOutcome
    var own = last && last.attemptId === ctx.attemptId ? last : null
    if (own && own.intent && own.intent.indexOf('escape:') === 0) {
      if (own.status === 'failed') {
        return {
          kind: 'blocked',
          missing: [],
          diagnostics: [{ code: 'WATER_ESCAPE_NO_PATH', message: 'goto could not reach dry land', detail: own.error || null }],
        }
      }
      if (own.status === 'succeeded') {
        return {
          kind: 'blocked',
          missing: [],
          diagnostics: [{ code: 'WATER_ESCAPE_FAILED', message: 'reached a dry target but is still in water' }],
        }
      }
    }
    if (own && own.intent === 'leave-water' && own.status === 'failed') {
      return {
        kind: 'blocked',
        missing: [],
        diagnostics: [{ code: 'WATER_ESCAPE_FAILED', message: 'leave-water failed', detail: own.error || null }],
      }
    }

    var blocks = facts.values.nearbyBlocks || []
    // Prefer the highest nearby land block: underwater floor blocks would make
    // goto stop in the water. Logs/trees are not valid shore targets.
    var best = null
    var bestY = -1e9
    var bestDistance = 1e9
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i]
      if (!block || typeof block.x !== 'number' || typeof block.y !== 'number' || typeof block.z !== 'number') continue
      if (typeof block.name === 'string' && block.name.indexOf('_log') >= 0) continue
      var dx = block.x - position.x
      var dz = block.z - position.z
      var distance = Math.sqrt(dx * dx + dz * dz)
      if (distance > 10 || distance < 0.5) continue
      if (block.y > bestY || (block.y === bestY && distance < bestDistance)) {
        bestY = block.y
        bestDistance = distance
        best = block
      }
    }

    var hazard = {
      id: 'water:' + Math.floor(position.x) + ',' + Math.floor(position.y) + ',' + Math.floor(position.z),
      kind: 'water',
      x: position.x,
      y: position.y,
      z: position.z,
      radius: 4,
      ttlMs: 600000,
    }
    if (best) {
      return {
        kind: 'propose',
        intent: 'escape:' + best.x + ',' + (best.y + 1) + ',' + best.z,
        act: 'goto',
        args: { x: best.x, y: best.y + 1, z: best.z, range: 0.5, timeoutMs: 8000 },
        hazard: hazard,
      }
    }
    return {
      kind: 'propose',
      intent: 'leave-water',
      act: 'leave-water',
      args: {},
      hazard: hazard,
    }
  },
})

