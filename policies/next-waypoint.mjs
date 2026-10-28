/**
 * M5 policy: next waypoint of a cyclic route.
 * `leg` is the last reached index; the next index wraps at the end.
 */
definePolicy({
  manifest: {
    id: 'next-waypoint',
    inputs: ['route', 'leg'],
    outputs: ['kind', 'index', 'x', 'z'],
  },
  run: function (inputs) {
    var route = inputs.route === undefined || inputs.route === null ? [] : inputs.route
    if (route.length === 0) return { kind: 'none' }
    var leg = inputs.leg === undefined ? 0 : inputs.leg
    var index = (leg + 1) % route.length
    var point = route[index]
    return { kind: 'target', index: index, x: point.x, z: point.z }
  },
})
