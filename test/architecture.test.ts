import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')

function files(dir: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...files(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(path)
  }
  return result
}

/**
 * The single mineflayer boundary. `src/provider/**` is the only code allowed
 * to import the package; everything else (mind, bridge, contracts, motion core)
 * must stay on the pure BodyApi types.
 */
describe('mineflayer boundary', () => {
  it('is imported only from src/provider', () => {
    const offenders: string[] = []
    for (const path of files(SRC)) {
      const relativePath = relative(process.cwd(), path).replace(/\\/gu, '/')
      if (relativePath.startsWith('src/provider/')) continue
      const text = readFileSync(path, 'utf8')
      if (/from\s+['"]mineflayer['"]/u.test(text) || /require\(\s*['"]mineflayer['"]\s*\)/u.test(text)) {
        offenders.push(relativePath)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has no source imports from the deleted port directory', () => {
    const offenders: string[] = []
    for (const path of files(SRC)) {
      const text = readFileSync(path, 'utf8')
      if (/from\s+['"][^'"]*\/?port\//u.test(text)) {
        offenders.push(relative(process.cwd(), path).replace(/\\/gu, '/'))
      }
    }
    expect(offenders).toEqual([])
  })
})
