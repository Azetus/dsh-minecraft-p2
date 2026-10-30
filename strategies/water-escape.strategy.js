/**
 * Smoke-test S0 strategy: leaving water is the emergency. It triggers on
 * `position.inWater === true` (shallow pool is enough) and steps backwards,
 * assuming the bot entered the water walking forward.
 */
defineStrategy({
  manifest: {
    id: 'water-escape',
    version: '1',
    slot: 'S0',
    hazardClass: 'lethal',
    facts: ['position'],
    acts: ['walk-back'],
    description: 'step out of water',
  },
  evaluate: function (ctx) {
    var facts = ctx.facts
    if (!facts || facts.unknown.length > 0) {
      return { kind: 'unknown', missing: facts && facts.unknown ? facts.unknown : ['facts'] }
    }
    var position = facts.values.position
    if (!position || position.inWater !== true) return { kind: 'idle' }
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
      act: 'walk-back',
      args: { durationMs: 900 },
      checkpoint: { escapeAttempts: attempts + 1 },
    }
  },
})
