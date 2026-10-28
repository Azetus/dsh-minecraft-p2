/** Built-in act: release control effects by submitting the `stop` op. */
defineAct({
  manifest: {
    id: 'stop',
    description: 'Stop movement and release control input.',
    queryOps: [],
    controlOps: ['stop'],
    limits: { totalMs: 5000 },
  },
  create: function () {
    return {
      start: function (ctx) {
        ctx.control('stop', {})
        return { kind: 'complete', result: null }
      },
      update: function () {
        return { kind: 'running' }
      },
      stop: function () {
        return { kind: 'complete' }
      },
      cleanup: function () {
        return { kind: 'complete' }
      },
    }
  },
})
