/** M5 policy: count one item in an inventory snapshot. */
definePolicy({
  manifest: {
    id: 'item-count',
    inputs: ['items', 'name', 'want'],
    outputs: ['count', 'have', 'atLeast'],
  },
  run: function (inputs) {
    var items = inputs.items === undefined || inputs.items === null ? [] : inputs.items
    var name = inputs.name
    var want = inputs.want === undefined ? 1 : inputs.want
    var count = 0
    for (var index = 0; index < items.length; index += 1) {
      if (items[index] !== null && items[index].name === name) count += items[index].count === undefined ? 1 : items[index].count
    }
    return { count: count, have: count > 0, atLeast: count >= want }
  },
})
