export default {
  id: 'm3-g3-stop',
  description: 'G3 external stop fixture',
  mode: 'finite',
  parameters: {},
  locals: { phase: { type: 'string' } },
  root: {
    kind: 'sequence',
    id: 'root',
    children: [
      {
        kind: 'act',
        id: 'look',
        act: 'look',
        args: { yaw: { kind: 'literal', value: 1.5707963267948966 }, pitch: { kind: 'literal', value: 0.2 } },
      },
      {
        kind: 'act',
        id: 'move',
        act: 'move',
        args: {
          direction: { kind: 'literal', value: 'forward' },
          durationMs: { kind: 'literal', value: 300000 },
        },
      },
      {
        kind: 'act',
        id: 'stop',
        act: 'stop',
        args: {},
      },
      {
        kind: 'assign',
        id: 'phase-done',
        target: 'phase',
        value: { kind: 'literal', value: 'done' },
      },
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
