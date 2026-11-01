import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DutyController } from '../src/mind/duty.ts'

const dirs: string[] = []

function statePath(): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-duty-'))
  dirs.push(dir)
  return join(dir, 'duty.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const identity = { worldId: 'world-1', characterId: 'char-1' }

describe('duty persistence', () => {
  it('restores an active duty, deadline and job count', () => {
    const path = statePath()
    const first = new DutyController({ statePath: path, identity })
    first.start({ kind: 'gather', item: 'dirt', quota: 8, maxJobs: 20, maxWallMs: 60_000 }, 1_000)
    first.recordJobStart(1_100)
    first.recordJobStart(1_200)
    expect(existsSync(path)).toBe(true)

    const second = new DutyController({ statePath: path, identity })
    expect(second.restore([], 1_300)).toMatchObject({
      item: 'dirt',
      jobs: 2,
      state: 'active',
      deadline: 61_000,
    })
  })

  it('recomputes collected from inventory and completes at quota', () => {
    const path = statePath()
    const first = new DutyController({ statePath: path, identity })
    first.start({ kind: 'gather', item: 'dirt', quota: 2 }, 0)

    const second = new DutyController({ statePath: path, identity })
    expect(second.restore([{ slot: 36, name: 'dirt', count: 2 }], 100))
      .toMatchObject({ state: 'completed', collected: 2 })
  })

  it('blocks an expired duty instead of resurrecting it', () => {
    const path = statePath()
    const first = new DutyController({ statePath: path, identity })
    first.start({ kind: 'gather', item: 'dirt', quota: 4, maxWallMs: 1_000 }, 0)

    const second = new DutyController({ statePath: path, identity })
    expect(second.restore([], 2_000)).toMatchObject({ state: 'blocked', lastError: 'DUTY_DEADLINE' })

    const third = new DutyController({ statePath: path, identity })
    expect(third.restore([], 2_100)).toBeUndefined()
  })

  it('does not restore stopped or identity-mismatched duties', () => {
    const path = statePath()
    const first = new DutyController({ statePath: path, identity })
    first.start({ kind: 'gather', item: 'dirt', quota: 1 }, 0)
    first.stop(1)

    expect(new DutyController({ statePath: path, identity }).restore([], 2)).toBeUndefined()

    const other = new DutyController({ statePath: path, identity: { worldId: 'world-1', characterId: 'other' } })
    expect(other.restore([], 2)).toBeUndefined()
  })
})
