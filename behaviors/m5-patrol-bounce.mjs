/**
 * M5 S2 variant: bounce patrol A→B→C→B→A.
 * Only the policy and the direction state differ from the cyclic route.
 */
export default {
  id: 'm5-patrol-bounce',
  description: 'Bounce between the ends of the route',
  mode: 'continuous',
  parameters: {
    route: { type: 'json', required: true },
  },
  locals: {
    leg: { type: 'number', initial: 0 },
    dir: { type: 'number', initial: 1 },
    next: { type: 'json' },
  },
  root: {
    kind: 'repeat',
    id: 'loop',
    child: {
      kind: 'sequence',
      id: 'leg',
      children: [
        {
          kind: 'decide',
          id: 'next',
          policy: { definitionId: 'next-waypoint-bounce' },
          inputs: {
            route: { kind: 'param', name: 'route' },
            leg: { kind: 'local', name: 'leg' },
            dir: { kind: 'local', name: 'dir' },
          },
          output: 'next',
        },
        {
          kind: 'act',
          id: 'move',
          act: { definitionId: 'move-to' },
          args: {
            x: { kind: 'member', object: { kind: 'local', name: 'next' }, key: { kind: 'literal', value: 'x' } },
            z: { kind: 'member', object: { kind: 'local', name: 'next' }, key: { kind: 'literal', value: 'z' } },
            tolerance: { kind: 'literal', value: 0.5 },
            timeoutMs: { kind: 'literal', value: 15000 },
          },
        },
        { kind: 'assign', id: 'advance', target: 'leg', value: { kind: 'member', object: { kind: 'local', name: 'next' }, key: { kind: 'literal', value: 'index' } } },
        { kind: 'assign', id: 'steer', target: 'dir', value: { kind: 'member', object: { kind: 'local', name: 'next' }, key: { kind: 'literal', value: 'dir' } } },
        { kind: 'wait', id: 'dwell', durationMs: 300 },
      ],
    },
  },
}
