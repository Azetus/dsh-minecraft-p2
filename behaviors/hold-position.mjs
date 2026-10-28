/**
 * M4 continuous behavior: keep a bot near a fixed x/z target.
 *
 * This is a bounded, non-destructive test behavior for a flat world. It does
 * not pathfind, mine, place, attack, or use items. The owner can change the
 * target by stopping this run and switching to a new run with new params.
 */
export default {
  id: 'm4-hold-position',
  description: 'Continuously hold a horizontal position near a target x/z',
  mode: 'continuous',
  parameters: {
    x: { type: 'number', required: true },
    z: { type: 'number', required: true },
    tolerance: { type: 'number', required: true },
  },
  locals: {},
  root: {
    kind: 'repeat',
    id: 'hold',
    child: {
      kind: 'sequence',
      id: 'cycle',
      children: [
        {
          kind: 'act',
          id: 'approach',
          act: { definitionId: 'move-to' },
          args: {
            x: { kind: 'param', name: 'x' },
            z: { kind: 'param', name: 'z' },
            tolerance: { kind: 'param', name: 'tolerance' },
            timeoutMs: { kind: 'literal', value: 10000 },
            blockedMs: { kind: 'literal', value: 1500 },
          },
        },
        { kind: 'act', id: 'stop', act: { definitionId: 'stop' }, args: {} },
        { kind: 'wait', id: 'settle', durationMs: 500 },
      ],
    },
  },
}
