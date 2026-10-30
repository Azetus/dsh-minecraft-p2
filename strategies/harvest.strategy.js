/**
 * Harvest one surface block and pick up its drop.
 *
 * Real task strategy: facts come from the body, evidence is inventory delta
 * against the commitment baseline. It does not count the block break itself as
 * success.
 */
defineStrategy({
  manifest: {
    id: 'harvest',
    version: '1',
    slot: 'S2',
    facts: ['position', 'inventory', 'nearbyBlocks', 'entities'],
    acts: ['mine-one', 'goto'],
    description: 'mine one grass/dirt block and collect the drop',
  },
  evaluate: function (ctx) {
    var facts = ctx.facts
    if (!facts || facts.unknown.length > 0) {
      return { kind: 'unknown', missing: facts && facts.unknown ? facts.unknown : ['facts'] }
    }
    var commitment = ctx.commitment
    if (!commitment) return { kind: 'idle' }

    var post = commitment.post || {}
    var item = post.kind === 'count-at-least' && typeof post.item === 'string' ? post.item : 'dirt'
    var required = post.kind === 'count-at-least' && typeof post.count === 'number' ? post.count : 1
    var inventory = facts.values.inventory || []
    var baseline = (commitment.baseline && commitment.baseline.values && commitment.baseline.values.inventory) || []
    var have = 0
    var had = 0
    var i
    for (i = 0; i < inventory.length; i += 1) if (inventory[i].name === item) have += inventory[i].count
    for (i = 0; i < baseline.length; i += 1) if (baseline[i].name === item) had += baseline[i].count

    if (ctx.activeAction) return { kind: 'running', intent: ctx.activeAction.intent }

    var checkpoint = commitment.checkpoint || {}
    var last = ctx.lastOutcome
    var own = last && last.attemptId === ctx.attemptId ? last : null

    if (have - had >= required) {
      return { kind: 'candidate-complete', evidence: ['inventory'], checkpoint: { phase: 'done' } }
    }
    if (own && own.intent && own.intent.indexOf('dig:') === 0 && own.status === 'succeeded') {
      checkpoint = { target: checkpoint.target, phase: 'pickup' }
      return { kind: 'running', intent: 'pickup-next', checkpoint: checkpoint }
    }
    if (own && own.intent && own.intent.indexOf('pickup:') === 0 && own.status === 'failed') {
      return {
        kind: 'blocked',
        missing: [],
        diagnostics: [{ code: 'PICKUP_FAILED', message: 'could not reach the dropped item', detail: own.error || null }],
      }
    }
    if (own && own.intent && own.intent.indexOf('dig:') === 0 && own.status === 'failed') {
      return {
        kind: 'blocked',
        missing: [],
        diagnostics: [{ code: 'DIG_FAILED', message: 'target block could not be mined', detail: own.error || null }],
      }
    }

    if (checkpoint.phase !== 'pickup') {
      var blocks = facts.values.nearbyBlocks || []
      var position = facts.values.position || {}
      var target = checkpoint.target
      if (!target) {
        var best = null
        var bestDistance = 1e9
        for (i = 0; i < blocks.length; i += 1) {
          var block = blocks[i]
          if (!block) continue
          if (block.name !== 'grass_block' && block.name !== 'dirt') continue
          if (typeof block.x !== 'number' || typeof block.y !== 'number' || typeof block.z !== 'number') continue
          var dx = block.x - position.x
          var dz = block.z - position.z
          var distance = dx * dx + dz * dz
          if (distance < bestDistance && distance <= 36) {
            bestDistance = distance
            best = { x: block.x, y: block.y, z: block.z }
          }
        }
        target = best
      }
      if (!target) {
        return {
          kind: 'blocked',
          missing: ['nearbyBlocks'],
          diagnostics: [{ code: 'NO_HARVEST_TARGET', message: 'no grass/dirt block within six blocks' }],
        }
      }
      return {
        kind: 'propose',
        intent: 'dig:' + target.x + ',' + target.y + ',' + target.z,
        act: 'mine-one',
        args: { pos: target },
        checkpoint: { target: target, phase: 'dig' },
      }
    }

    var entities = facts.values.entities || []
    for (i = 0; i < entities.length; i += 1) {
      var entity = entities[i]
      if (!entity || entity.name !== 'item' || !entity.position) continue
      return {
        kind: 'propose',
        intent: 'pickup:' + entity.position.x + ',' + entity.position.y + ',' + entity.position.z,
        act: 'goto',
        args: { x: entity.position.x, y: entity.position.y, z: entity.position.z, range: 0.5, timeoutMs: 5000 },
      }
    }
    if (checkpoint.target) {
      return {
        kind: 'propose',
        intent: 'pickup:' + checkpoint.target.x + ',' + checkpoint.target.y + ',' + checkpoint.target.z,
        act: 'goto',
        args: { x: checkpoint.target.x, y: checkpoint.target.y, z: checkpoint.target.z, range: 1, timeoutMs: 5000 },
      }
    }
    return {
      kind: 'blocked',
      missing: ['entities'],
      diagnostics: [{ code: 'NO_ITEM_DROP', message: 'dig succeeded but no dropped item is visible' }],
    }
  },
})
