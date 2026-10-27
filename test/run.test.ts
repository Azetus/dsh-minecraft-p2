import { describe, expect, it } from 'vitest'

import {
  defineBehavior,
  externalCompletion,
  sequence,
} from '../src/authoring/index.ts'
import { BehaviorRun } from '../src/core/run.ts'
import type { ActPort, QueryPort } from '../src/core/node-runtime.ts'

const query: QueryPort = () => ({ status: 'ok', value: null })
const act: ActPort = { start: () => ({ poll: () => ({ status: 'failed', error: { code: 'NO_ACT', category: 'runtime', message: 'no act', source: { module: 'test' }, retry: 'never' } }), stop: () => {} }) }

function externalRun(): BehaviorRun {
  return new BehaviorRun({
    runId: 'run-1',
    owner: 'session-1/agent-1',
    definition: defineBehavior({
      id: 'external',
      description: 'external completion',
      mode: 'finite',
      parameters: {},
      locals: {},
      root: sequence('root'),
      completion: externalCompletion('player confirms the result'),
    }),
    params: {},
    query,
    act,
  })
}

describe('BehaviorRun external confirmation', () => {
  it('blocks after root success and accepts one attributed confirmation', () => {
    const run = externalRun()
    expect(run.tick(0)).toBe('blocked')
    expect(run.confirmation?.status).toBe('pending')
    expect(run.confirmation?.question).toContain('confirms')

    const first = run.confirm({
      runId: 'run-1',
      confirmationId: run.confirmation?.id ?? 'missing',
      owner: 'session-1/agent-1',
      source: 'player',
      decision: 'confirm',
      commandId: 'c1',
    })
    expect(first.outcome).toBe('confirmed')
    expect(run.status).toBe('succeeded')
    expect(run.confirmation?.status).toBe('confirmed')

    const duplicate = run.confirm({
      runId: 'run-1',
      confirmationId: run.confirmation?.id ?? 'missing',
      owner: 'session-1/agent-1',
      source: 'player',
      decision: 'confirm',
      commandId: 'c1',
    })
    expect(duplicate).toEqual(first)
  })

  it('rejects wrong run, owner, source, and late decisions', () => {
    const run = externalRun()
    run.tick(0)
    expect(run.confirm({
      runId: 'other', confirmationId: run.confirmation?.id ?? 'missing', owner: 'session-1/agent-1', source: 'player', decision: 'confirm', commandId: 'bad-run',
    }).error?.code).toBe('RUN_NOT_FOUND')
    expect(run.confirm({
      runId: 'run-1', confirmationId: run.confirmation?.id ?? 'missing', owner: 'other', source: 'player', decision: 'confirm', commandId: 'bad-owner',
    }).error?.code).toBe('OWNER_MISMATCH')
    expect(run.confirm({
      runId: 'run-1', confirmationId: run.confirmation?.id ?? 'missing', owner: 'session-1/agent-1', source: '', decision: 'confirm', commandId: 'bad-source',
    }).error?.code).toBe('CONFIRMATION_SOURCE_REQUIRED')
    expect(run.confirm({
      runId: 'run-1', confirmationId: 'wrong', owner: 'session-1/agent-1', source: 'player', decision: 'confirm', commandId: 'bad-confirmation',
    }).error?.code).toBe('CONFIRMATION_MISMATCH')

    run.confirm({
      runId: 'run-1', confirmationId: run.confirmation?.id ?? 'missing', owner: 'session-1/agent-1', source: 'player', decision: 'confirm', commandId: 'ok',
    })
    const late = run.confirm({
      runId: 'run-1', confirmationId: run.confirmation?.id ?? 'missing', owner: 'session-1/agent-1', source: 'player', decision: 'deny', commandId: 'late',
    })
    expect(late.outcome).toBe('rejected')
    expect(late.error?.code).toBe('ALREADY_TERMINAL')
  })

  it('denies a pending request and never reports succeeded', () => {
    const run = externalRun()
    run.tick(0)
    const denied = run.confirm({
      runId: 'run-1', confirmationId: run.confirmation?.id ?? 'missing', owner: 'session-1/agent-1', source: 'player', decision: 'deny', commandId: 'deny',
    })
    expect(denied.outcome).toBe('denied')
    expect(run.status).toBe('failed')
    expect(run.confirmation?.status).toBe('denied')
  })

  it('cancels a pending confirmation and rejects a later decision', () => {
    const run = externalRun()
    run.tick(0)
    run.stop()
    expect(run.tick(1)).toBe('cancelled')
    expect(run.confirmation?.status).toBe('cancelled')
    const late = run.confirm({
      runId: 'run-1', confirmationId: run.confirmation?.id ?? 'missing', owner: 'session-1/agent-1', source: 'player', decision: 'confirm', commandId: 'late-cancel',
    })
    expect(late.outcome).toBe('rejected')
    expect(late.error?.code).toBe('ALREADY_TERMINAL')
  })
})
