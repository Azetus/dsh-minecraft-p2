/**
 * Smoke-test strategy (S2): walk to a checkpointed point and hold. Used to
 * verify lease handout, pathfinder stop and controller cancel/disable on a
 * live action.
 *
 * v2: only honor `lastOutcome` when it matches this commitment's walk target;
 * a previous commitment with the same attempt id must not stall a new walk.
 */
defineStrategy({
  manifest: {
    id: 'probe-walk',
    version: '4',
    slot: 'S2',
    facts: ['position'],
    acts: ['goto'],
    description: 'walk to a checkpointed coordinate',
  },
  evaluate: function (ctx) {
    var facts = ctx.facts
    if (!facts || facts.unknown.length > 0) {
      return { kind: 'unknown', missing: facts && facts.unknown ? facts.unknown : ['facts'] }
    }
    if (!ctx.commitment) return { kind: 'idle' }
    var checkpoint = ctx.commitment.checkpoint || {}
    var walk = checkpoint.walk
    if (!walk || typeof walk.x !== 'number' || typeof walk.y !== 'number' || typeof walk.z !== 'number') {
      return {
        kind: 'blocked',
        missing: [],
        diagnostics: [{ code: 'NO_WALK_TARGET', message: 'probe-walk needs checkpoint.walk {x,y,z}' }],
      }
    }
    var targetIntent = 'walk:' + walk.x + ',' + walk.y + ',' + walk.z
    if (ctx.activeAction) return { kind: 'running', intent: ctx.activeAction.intent }
    var hazards = (ctx.memory && ctx.memory.hazards) || []
    for (var h = 0; h < hazards.length; h += 1) {
      var area = hazards[h].area
      if (!area) continue
      var dx = walk.x - area.x
      var dy = walk.y - area.y
      var dz = walk.z - area.z
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= area.radius) {
        return {
          kind: 'blocked',
          missing: ['safe-target'],
          diagnostics: [{ code: 'HAZARD_TARGET', message: 'walk target is inside a remembered hazard' }],
        }
      }
    }
    var last = ctx.lastOutcome
    var own = last && last.attemptId === ctx.attemptId && last.intent === targetIntent ? last : null
    if (own && own.status === 'failed') {
      return {
        kind: 'blocked',
        missing: [],
        diagnostics: [{ code: 'WALK_FAILED', message: 'walk target failed', detail: own.error || null }],
      }
    }
    if (own && own.status === 'succeeded') return { kind: 'running', intent: 'walk-arrived' }
    return {
      kind: 'propose',
      intent: targetIntent,
      act: 'goto',
      args: { x: walk.x, y: walk.y, z: walk.z, range: typeof walk.range === 'number' ? walk.range : 1, timeoutMs: 60000 },
    }
  },
})


