/**
 * M5 S3: mine fixed targets until the inventory reaches a quota.
 * The act handles one selected block; the loop and the goal live here.
 */
export default {
  id: 'm5-gather-quota',
  description: 'Mine fixed targets until the inventory holds `want` items',
  mode: 'finite',
  parameters: {
    targets: { type: 'json', required: true },
    item: { type: 'string', required: true },
    want: { type: 'number', required: true },
  },
  locals: {
    inv: { type: 'json' },
    verdict: { type: 'json' },
    attempt: { type: 'number', initial: 0 },
    pick: { type: 'json' },
  },
  root: {
    kind: 'repeat',
    id: 'loop',
    child: {
      kind: 'sequence',
      id: 'step',
      children: [
        { kind: 'query', id: 'q-inv', query: { op: 'inventory', args: {} }, output: 'inv' },
        {
          kind: 'decide',
          id: 'count',
          policy: { definitionId: 'item-count' },
          inputs: {
            items: { kind: 'local', name: 'inv' },
            name: { kind: 'param', name: 'item' },
            want: { kind: 'param', name: 'want' },
          },
          output: 'verdict',
        },
        {
          kind: 'decide',
          id: 'pick',
          policy: { definitionId: 'pick-target' },
          inputs: {
            targets: { kind: 'param', name: 'targets' },
            attempt: { kind: 'local', name: 'attempt' },
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
            id: 'mine',
            children: [
              {
                kind: 'act',
                id: 'approach',
                act: { definitionId: 'move-to' },
                args: {
                  x: { kind: 'member', object: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'stand' } }, key: { kind: 'literal', value: 'x' } },
                  z: { kind: 'member', object: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'stand' } }, key: { kind: 'literal', value: 'z' } },
                  tolerance: { kind: 'literal', value: 1.4 },
                  timeoutMs: { kind: 'literal', value: 15000 },
                },
              },
              {
                kind: 'act',
                id: 'dig',
                act: { definitionId: 'mine-one' },
                args: {
                  pos: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'pos' } },
                },
              },
              {
                kind: 'act',
                id: 'collect',
                act: { definitionId: 'move-to' },
                args: {
                  x: { kind: 'binary', op: 'add', left: { kind: 'member', object: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'pos' } }, key: { kind: 'literal', value: 'x' } }, right: { kind: 'literal', value: 0.5 } },
                  z: { kind: 'binary', op: 'add', left: { kind: 'member', object: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'pos' } }, key: { kind: 'literal', value: 'z' } }, right: { kind: 'literal', value: 0.5 } },
                  tolerance: { kind: 'literal', value: 0.9 },
                  timeoutMs: { kind: 'literal', value: 10000 },
                },
              },
              { kind: 'wait', id: 'settle', durationMs: 900 },
              {
                kind: 'assign',
                id: 'advance',
                target: 'attempt',
                value: { kind: 'binary', op: 'add', left: { kind: 'local', name: 'attempt' }, right: { kind: 'literal', value: 1 } },
              },
            ],
          },
          else: { kind: 'fail', id: 'exhausted', code: 'INSUFFICIENT_RESOURCE', message: 'no target left before the quota was met' },
        },
      ],
    },
  },
  completion: {
    kind: 'predicate',
    condition: {
      kind: 'expr',
      expr: {
        kind: 'binary', op: 'eq',
        left: { kind: 'member', object: { kind: 'local', name: 'verdict' }, key: { kind: 'literal', value: 'atLeast' } },
        right: { kind: 'literal', value: true },
      },
    },
  },
}
