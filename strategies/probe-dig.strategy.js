/**
 * Smoke-test strategy v4 (S2): dig one block when asked, then walk onto the
 * dropped item so inventory evidence can confirm it.
 *
 * `lastOutcome` is only honored for the current attempt; outcomes from a
 * previous strategy attempt must not steer this one.
 */
defineStrategy({
  manifest: {
    id: 'probe-dig',
    version: '4',
    slot: 'S2',
    facts: ['position', 'inventory', 'entities'],
    acts: ['mine-one', 'goto'],
    description: 'dig one block underfoot, then pick up the drop',
  },
  evaluate: function (ctx) {
    var facts = ctx.facts
    if (!facts || facts.unknown.length > 0) {
      return { kind: 'unknown', missing: facts && facts.unknown ? facts.unknown : ['facts'] }
    }
    if (!ctx.commitment) return { kind: 'idle' }

    var post = ctx.commitment.post
    if (post && post.kind === 'count-at-least') {
      var have = 0
      var had = 0
      var inventory = facts.values.inventory || []
      var baseline = (ctx.commitment.baseline && ctx.commitment.baseline.values.inventory) || []
      var index
      for (index = 0; index < inventory.length; index += 1) {
        if (inventory[index].name === post.item) have += inventory[index].count
      }
      for (index = 0; index < baseline.length; index += 1) {
        if (baseline[index].name === post.item) had += baseline[index].count
      }
      if (have - had >= post.count) {
        return { kind: 'candidate-complete', evidence: ['inventory'] }
      }
    }

    var checkpoint = ctx.commitment.checkpoint || {}
    if (ctx.activeAction) return { kind: 'running', intent: ctx.activeAction.intent }

    var last = ctx.lastOutcome
    var own = last && last.attemptId === ctx.attemptId ? last : null
    if (own && own.intent && own.intent.indexOf('dig:') === 0 && own.status === 'succeeded') {
      checkpoint = { done: true }
      return { kind: 'running', intent: 'pickup-next', checkpoint: checkpoint }
    }
    if (own && own.intent && own.intent.indexOf('pickup:') === 0 && own.status === 'failed') {
      return {
        kind: 'blocked',
        missing: [],
        diagnostics: [{ code: 'PICKUP_FAILED', message: 'could not reach the dropped item', detail: own.error || null }],
      }
    }

    if (checkpoint.done !== true) {
      var position = facts.values.position
      var target = {
        x: Math.floor(position.x),
        y: Math.floor(position.y) - 1,
        z: Math.floor(position.z),
      }
      return {
        kind: 'propose',
        intent: 'dig:' + target.x + ',' + target.y + ',' + target.z,
        act: 'mine-one',
        args: { pos: target },
      }
    }

    var entities = facts.values.entities || []
    var itemIndex
    for (itemIndex = 0; itemIndex < entities.length; itemIndex += 1) {
      var entity = entities[itemIndex]
      if (!entity || !entity.item || entity.item.itemId !== 28) continue
      if (!entity.position) continue
      return {
        kind: 'propose',
        intent: 'pickup:' + entity.position.x + ',' + entity.position.y + ',' + entity.position.z,
        act: 'goto',
        args: { x: entity.position.x, y: entity.position.y, z: entity.position.z, range: 0.5, timeoutMs: 5000 },
      }
    }
    return {
      kind: 'blocked',
      missing: ['entities'],
      diagnostics: [{ code: 'NO_ITEM_DROP', message: 'dig succeeded but the dirt drop is not visible' }],
    }
  },
})
