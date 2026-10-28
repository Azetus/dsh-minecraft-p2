/**
 * M5 S1: pick the nearest dropped item and prove it with a fresh inventory query.
 * Finite: success requires the inventory evidence, not the entity disappearing.
 */
export default {
  id: 'm5-pick-nearest',
  description: 'Pick the nearest item entity and confirm it in the inventory',
  mode: 'finite',
  parameters: {
    item: { type: 'string', required: true },
  },
  locals: {
    drops: { type: 'json' },
    self: { type: 'json' },
    pick: { type: 'json' },
    inv: { type: 'json' },
    verdict: { type: 'json' },
  },
  root: {
    kind: 'sequence',
    id: 'root',
    children: [
      {
        kind: 'query',
        id: 'q-drops',
        query: { op: 'entities', args: { objectType: { kind: 'literal', value: 'Item' } } },
        output: 'drops',
      },
      { kind: 'query', id: 'q-self', query: { op: 'position', args: {} }, output: 'self' },
      {
        kind: 'decide',
        id: 'pick',
        policy: { definitionId: 'pick-nearest' },
        inputs: {
          drops: { kind: 'local', name: 'drops' },
          self: { kind: 'local', name: 'self' },
        },
        output: 'pick',
      },
      {
        kind: 'if',
        id: 'has-target',
        when: {
          kind: 'expr',
          expr: {
            kind: 'binary', op: 'eq',
            left: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'kind' } },
            right: { kind: 'literal', value: 'target' },
          },
        },
        then: {
          kind: 'sequence',
          id: 'go',
          children: [
            {
              kind: 'act',
              id: 'move',
              act: { definitionId: 'move-to' },
              args: {
                x: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'x' } },
                z: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'z' } },
                tolerance: { kind: 'literal', value: 0.6 },
                timeoutMs: { kind: 'literal', value: 15000 },
              },
            },
            { kind: 'wait', id: 'settle', durationMs: 800 },
          ],
        },
        else: { kind: 'fail', id: 'no-target', code: 'NO_CANDIDATE', message: 'no item entity is visible' },
      },
      { kind: 'query', id: 'q-inv', query: { op: 'inventory', args: {} }, output: 'inv' },
      {
        kind: 'decide',
        id: 'count',
        policy: { definitionId: 'item-count' },
        inputs: {
          items: { kind: 'local', name: 'inv' },
          name: { kind: 'param', name: 'item' },
          want: { kind: 'literal', value: 1 },
        },
        output: 'verdict',
      },
      {
        kind: 'if',
        id: 'verify',
        when: {
          kind: 'expr',
          expr: {
            kind: 'binary', op: 'eq',
            left: { kind: 'member', object: { kind: 'local', name: 'verdict' }, key: { kind: 'literal', value: 'have' } },
            right: { kind: 'literal', value: true },
          },
        },
        then: { kind: 'wait', id: 'settled', durationMs: 1 },
        else: { kind: 'fail', id: 'gone', code: 'TARGET_GONE', message: 'the selected item never reached the inventory' },
      },
    ],
  },
  completion: {
    kind: 'predicate',
    condition: {
      kind: 'expr',
      expr: {
        kind: 'binary', op: 'eq',
        left: { kind: 'member', object: { kind: 'local', name: 'verdict' }, key: { kind: 'literal', value: 'have' } },
        right: { kind: 'literal', value: true },
      },
    },
  },
}
