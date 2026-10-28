/** M5 policy variant: bounce between route ends (A→B→C→B→A). */
definePolicy({
  manifest: {
    id: 'next-waypoint-bounce',
    inputs: ['route', 'leg', 'dir'],
    outputs: ['kind', 'index', 'dir', 'x', 'z'],
  },
  run: function (inputs) {
    var route = inputs.route === undefined || inputs.route === null ? [] : inputs.route
    if (route.length === 0) return { kind: 'none' }
    var leg = inputs.leg === undefined ? 0 : inputs.leg
    var dir = inputs.dir === undefined ? 1 : inputs.dir
    var next = leg + dir
    if (next < 0 || next >= route.length) next = leg - dir
    var point = route[next]
    return { kind: 'target', index: next, dir: next - leg, x: point.x, z: point.z }
  },
})
