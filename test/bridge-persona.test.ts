import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PersonaProvider } from '../src/bridge/persona.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempFile(content?: string): string {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.p2-persona-test-'))
  dirs.push(dir)
  const path = join(dir, 'persona.md')
  if (content !== undefined) writeFileSync(path, content)
  return path
}

describe('workspace persona provider', () => {
  it('reads the workspace file and updates it when mtime/size changes', () => {
    const path = tempFile('first persona')
    const provider = new PersonaProvider({ path, fallbackText: 'default' })
    expect(provider.read()).toMatchObject({ text: 'first persona', path, truncated: false })
    writeFileSync(path, 'second persona with a different length')
    expect(provider.read()).toMatchObject({ text: 'second persona with a different length' })
  })

  it('uses the fallback for a missing or empty file', () => {
    const missing = new PersonaProvider({ path: tempFile(), fallbackText: 'fallback' })
    expect(missing.read().text).toBe('fallback')
    expect(missing.read().path).toBeUndefined()
    const empty = new PersonaProvider({ path: tempFile('   \n'), fallbackText: 'fallback' })
    expect(empty.read()).toMatchObject({ text: 'fallback' })
  })

  it('truncates by UTF-8 bytes while preserving whole characters', () => {
    const path = tempFile('一二三四五六七八九十')
    const provider = new PersonaProvider({ path, fallbackText: 'fallback', maxBytes: 9 })
    const read = provider.read()
    expect(read.truncated).toBe(true)
    expect(read.text).toBe('一二三')
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(9)
  })

  it('treats a missing file as the default every time without a stale cache', () => {
    const path = tempFile()
    const provider = new PersonaProvider({ path, fallbackText: 'fallback' })
    expect(provider.read().text).toBe('fallback')
    writeFileSync(path, 'appeared')
    expect(provider.read().text).toBe('appeared')
  })
})
