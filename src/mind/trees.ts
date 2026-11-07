import type { TreeNode } from './tree.ts'

/**
 * The two selection trees live in code. The JSON content layer was removed so
 * a new giver branch is a normal code change with type checking, not a second
 * definition format. `loadTrees` still validates registered ids, depth and
 * cycles before the runtime uses the set.
 */
export const CONSTANT_TREE: TreeNode = {
  type: 'priority',
  children: [
    { type: 'giver', ref: 'threat.fight' },
    { type: 'giver', ref: 'escape' },
    { type: 'giver', ref: 'self.eat' },
    { type: 'giver', ref: 'self.unstuck' },
  ],
}

export const MAIN_TREE: TreeNode = {
  type: 'priority',
  children: [
    { type: 'giver', ref: 'check' },
    { type: 'giver', ref: 'order.go' },
    { type: 'giver', ref: 'order.attack' },
    { type: 'giver', ref: 'order.dig' },
    { type: 'giver', ref: 'order.collect' },
    { type: 'giver', ref: 'order.place' },
    { type: 'giver', ref: 'order.equip' },
    { type: 'giver', ref: 'order.use' },
    { type: 'giver', ref: 'order.craft' },
    { type: 'giver', ref: 'order.container' },
    { type: 'giver', ref: 'order.traverse' },
    { type: 'giver', ref: 'order.hold' },
    { type: 'giver', ref: 'material.gather' },
    { type: 'giver', ref: 'plan.work' },
    { type: 'giver', ref: 'duty.work' },
    { type: 'giver', ref: 'base.work' },
  ],
}

export const TREE_DEFINITIONS: Record<string, TreeNode> = {
  constant: CONSTANT_TREE,
  main: MAIN_TREE,
}
