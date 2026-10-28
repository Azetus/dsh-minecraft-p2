/**
 * M5 S3 variant: mine to the quota, then return home and confirm both facts.
 * The return branch repeats until the completion predicate stops the next move.
 */
export default {
  id: 'm5-gather-return',
  description: 'Mine to the quota, return home, and confirm inventory plus position',
  mode: 'finite',
  parameters: {
    targets: { type: 'json', required: true },
    item: { type: 'string', required: true },
    want: { type: 'number', required: true },
    home: { type: 'json', required: true },
  },
  locals: {
    inv: { type: 'json' },
    verdict: { type: 'json' },
    attempt: { type: 'number', initial: 0 },
    pick: { type: 'json' },
    pos: { type: 'json' },
    atHome: { type: 'json' },
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
        { kind: 'query', id: 'q-pos', query: { op: 'position', args: {} }, output: 'pos' },
        {
          kind: 'decide',
          id: 'at-home',
          policy: { definitionId: 'is-near' },
          inputs: {
            pos: { kind: 'local', name: 'pos' },
            home: { kind: 'param', name: 'home' },
            tolerance: { kind: 'literal', value: 1.2 },
          },
          output: 'atHome',
        },
        {
          kind: 'if',
          id: 'quota-met',
          when: {
            kind: 'expr',
            expr: {
              kind: 'binary', op: 'eq',
              left: { kind: 'member', object: { kind: 'local', name: 'verdict' }, key: { kind: 'literal', value: 'atLeast' } },
              right: { kind: 'literal', value: true },
            },
          },
          then: {
            kind: 'sequence',
            id: 'return',
            children: [
              {
                kind: 'act',
                id: 'go-home',
                act: { definitionId: 'move-to' },
                args: {
                  x: { kind: 'member', object: { kind: 'param', name: 'home' }, key: { kind: 'literal', value: 'x' } },
                  z: { kind: 'member', object: { kind: 'param', name: 'home' }, key: { kind: 'literal', value: 'z' } },
                  tolerance: { kind: 'literal', value: 1.0 },
                  timeoutMs: { kind: 'literal', value: 15000 },
                },
              },
              { kind: 'wait', id: 'settle-home', durationMs: 300 },
            ],
          },
          else: {
            kind: 'sequence',
            id: 'mine',
            children: [
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
                  id: 'dig',
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
                      id: 'mine-one',
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
      ],
    },
  },
  completion: {
    kind: 'predicate',
    condition: {
      kind: 'expr',
      expr: {
        kind: 'binary', op: 'and',
        left: { kind: 'binary', op: 'eq', left: { kind: 'member', object: { kind: 'local', name: 'verdict' }, key: { kind: 'literal', value: 'atLeast' } }, right: { kind: 'literal', value: true } },
        right: { kind: 'binary', op: 'eq', left: { kind: 'member', object: { kind: 'local', name: 'atHome' }, key: { kind: 'literal', value: 'near' } }, right: { kind: 'literal', value: true } },
      },
    },
  },
}
