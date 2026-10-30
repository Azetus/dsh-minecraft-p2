/**
 * M0 acceptance: action lease + handover FSM (P2CONTROLLER §3.1, C1).
 *
 * Category: state safety. Protects: no dispatch without a lease, one control
 * slot, revoke→stop→confirm→start ordering, control-fault instead of a silent
 * wait, and generation fencing for late results.
 */

import { describe, expect, it } from 'vitest'

import { ActionLeaseMachine, controlFaultError } from '../src/controller/lease.ts'
import type { ActionHandle, ActionOutcome, ActionRequest, ActuatorPort, ReleaseReport } from '../src/controller/types.ts'
import type { LeaseGrant } from '../src/controller/types.ts'

class FakeHandle implements ActionHandle {
  outcome: ActionOutcome = { status: 'running' }
  stopCalls = 0

  poll(): ActionOutcome {
    return this.outcome
  }

  stop(): void {
    this.stopCalls += 1
  }
}

class FakeActuator implements ActuatorPort {
  readonly starts: Array<{ request: ActionRequest; grant: LeaseGrant; handle: FakeHandle }> = []
  readonly stops: number[] = []
  releaseReport: ReleaseReport = { status: 'released' }
  releaseThrows: Error | undefined
  startThrows: Error | undefined

  start(request: ActionRequest, grant: LeaseGrant): ActionHandle {
    if (this.startThrows !== undefined) throw this.startThrows
    const handle = new FakeHandle()
    this.starts.push({ request, grant, handle })
    return handle
  }

  stop(now: number): void {
    this.stops.push(now)
  }

  release(): ReleaseReport {
    if (this.releaseThrows !== undefined) throw this.releaseThrows
    return this.releaseReport
  }

  get last(): { request: ActionRequest; grant: LeaseGrant; handle: FakeHandle } {
    const entry = this.starts[this.starts.length - 1]
    if (entry === undefined) throw new Error('no action was started')
    return entry
  }
}

function action(intent: string, overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    act: `act-${intent}`,
    args: {},
    intent,
    slot: 'S2',
    holder: `S2:${intent}`,
    ...overrides,
  }
}

function machineWith(actuator: FakeActuator, stopTimeoutMs = 500): { machine: ActionLeaseMachine; clock: { now: number } } {
  const clock = { now: 0 }
  const machine = new ActionLeaseMachine({ actuator, now: () => clock.now, stopTimeoutMs })
  return { machine, clock }
}

