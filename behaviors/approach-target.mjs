/**
 * M4 finite behavior: approach a horizontal target and stop.
 *
 * This is deliberately non-destructive: it uses only moveTo + stop. The
 * provider's moveTo act is a flat-ground controller (no pathfinder).
 */
export default {
  id: 'm4-approach-target',
  description: 'Approach a target x/z and stop; no block interaction',
  mode: 'finite',
  parameters: {
    x: { type: 'number', required: true },
    z: { type: 'number', required: true },
    tolerance: { type: 'number', required: true },
  },
  locals: {
    phase: { type: 'string' },
  },
  root: {
    kind: 'sequence',
    id: 'root',
    children: [
      {
        kind: 'act',
        id: 'approach',
        act: { definitionId: 'move-to' },
        args: {
          x: { kind: 'param', name: 'x' },
          z: { kind: 'param', name: 'z' },
          tolerance: { kind: 'param', name: 'tolerance' },
          timeoutMs: { kind: 'literal', value: 15000 },
          blockedMs: { kind: 'literal', value: 1500 },
        },
      },
      { kind: 'act', id: 'stop', act: { definitionId: 'stop' }, args: {} },
      { kind: 'assign', id: 'done', target: 'phase', value: { kind: 'literal', value: 'done' } },
    ],
  },
  completion: {
    kind: 'predicate',
    condition: {
      kind: 'expr',
      expr: {
        kind: 'binary',
        op: 'eq',
        left: { kind: 'local', name: 'phase' },
        right: { kind: 'literal', value: 'done' },
      },
    },
  },
}
