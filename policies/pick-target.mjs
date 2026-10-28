/** M5 policy: pick the next fixed target for a quota run. */
definePolicy({
  manifest: {
    id: 'pick-target',
    inputs: ['targets', 'attempt'],
    outputs: ['kind', 'pos', 'stand'],
  },
  run: function (inputs) {
    var targets = inputs.targets === undefined || inputs.targets === null ? [] : inputs.targets
    var attempt = inputs.attempt === undefined ? 0 : inputs.attempt
    if (attempt < 0 || attempt >= targets.length) return { kind: 'none' }
    var target = targets[attempt]
    return { kind: 'target', pos: target.pos, stand: target.stand }
  },
})