describe('ActionLeaseMachine (M0)', () => {
  it('starts under a granted lease and returns the terminal outcome once', () => {
    const actuator = new FakeActuator()
    const { machine } = machineWith(actuator)
    const result = machine.request(action('goto'), 0)
    expect(result.outcome).toBe('started')
    expect(result.grant).toMatchObject({ generation: 1, holder: 'S2:goto' })
    expect(actuator.starts).toHaveLength(1)

    actuator.last.handle.outcome = { status: 'succeeded', result: { ok: true } }
    const tick = machine.tick(10)
    expect(tick.completed?.grant.generation).toBe(1)
    expect(tick.completed?.outcome).toMatchObject({ status: 'succeeded' })
    expect(machine.leaseState).toBe('released')
    expect(machine.tick(20).completed).toBeUndefined()
  })

  it('refuses dispatch without a valid lease or with a stale grant', () => {
    const actuator = new FakeActuator()
    const { machine } = machineWith(actuator)
    const raw = action('goto')

    expect(() => machine.startAction({ leaseId: 'forged', generation: 1, holder: 'S0:x' }, raw)).toThrowError(/requires a granted lease/u)

    const first = machine.request(raw, 0)
    const grant = first.grant
    if (grant === undefined) throw new Error('expected a grant')
    expect(machine.isCurrentGrant(grant)).toBe(true)
    expect(machine.isCurrentGrant({ ...grant, generation: grant.generation - 1 })).toBe(false)
    expect(() => machine.startAction({ ...grant, generation: grant.generation + 1 }, raw)).toThrowError(/control generation/u)

    machine.request(action('escape', { slot: 'S0' }), 10)
    expect(() => machine.startAction(grant, raw)).toThrowError(/requires a granted lease/u)
  })

  it('revokes, stops and only starts the queued action after release is confirmed', () => {
    const actuator = new FakeActuator()
    const { machine, clock } = machineWith(actuator)
    const first = machine.request(action('mine'), 0)
    const firstGrant = first.grant
    if (firstGrant === undefined) throw new Error('expected a grant')
    const firstHandle = actuator.last.handle

    clock.now = 10
    const queued = machine.request(action('retreat', { slot: 'S0' }), 10)
    expect(queued.outcome).toBe('queued')
    expect(firstHandle.stopCalls).toBe(1)
    expect(actuator.stops).toEqual([10])
    expect(machine.leaseState).toBe('revoking')
    expect(machine.controlOpen).toBe(false)
    expect(machine.isCurrentGrant(firstGrant)).toBe(false)

    actuator.releaseReport = { status: 'stopping' }
    clock.now = 100
    machine.request(action('retreat-2', { slot: 'S0' }), 100)
    clock.now = 200
    const stopping = machine.tick(200)
    expect(stopping.started).toBeUndefined()
    expect(stopping.phase).toBe('confirming')
    // No old operation was emitted after the stop request.
    expect(actuator.starts).toHaveLength(1)

    actuator.releaseReport = { status: 'released' }
    const started = machine.tick(300)
    expect(started.started).toMatchObject({ generation: 2 })
    expect(actuator.starts).toHaveLength(2)
    expect(actuator.last.request.intent).toBe('retreat-2')
    expect(machine.controlOpen).toBe(true)
  })

  it('enters control-fault when release is not confirmed before the deadline', () => {
    const actuator = new FakeActuator()
    const { machine, clock } = machineWith(actuator)
    machine.request(action('mine'), 0)
    actuator.releaseReport = { status: 'stopping' }

    clock.now = 10
    expect(machine.request(action('escape', { slot: 'S0' }), 10).outcome).toBe('queued')
    clock.now = 509
    expect(machine.tick(509).phase).toBe('confirming')

    clock.now = 510
    const faulted = machine.tick(510)
    expect(faulted.fault).toMatchObject({ code: 'STOP_TIMEOUT', phase: 'confirming' })
    expect(machine.phase).toBe('control-fault')
    expect(machine.leaseState).toBe('unknown')

    // No new dispatch while the fault is sticky; a request is rejected outright.
    const rejected = machine.request(action('mine-again'), 600)
    expect(rejected.outcome).toBe('rejected')
    expect(rejected.fault?.code).toBe('STOP_TIMEOUT')
    expect(controlFaultError(rejected.fault as NonNullable<typeof rejected.fault>)).toMatchObject({
      code: 'STOP_TIMEOUT',
      category: 'control',
    })
    expect(actuator.starts).toHaveLength(1)

    // A late but valid release clears the fault; the queued wish is discarded.
    actuator.releaseReport = { status: 'released' }
    const cleared = machine.tick(700)
    expect(cleared.faultCleared).toBe(true)
    expect(machine.phase).toBe('idle')
    expect(actuator.starts).toHaveLength(1)

    const retried = machine.request(action('mine-again'), 800)
    expect(retried.outcome).toBe('started')
    expect(retried.grant?.generation).toBe(3)
  })

  it('turns an unconfirmed release into a control fault immediately', () => {
    const actuator = new FakeActuator()
    const { machine, clock } = machineWith(actuator)
    machine.request(action('mine'), 0)
    actuator.releaseReport = { status: 'unconfirmed', detail: 'provider cannot observe idle' }
    clock.now = 10
    machine.request(action('escape', { slot: 'S0' }), 10)

    const tick = machine.tick(20)
    expect(tick.fault).toMatchObject({ code: 'CONTROL_OUTCOME_UNKNOWN' })
    expect(machine.controlOpen).toBe(false)
  })

  it('does not reset the handover deadline when a newer request is queued', () => {
    const actuator = new FakeActuator()
    const { machine, clock } = machineWith(actuator)
    machine.request(action('mine'), 0)
    actuator.releaseReport = { status: 'stopping' }

    clock.now = 10
    machine.request(action('escape', { slot: 'S0' }), 10)
    expect(machine.deadline).toBe(510)
    clock.now = 400
    machine.request(action('escape-2', { slot: 'S0' }), 400)
    expect(machine.deadline).toBe(510)
    clock.now = 510
    expect(machine.tick(510).fault?.code).toBe('STOP_TIMEOUT')
  })

  it('fences late results from a revoked generation without acquiring control', () => {
    const actuator = new FakeActuator()
    const { machine, clock } = machineWith(actuator)
    const first = machine.request(action('mine'), 0)
    const firstGrant = first.grant as LeaseGrant
    const oldHandle = actuator.last.handle
    expect(machine.classifyResult(firstGrant.generation, 1)).toBe('current')

    clock.now = 10
    machine.request(action('escape', { slot: 'S0' }), 10)
    expect(machine.classifyResult(firstGrant.generation, 20)).toBe('stale')

    // The old action resolves while the slot is still stopping: nothing happens.
    oldHandle.outcome = { status: 'succeeded', result: { mined: true } }
    actuator.releaseReport = { status: 'stopping' }
    const tick = machine.tick(30)
    expect(tick.completed).toBeUndefined()
    expect(machine.phase).toBe('confirming')
    expect(machine.eventLog.some(event => event.kind === 'stale-result')).toBe(true)
    expect(actuator.starts).toHaveLength(1)
  })

  it('treats a throwing start as unknown control and requires release proof', () => {
    const actuator = new FakeActuator()
    actuator.startThrows = new Error('act artifact is not registered')
    const { machine } = machineWith(actuator)
    const result = machine.request(action('goto'), 0)
    expect(result.outcome).toBe('rejected')
    expect(machine.phase).toBe('control-fault')
    expect(machine.controlFault?.code).toBe('CONTROL_OUTCOME_UNKNOWN')
    expect(actuator.starts).toHaveLength(0)
  })

  it('records a bounded handover history', () => {
    const actuator = new FakeActuator()
    const clock = { now: 0 }
    const machine = new ActionLeaseMachine({ actuator, now: () => clock.now, maxEvents: 4 })
    for (let index = 0; index < 6; index += 1) {
      machine.request(action(`step-${index}`), clock.now)
      actuator.last.handle.outcome = { status: 'succeeded' }
      machine.tick(clock.now + 1)
      clock.now += 2
    }
    expect(machine.eventLog.length).toBe(4)
  })
})
