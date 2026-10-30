/**
 * hazard-escape (S0): water, lava and hostile proximity.
 *
 * This is the only path that may preempt the task slot. It reads only the
 * position/health/entities facts; it never proposes a non-emergency action.
 */
defineStrategy({
  manifest: {
    id: 'hazard-escape',
    version: '1',
    slot: 'S0',
    hazardClass: 'lethal',
    facts: ['position', 'health', 'entities', 'camp'],
    acts: ['escape'],
    description: 'escape water/lava/hostile danger without a model round trip',
  },
  evaluate: function (ctx) {
    var facts = ctx.facts
    if (!facts || !facts.values) return { kind: 'unknown', missing: ['facts'] }
    if (facts.unknown && facts.unknown.indexOf('position') >= 0) return { kind: 'unknown', missing: ['position'] }
    var position = facts.values.position || {}
    var health = facts.values.health || {}
    var entities = facts.values.entities || []
    var x = typeof position.x === 'number' ? position.x : 0
    var y = typeof position.y === 'number' ? position.y : 0
    var z = typeof position.z === 'number' ? position.z : 0
    var hazard = function (kind, radius, ttlMs) {
      return { id: kind + ':' + Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z), kind: kind, x: x, y: y, z: z, radius: radius, ttlMs: ttlMs }
    }
    if (position.inLava === true) {
      return {
        kind: 'propose',
        intent: 'escape-lava',
        act: 'escape',
        args: { mode: 'lava' },
        hazard: hazard('lava', 2, 600000),
      }
    }
    if (position.inWater === true && typeof health.oxygen === 'number' && health.oxygen < 120) {
      return {
        kind: 'propose',
        intent: 'escape-water',
        act: 'escape',
        args: { mode: 'water' },
        hazard: hazard('water', 2, 600000),
      }
    }
    var nearest = null
    var nearestDistance = 1e9
    var camp = facts.values.camp || {}
    if (camp.inside === 1) {
      // Inside the sealed shelter the walls are the protection: fleeing inside
      // a 3x3 room cannot create distance and would only burn retry budget.
      return { kind: 'idle' }
    }
    for (var i = 0; i < entities.length; i += 1) {
      var entity = entities[i]
      if (!entity || !entity.position) continue
      if (entity.kind !== 'Hostile mobs') continue
      var distance = entity.distance
      if (typeof distance !== 'number') continue
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = entity
      }
    }
    if (nearest !== null) {
      var creeper = nearest.name === 'creeper' && nearestDistance <= 5
      var hurt = typeof health.health === 'number' && health.health <= 8 && nearestDistance <= 5
      if (creeper || hurt) {
        return {
          kind: 'propose',
          intent: 'escape-hostile',
          act: 'escape',
          args: { mode: 'hostile' },
          hazard: hazard('hostile', 3, 300000),
        }
      }
    }
    return { kind: 'idle' }
  },
})
