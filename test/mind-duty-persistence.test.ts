import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('restores an active duty, active time and job count', () => {
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
      // The 200 ms already spent active is preserved; downtime is not counted.
      activeMs: 200,
      deadline: 61_100,
    })
  })

  it('recomputes collected from the baseline and inventory', () => {
    const path = statePath()
    const first = new DutyController({ statePath: path, identity })
    first.start({ kind: 'gather', item: 'dirt', quota: 3 }, 0, [{ slot: 36, name: 'dirt', count: 5 }])

    const second = new DutyController({ statePath: path, identity })
    expect(second.restore([{ slot: 36, name: 'dirt', count: 7 }], 100))
      .toMatchObject({ state: 'active', collected: 2, baseline: 5 })
  })

  it('does not count paused time against the deadline', () => {
    const path = statePath()
    const first = new DutyController({ statePath: path, identity })
    first.start({ kind: 'gather', item: 'dirt', quota: 4, maxWallMs: 1_000 }, 0)
    first.setPaused(true, 100)
    first.setPaused(false, 1_100)
    // 100 ms active before the pause, 400 ms active after it.
    const view = first.refresh([], 1_500)
    expect(view).toMatchObject({ state: 'active', activeMs: 500, pausedMs: 1_000 })
  })

  it('migrates a v1 sidecar and blocks an expired deadline', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({
      v: 1,
      savedAt: 0,
      identity,
      duty: {
        id: 'duty-old',
        kind: 'gather',
        item: 'dirt',
        quota: 4,
        radius: 16,
        maxJobs: 8,
        maxWallMs: 1_000,
        state: 'active',
        jobs: 0,
        startedAt: 0,
        deadline: 1_000,
      },
    })}\n`, 'utf8')

    const second = new DutyController({ statePath: path, identity })
    expect(second.restore([], 2_000)).toMatchObject({ state: 'blocked', lastError: 'DUTY_DEADLINE' })
    expect(second.takeTerminal()).toMatchObject({ id: 'duty-old', state: 'blocked' })

    const third = new DutyController({ statePath: path, identity })
    expect(third.restore([], 2_100)).toBeUndefined()
  })

  it('does not restore cancelled or identity-mismatched duties', () => {
    const path = statePath()
    const first = new DutyController({ statePath: path, identity })
    first.start({ kind: 'gather', item: 'dirt', quota: 1 }, 0)
    first.stop(1)

    expect(new DutyController({ statePath: path, identity }).restore([], 2)).toBeUndefined()

    const other = new DutyController({ statePath: path, identity: { worldId: 'world-1', characterId: 'other' } })
    expect(other.restore([], 2)).toBeUndefined()
  })
})
