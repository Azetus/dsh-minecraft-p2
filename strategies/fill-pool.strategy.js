/**
 * One-shot cleanup: replace the checkpoint.pool fluid cell with a held block.
 * It is content for smoke/cleanup, not a core behavior.
 */
defineStrategy({
  manifest: {
    id: 'fill-pool',
    version: '1',
    slot: 'S2',
    facts: [],
    acts: ['fill-water'],
    description: 'fill one pool cell once',
  },
  evaluate: function (ctx) {
    var commitment = ctx.commitment
    if (!commitment) return { kind: 'idle' }
    var checkpoint = commitment.checkpoint || {}
    if (checkpoint.done === true) return { kind: 'idle' }
    if (ctx.activeAction) return { kind: 'running', intent: ctx.activeAction.intent }

    var last = ctx.lastOutcome
    var own = last && last.attemptId === ctx.attemptId ? last : null
    if (own && own.intent === 'fill-water' && own.status === 'succeeded') {
      return { kind: 'running', intent: 'filled', checkpoint: { pool: checkpoint.pool, done: true } }
    }
    if (own && own.intent === 'fill-water' && own.status === 'failed') {
      return {
        kind: 'blocked',
        missing: [],
        diagnostics: [{ code: 'FILL_FAILED', message: 'could not replace the fluid cell', detail: own.error || null }],
      }
    }
    if (checkpoint.done === true) return { kind: 'idle' }
    var pool = checkpoint.pool || { x: -11, y: 72, z: 6 }
    return {
      kind: 'propose',
      intent: 'fill-water',
      act: 'fill-water',
      args: { pos: pool, item: 'oak_planks' },
      checkpoint: { pool: pool, phase: 'fill' },
    }
  },
})
