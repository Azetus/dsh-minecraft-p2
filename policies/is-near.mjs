/** M5 policy: is the bot within tolerance of a home point? */
definePolicy({
  manifest: {
    id: 'is-near',
    inputs: ['pos', 'home', 'tolerance'],
    outputs: ['near', 'distance'],
  },
  run: function (inputs) {
    var pos = inputs.pos === undefined || inputs.pos === null ? { x: 0, z: 0 } : inputs.pos
    var home = inputs.home === undefined || inputs.home === null ? { x: 0, z: 0 } : inputs.home
    var tolerance = inputs.tolerance === undefined ? 1 : inputs.tolerance
    var distance = Math.sqrt((pos.x - home.x) * (pos.x - home.x) + (pos.z - home.z) * (pos.z - home.z))
    return { near: distance <= tolerance, distance: distance }
  },
})
