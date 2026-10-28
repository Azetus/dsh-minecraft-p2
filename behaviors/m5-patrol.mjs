/**
 * M5 S2: continuous patrol along a cyclic route.
 * Arrival is confirmed by the move act; only then the leg advances.
 */
export default {
  id: 'm5-patrol',
  description: 'Cycle through the given route and wait at each waypoint',
  mode: 'continuous',
  parameters: {
    route: { type: 'json', required: true },
  },
  locals: {
    leg: { type: 'number', initial: 0 },
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
          policy: { definitionId: 'next-waypoint' },
          inputs: {
            route: { kind: 'param', name: 'route' },
            leg: { kind: 'local', name: 'leg' },
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
        { kind: 'wait', id: 'dwell', durationMs: 500 },
      ],
    },
  },
}
