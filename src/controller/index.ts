/**
 * P2Controller public surface.
 *
 * The controller is a library-level resident component: a binding supplies the
 * actuator/sense ports and installs strategies. It is deliberately not wired
 * into the body scheduler yet — the strategy substrate (§12 of the design) is
 * still undecided, and the body keeps a single control mode.
 */

export { P2Controller } from './controller.ts'
export type {
  CommitmentSummary,
  ControllerDecision,
  ControllerEvent,
  ControllerEventKind,
  ControllerStatus,
  DecisionCandidate,
  FactSource,
  P2ControllerOptions,
  SensePort,
  SenseResult,
  SlotEvaluation,
  StallState,
  VerificationState,
} from './controller.ts'
export { ActionLeaseMachine, controlFaultError } from './lease.ts'
export type { HandoverRequestResult, HandoverTickResult, LeaseMachineOptions, ResultClassification } from './lease.ts'
export { ObservationBus } from './observation.ts'
export type { Fact, FactRead, FactSample, FactSet, ObservationBusOptions, ReadOptions } from './observation.ts'
export { ActionMemory } from './memory.ts'
export type { ActionMemoryOptions, EscapePhase, FailureRecord, HazardRecord } from './memory.ts'
export {
  CommitmentStore,
  countItem,
  isTerminal,
  verifyPostCondition,
} from './commitment.ts'
export type {
  Baseline,
  BlockedInfo,
  Commitment,
  CommitmentSpec,
  CommitmentState,
  CommitmentView,
  Diagnostic,
  EvidenceRef,
  PostCondition,
  VerificationResult,
} from './commitment.ts'
export { StrategyRegistry } from './strategy.ts'
export type {
  InstallMode,
  InstallResult,
  Progress,
  Strategy,
  StrategyBinding,
  StrategyBindingState,
  StrategyContext,
  StrategyLastOutcome,
  StrategyPhase,
  StrategyVerdict,
} from './strategy.ts'
export { SLOTS, SLOT_ORDER, compareCandidates, slotRank } from './slots.ts'
export type { SlotDefinition } from './slots.ts'
export type {
  ActionHandle,
  ActionOutcome,
  ActionProgress,
  ActionRequest,
  ActuatorPort,
  ControlFault,
  ControlFaultCode,
  Generation,
  HandoverEvent,
  HandoverPhase,
  HazardClass,
  LeaseGrant,
  LeaseState,
  ReleaseReport,
  Scope,
  SlotId,
} from './types.ts'
export { HAZARD_RANK } from './types.ts'
export * from './strategies/index.ts'


