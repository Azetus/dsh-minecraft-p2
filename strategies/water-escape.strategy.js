/**
 * Smoke-test S0 strategy: leaving water is the emergency. It triggers on
 * `position.inWater === true` (shallow pool is enough) and steps backwards,
 * assuming the bot entered the water walking forward.
 */
defineStrategy({
  manifest: {
    id: 'water-escape',
    version: '5',
    slot: 'S0',
    hazardClass: 'lethal',
    facts: ['position'],
    acts: ['leave-water'],
    description: 'step out of water',
  },
  evaluate: function (ctx) {
    var facts = ctx.facts
    if (!facts || facts.unknown.length > 0) {
      return { kind: 'unknown', missing: facts && facts.unknown ? facts.unknown : ['facts'] }
    }
    var position = facts.values.position
    if (!position || position.inWater !== true) {
      // A jump briefly reports inWater=false while the escape action is still
      // running. Do not let that transient clear the emergency and resume the
      // task while the bot is still in the river.
      if (ctx.activeAction) return { kind: 'running', intent: ctx.activeAction.intent }
      return { kind: 'idle' }
    }
    if (ctx.activeAction) return { kind: 'running', intent: ctx.activeAction.intent }
    var checkpoint = (ctx.commitment && ctx.commitment.checkpoint) || {}
    var attempts = typeof checkpoint.escapeAttempts === 'number' ? checkpoint.escapeAttempts : 0
    if (attempts >= 3) {
      return {
        kind: 'blocked',
        missing: [],
        diagnostics: [{ code: 'WATER_ESCAPE_FAILED', message: 'still in water after three attempts' }],
      }
    }
    return {
      kind: 'propose',
      intent: 'leave-water',
      act: 'leave-water',
      args: {},
      checkpoint: { escapeAttempts: attempts + 1 },
      hazard: {
        id: 'water:' + Math.floor(position.x) + ',' + Math.floor(position.y) + ',' + Math.floor(position.z),
        kind: 'water',
        x: position.x,
        y: position.y,
        z: position.z,
        radius: 3,
        ttlMs: 600000,
      },
    }
  },
})


