/**
 * Production harvest strategy (v2): mine grass/dirt/stone until the commitment
 * baseline delta is met, collect drops, then optionally return to a checkpoint
 * point. Only inventory evidence can complete; a successful dig is not success.
 *
 * Checkpoint shape:
 *   { target?, phase?, failed?: string[], equippedFor?, dropGoto?, returnTo? }
 */
defineStrategy({
  manifest: {
    id: 'harvest',
    version: '4',
    slot: 'S2',
    facts: ['position', 'inventory', 'nearbyBlocks', 'entities'],
    acts: ['equip-item', 'mine-one', 'goto'],
    description: 'harvest blocks, collect drops, return to a point',
  },
  evaluate: function (ctx) {
    var facts = ctx.facts
    if (!facts || !facts.values) {
      return { kind: 'unknown', missing: ['facts'] }
    }
    var commitment = ctx.commitment
    if (!commitment) return { kind: 'idle' }

    var post = commitment.post || {}
    var item = post.kind === 'count-at-least' && typeof post.item === 'string' ? post.item : 'dirt'
    var required = post.kind === 'count-at-least' && typeof post.count === 'number' ? post.count : 1
    var position = facts.values.position || {}
    var inventory = facts.values.inventory || []
    var baseline = (commitment.baseline && commitment.baseline.values && commitment.baseline.values.inventory) || []
    var checkpoint = commitment.checkpoint || {}
    var failed = Array.isArray(checkpoint.failed) ? checkpoint.failed.slice() : []
    var phase = checkpoint.phase || 'dig'
    var target = checkpoint.target || null
    var hazards = (ctx.memory && ctx.memory.hazards) || []

    function countOf(list, name) {
      var total = 0
      for (var i = 0; i < list.length; i += 1) if (list[i].name === name) total += list[i].count
      return total
    }
    function keyOf(pos) { return pos.x + ',' + pos.y + ',' + pos.z }
    function distanceTo(pos) {
      var dx = pos.x - position.x
      var dy = pos.y - position.y
      var dz = pos.z - position.z
      return Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
    function insideHazard(pos) {
      for (var i = 0; i < hazards.length; i += 1) {
        var area = hazards[i].area
        if (!area) continue
        var dx = pos.x - area.x
        var dy = pos.y - area.y
        var dz = pos.z - area.z
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= area.radius) return true
      }
      return false
    }
    function toolFor(name) {
      var wanted = name === 'stone' ? '_pickaxe' : '_shovel'
      for (var i = 0; i < inventory.length; i += 1) {
        if (inventory[i].name && inventory[i].name.indexOf(wanted) >= 0) return inventory[i].name
      }
      if (name === 'stone') return null
      return null
    }
    function chooseTarget() {
      var blocks = facts.values.nearbyBlocks || []
      var best = null
      var bestDistance = 1e9
      for (var i = 0; i < blocks.length; i += 1) {
        var block = blocks[i]
        if (!block) continue
        if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'stone') continue
        if (typeof block.x !== 'number' || typeof block.y !== 'number' || typeof block.z !== 'number') continue
        var key = keyOf(block)
        if (failed.indexOf(key) >= 0) continue
        if (insideHazard(block)) continue
        if (item === 'dirt' && block.name === 'stone') continue
        if ((item === 'cobblestone' || item === 'stone') && block.name !== 'stone') continue
        if (block.name === 'stone' && toolFor('stone') === null) continue
        var dx = block.x - position.x
        var dz = block.z - position.z
        var distance = Math.sqrt(dx * dx + dz * dz)
        // Do not mine the block the bot stands on: the resulting hole makes the
        // return path worse. Side blocks within reach keep the bot on solid ground.
        if (distance < 1.5) continue
        if (distance > 4.2) continue
        if (typeof block.y === 'number' && Math.abs(block.y - position.y) > 2.5) continue
        if (distance < bestDistance) {
          bestDistance = distance
          best = { x: block.x, y: block.y, z: block.z, name: block.name }
        }
      }
      return best
    }

    var have = countOf(inventory, item)
    var had = countOf(baseline, item)
    var enough = have - had >= required

    if (ctx.activeAction) return { kind: 'running', intent: ctx.activeAction.intent }

    var last = ctx.lastOutcome
    var own = last && last.attemptId === ctx.attemptId ? last : null

    if (own && own.intent && own.intent.indexOf('dig:') === 0) {
      if (own.status === 'succeeded' && target && phase !== 'pickup') {
        phase = 'pickup'
        checkpoint = { target: target, phase: phase, failed: failed, returnTo: checkpoint.returnTo, dropGoto: false }
        return { kind: 'running', intent: 'pickup-next', checkpoint: checkpoint }
      }
      if (own.status === 'failed' && target) {
        failed.push(keyOf(target))
        target = null
        phase = 'dig'
      }
    }
    if (own && own.intent && own.intent.indexOf('equip:') === 0 && own.status === 'failed') {
      if (target && target.name === 'stone') {
        failed.push(keyOf(target))
        target = null
        phase = 'dig'
      } else {
        phase = 'dig'
      }
    }
    if (own && own.intent && own.intent.indexOf('pickup:') === 0) {
      if (own.status === 'failed' || (own.status === 'succeeded' && !enough)) {
        if (target) failed.push(keyOf(target))
        target = null
        phase = 'dig'
      }
    }
    if (own && own.intent === 'return' && own.status === 'failed') {
      return {
        kind: 'blocked',
        missing: [],
        diagnostics: [{ code: 'RETURN_FAILED', message: 'could not return to the checkpoint point', detail: own.error || null }],
      }
    }

    if (enough) {
      var returnTo = checkpoint.returnTo
      if (returnTo && typeof returnTo.x === 'number' && facts.known.indexOf('position') >= 0 && distanceTo(returnTo) > 2) {
        return {
          kind: 'propose',
          intent: 'return',
          act: 'goto',
          args: { x: returnTo.x, y: returnTo.y, z: returnTo.z, range: 1, timeoutMs: 30000 },
          checkpoint: { target: target, phase: 'return', failed: failed, returnTo: returnTo },
        }
      }
      return { kind: 'candidate-complete', evidence: ['inventory'], checkpoint: { phase: 'done' } }
    }

    var missing = facts.unknown || []
    if (missing.length > 0) return { kind: 'unknown', missing: missing }

    if (!target) {
      target = chooseTarget()
      if (!target) {
        return {
          kind: 'blocked',
          missing: ['nearbyBlocks'],
          diagnostics: [{ code: 'NO_HARVEST_TARGET', message: 'no safe grass/dirt/stone target within seven blocks' }],
        }
      }
      phase = 'dig'
    }
    if (failed.length >= 8) {
      return {
        kind: 'blocked',
        missing: ['nearbyBlocks'],
        diagnostics: [{ code: 'HARVEST_EXHAUSTED', message: 'eight targets failed' }],
      }
    }

    if (phase === 'pickup') {
      var entities = facts.values.entities || []
      var nearest = null
      var nearestDistance = 1e9
      for (var e = 0; e < entities.length; e += 1) {
        var entity = entities[e]
        if (!entity || entity.name !== 'item' || !entity.position) continue
        var distance = distanceTo(entity.position)
        if (distance < nearestDistance && distance <= 10) {
          nearestDistance = distance
          nearest = entity.position
        }
      }
      if (nearest) {
        return {
          kind: 'propose',
          intent: 'pickup:' + nearest.x + ',' + nearest.y + ',' + nearest.z,
          act: 'goto',
          args: { x: nearest.x, y: nearest.y, z: nearest.z, range: 0.5, timeoutMs: 5000 },
          checkpoint: { target: target, phase: 'pickup', failed: failed, returnTo: checkpoint.returnTo, dropGoto: true },
        }
      }
      if (checkpoint.dropGoto !== true && target) {
        return {
          kind: 'propose',
          intent: 'pickup:' + target.x + ',' + target.y + ',' + target.z,
          act: 'goto',
          args: { x: target.x, y: target.y, z: target.z, range: 1, timeoutMs: 5000 },
          checkpoint: { target: target, phase: 'pickup', failed: failed, returnTo: checkpoint.returnTo, dropGoto: true },
        }
      }
      failed.push(keyOf(target))
      target = null
      return { kind: 'running', intent: 'pickup-lost', checkpoint: { phase: 'dig', failed: failed, returnTo: checkpoint.returnTo } }
    }

    var tool = toolFor(target.name)
    if (tool && checkpoint.equippedFor !== keyOf(target)) {
      return {
        kind: 'propose',
        intent: 'equip:' + tool,
        act: 'equip-item',
        args: { item: tool, destination: 'hand' },
        checkpoint: { target: target, phase: 'dig', failed: failed, returnTo: checkpoint.returnTo, equippedFor: keyOf(target) },
      }
    }
    return {
      kind: 'propose',
      intent: 'dig:' + target.x + ',' + target.y + ',' + target.z,
      act: 'mine-one',
      args: { pos: { x: target.x, y: target.y, z: target.z } },
      checkpoint: { target: target, phase: 'dig', failed: failed, returnTo: checkpoint.returnTo, equippedFor: checkpoint.equippedFor },
    }
  },
})

