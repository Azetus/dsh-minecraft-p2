import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkBehavior } from '../src/core/checker.ts'
import { BehaviorExecutor } from '../src/core/executor.ts'
import type { ActHandle, ActPort, QueryPort } from '../src/core/node-runtime.ts'

const sourcePath = join(process.cwd(), 'behaviors', 'approach-target.mjs')
const holdSourcePath = join(process.cwd(), 'behaviors', 'hold-position.mjs')

describe('M4 approach-target behavior', () => {
  it('checks and executes moveTo followed by stop', async () => {
    const checked = await checkBehavior({ sourcePath, bindingId: 'binding-m4', resolveAct: () => 'p2:act:test' })
    expect(checked.artifact.definition.id).toBe('m4-approach-target')
    expect(checked.artifact.definition.mode).toBe('finite')

    const called: string[] = []
    const act: ActPort = {
      start: (ref): ActHandle => {
        called.push(typeof ref === 'string' ? ref : ref.definitionId)
        return { poll: () => ({ status: 'succeeded' }), stop: () => {} }
      },
    }
    const query: QueryPort = () => ({
      status: 'failed',
      error: {
        code: 'QUERY_UNSUPPORTED',
        category: 'validation',
        message: 'not used by this behavior',
        source: { module: 'test' },
        retry: 'never',
      },
    })
    const executor = new BehaviorExecutor({
      definition: checked.artifact.definition,
      params: { x: 10, z: 5, tolerance: 0.6 },
      query,
      act,
    })
    for (let tick = 0; tick < 10 && executor.currentStatus === 'running'; tick += 1) {
      executor.tick(tick)
    }
    expect(executor.currentStatus).toBe('succeeded')
    expect(called).toEqual(['move-to', 'stop'])
  })

  it('checks and runs the continuous hold-position behavior until stopped', async () => {
    const checked = await checkBehavior({ sourcePath: holdSourcePath, bindingId: 'binding-m4', resolveAct: () => 'p2:act:test' })
    expect(checked.artifact.definition.id).toBe('m4-hold-position')
    expect(checked.artifact.definition.mode).toBe('continuous')

    const called: string[] = []
    const executor = new BehaviorExecutor({
      definition: checked.artifact.definition,
      params: { x: 10, z: 5, tolerance: 0.6 },
      query: () => ({
        status: 'failed',
        error: {
          code: 'QUERY_UNSUPPORTED',
          category: 'validation',
          message: 'not used by this behavior',
          source: { module: 'test' },
          retry: 'never',
        },
      }),
      act: {
        start: (ref): ActHandle => {
          called.push(typeof ref === 'string' ? ref : ref.definitionId)
          return { poll: () => ({ status: 'succeeded' }), stop: () => {} }
        },
      },
    })
    for (let tick = 0; tick < 20; tick += 1) executor.tick(tick * 1000)
    expect(executor.currentStatus).toBe('running')
    expect(called.filter(name => name === 'move-to').length).toBeGreaterThan(1)
    executor.stop()
    executor.tick(30_000)
    expect(executor.currentStatus).toBe('cancelled')
  })
})
