/**
 * M5 S4: patrol, interrupt to pick up a nearby item, then resume the same leg.
 * The route leg is behavior state, so re-entering the patrol branch re-issues
 * the movement to the waypoint that was not reached yet.
 */
export default {
  id: 'm5-patrol-pickup-fail',
  description: 'Patrol a route and interrupt it to collect visible items',
  mode: 'continuous',
  parameters: {
    route: { type: 'json', required: true },
  },
  locals: {
    leg: { type: 'number', initial: 0 },
    next: { type: 'json' },
    drops: { type: 'json' },
    self: { type: 'json' },
    pick: { type: 'json' },
  },
  root: {
    kind: 'repeat',
    id: 'loop',
    child: {
      kind: 'reactivePriority',
      id: 'select',
      branches: [
        {
          when: {
            kind: 'query',
            query: { op: 'entities', args: { objectType: { kind: 'literal', value: 'Item' } } },
            test: {
              kind: 'binary',
              op: 'gt',
              left: { kind: 'length', value: { kind: 'local', name: 'result' } },
              right: { kind: 'literal', value: 0 },
            },
          },
          child: {
            kind: 'sequence',
            id: 'pickup',
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
                else: { kind: 'fail', id: 'gone', code: 'TARGET_GONE', message: 'the pickup target disappeared' },
                then: {
                  kind: 'sequence',
                  id: 'walk',
                  children: [
                    {
                      kind: 'act',
                      id: 'move',
                      act: { definitionId: 'move-to' },
                      args: {
                        x: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'x' } },
                        z: { kind: 'member', object: { kind: 'local', name: 'pick' }, key: { kind: 'literal', value: 'z' } },
                        tolerance: { kind: 'literal', value: 0.6 },
                        timeoutMs: { kind: 'literal', value: 20000 },
                      },
                    },
                    { kind: 'wait', id: 'settle', durationMs: 600 },
                  ],
                },
              },
            ],
          },
        },
        {
          when: { kind: 'expr', expr: { kind: 'literal', value: true } },
          child: {
            kind: 'sequence',
            id: 'patrol',
            children: [
              {
                kind: 'decide',
                id: 'next',
                policy: { definitionId: 'next-waypoint' },
                inputs: {
                  route: { kind: 'param', name: 'route' },
                  leg: { kind: 'local', name: 'leg' },
                },
                output: 'next',
              },
              {
                kind: 'act',
                id: 'leg',
                act: { definitionId: 'move-to' },
                args: {
                  x: { kind: 'member', object: { kind: 'local', name: 'next' }, key: { kind: 'literal', value: 'x' } },
                  z: { kind: 'member', object: { kind: 'local', name: 'next' }, key: { kind: 'literal', value: 'z' } },
                  tolerance: { kind: 'literal', value: 0.5 },
                  timeoutMs: { kind: 'literal', value: 15000 },
                },
              },
              { kind: 'assign', id: 'advance', target: 'leg', value: { kind: 'member', object: { kind: 'local', name: 'next' }, key: { kind: 'literal', value: 'index' } } },
              { kind: 'wait', id: 'dwell', durationMs: 500 },
            ],
          },
        },
      ],
    },
  },
}
