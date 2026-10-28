import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildRescueCommand, executeRescue } from '../src/body/rescue.ts'
import type { RescueProvider } from '../src/body/rescue.ts'
import type { RescueParams } from '../src/contracts/protocol.ts'

function params(overrides: Partial<RescueParams>): RescueParams {
  return {
    action: 'tp',
    x: 10,
    y: 64,
    z: 10,
    reason: 'stuck outside the platform',
    category: 'stuck',
    ...overrides,
  }
}

const position = { x: 1, y: 64, z: 2 }

describe('rescue command builder', () => {
  it('allows a short self teleport', () => {
    expect(buildRescueCommand(params({ x: 4, y: 65, z: 5 }), position, 32)).toBe('/tp @s 4 65 5')
  })

  it('rejects a teleport beyond the rescue radius', () => {
    expect(() => buildRescueCommand(params({ x: 100, y: 64, z: 100 }), position, 32)).toThrow(/exceeds/u)
  })

  it('allows only the three self effects and bounded duration', () => {
    expect(buildRescueCommand(params({ action: 'effect', effect: 'regeneration', durationSeconds: 5, amplifier: 1 }), position, 32))
      .toBe('/effect give @s minecraft:regeneration 5 1')
    expect(() => buildRescueCommand(params({ action: 'effect', effect: 'poison' as never }), position, 32)).toThrow(/not allowed/u)
    expect(() => buildRescueCommand(params({ action: 'effect', effect: 'regeneration', durationSeconds: 60 }), position, 32)).toThrow(/out of range/u)
  })

  it('requires a reason and a known action', () => {
    expect(() => buildRescueCommand(params({ reason: '' }), position, 32)).toThrow(/reason/u)
    expect(() => buildRescueCommand(params({ action: 'give' as never }), position, 32)).toThrow(/unknown/u)
  })

  it('respawn is a single kill command', () => {
    expect(buildRescueCommand(params({ action: 'respawn', reason: 'trapped in a block', category: 'trapped' }), position, 32))
      .toBe('/kill @s')
  })
})

describe('executeRescue', () => {
  function provider(): { provider: RescueProvider; commands: string[] } {
    const commands: string[] = []
    return {
      commands,
      provider: {
        query: op => op === 'position'
          ? { status: 'ok', value: position }
          : { status: 'ok', value: { health: 20, food: 20 } },
        sendCommand: command => { commands.push(command) },
      },
    }
  }

  it('refuses when rescue is disabled', async () => {
    const fake = provider()
    await expect(executeRescue(fake.provider, params({}), {
      allowRescue: false,
      tpRadius: 32,
      auditPath: join(tmpdir(), 'p2-rescue-unused.jsonl'),
      owner: 'owner',
    })).rejects.toThrow(/disabled/u)
    expect(fake.commands).toEqual([])
  })

  it('sends the command and appends one audit record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2-rescue-'))
    const auditPath = join(dir, 'rescue.jsonl')
    try {
      const fake = provider()
      const result = await executeRescue(fake.provider, params({}), {
        allowRescue: true,
        tpRadius: 32,
        auditPath,
        owner: 'owner',
      })
      expect(result.command).toBe('/tp @s 10 64 10')
      expect(result.sent).toBe(true)
      expect(fake.commands).toEqual(['/tp @s 10 64 10'])
      expect(existsSync(auditPath)).toBe(true)
      const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        auditId: result.auditId,
        command: '/tp @s 10 64 10',
        reason: 'stuck outside the platform',
        category: 'stuck',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
