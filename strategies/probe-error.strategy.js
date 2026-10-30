/**
 * Smoke-test strategy: always throws. Used to verify that cross-realm strategy
 * errors reach controller diagnostics with their real message.
 */
defineStrategy({
  manifest: {
    id: 'probe-error',
    version: '1',
    slot: 'S2',
    facts: ['position'],
    description: 'throw one error for diagnostics',
  },
  evaluate: function (ctx) {
    throw new Error('probe-error-boom')
  },
})

