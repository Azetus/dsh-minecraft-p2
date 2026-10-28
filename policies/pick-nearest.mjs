/**
 * M5 policy: pick the nearest dropped item from a snapshot.
 * Pure decision; no operations, no imports, no host objects.
 */
definePolicy({
  manifest: {
    id: 'pick-nearest',
    inputs: ['drops', 'self'],
    outputs: ['kind', 'id', 'x', 'z'],
  },
  run: function (inputs) {
    var drops = inputs.drops === undefined || inputs.drops === null ? [] : inputs.drops
    var self = inputs.self === undefined || inputs.self === null ? { x: 0, z: 0 } : inputs.self
    var best = null
    var bestDistance = 0
    for (var index = 0; index < drops.length; index += 1) {
      var drop = drops[index]
      if (drop === null || drop === undefined || drop.position === null || drop.position === undefined) continue
      var dx = drop.position.x - self.x
      var dz = drop.position.z - self.z
      var distance = dx * dx + dz * dz
      if (best === null || distance < bestDistance || (distance === bestDistance && drop.id < best.id)) {
        best = drop
        bestDistance = distance
      }
    }
    if (best === null) return { kind: 'none' }
    return { kind: 'target', id: best.id, x: best.position.x, z: best.position.z }
  },
})
