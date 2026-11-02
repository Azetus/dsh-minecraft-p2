import { createRules, type RuleSet } from '../model/rules.ts'
import {
  defaultConstraints,
  type BlockClassifier,
  type MotionConstraints,
  type MotionWorld,
  type MoveContext,
} from '../model/types.ts'

/** One rules snapshot per tick; cached reads are invalidated at the boundary. */
export class MotionContextSource {
  private readonly rules: RuleSet

  constructor(
    private readonly world: MotionWorld,
    private readonly constraints: MotionConstraints = defaultConstraints(),
    classifier?: BlockClassifier,
  ) {
    this.rules = createRules(world, constraints, classifier === undefined ? {} : { classifier })
  }

  next(): MoveContext {
    this.rules.invalidate()
    const self = this.world.self()
    return {
      world: this.world,
      rules: this.rules,
      constraints: this.constraints,
      self,
      tick: this.world.tick(),
      now: Date.now(),
      position: self.pos,
    }
  }
}
