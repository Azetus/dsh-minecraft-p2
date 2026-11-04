import type {
  ActivityLayer,
  BaseActivityView,
  DutyState,
  MindActivityView,
} from '../contracts/protocol.ts'

export type ActivityInput = {
  threat: boolean
  /** `escape`, `fight` or `selfCare`; only used for the constant layer. */
  threatKind?: string
  orderVerb?: string
  planActive: boolean
  dutyState?: DutyState
  dutyKind?: string
  base: BaseActivityView
}

/**
 * Effective layer for the current tick: constant > order/plan > duty > base.
 * A blocked or failed duty still owns the layer (it waits for the Agent) so the
 * default base activity cannot resume behind it.
 */
export function resolveActivityLayer(input: ActivityInput): ActivityLayer {
  if (input.threat) return 'constant'
  if (input.orderVerb !== undefined || input.planActive) return 'order'
  if (input.dutyState === 'active' || input.dutyState === 'blocked' || input.dutyState === 'failed') {
    return 'duty'
  }
  return 'base'
}

export function baseAllowed(dutyState: DutyState | undefined): boolean {
  return dutyState === undefined
    || dutyState === 'completed'
    || dutyState === 'cancelled'
}

/** Report the layer that is actually in control, not a suppressed intent. */
export function buildActivityView(input: ActivityInput): MindActivityView {
  const layer = resolveActivityLayer(input)
  if (layer === 'constant') {
    return {
      layer,
      kind: input.threatKind ?? 'escape',
      state: 'active',
      pausedBy: null,
    }
  }
  if (layer === 'order') {
    const kind = input.orderVerb ?? (input.planActive ? 'plan' : 'order')
    return {
      layer,
      kind,
      state: kind === 'hold' ? 'waiting' : 'active',
      pausedBy: null,
    }
  }
  if (layer === 'duty') {
    return {
      layer,
      kind: input.dutyKind ?? 'duty',
      state: input.dutyState === 'active' ? 'active' : 'waiting',
      pausedBy: null,
    }
  }
  const waiting = input.base.waitingReason !== null || input.base.state !== 'active'
  return {
    layer: 'base',
    kind: input.base.kind,
    state: waiting ? 'waiting' : 'active',
    pausedBy: null,
  }
}
