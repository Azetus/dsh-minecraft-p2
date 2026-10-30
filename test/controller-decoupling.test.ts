import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const controllerDir = fileURLToPath(new URL('../src/controller/', import.meta.url))

describe('controller/provider decoupling', () => {
  it('never imports a provider or mineflayer from controller sources', () => {
    const files = readdirSync(controllerDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const entry of files) {
      const path = join(entry.parentPath ?? controllerDir, entry.name)
      const source = readFileSync(path, 'utf8')
      expect(source, path).not.toMatch(/from\s+['"][^'"]*\/provider\//)
      expect(source, path).not.toMatch(/from\s+['"]mineflayer/)
      expect(source, path).not.toMatch(/require\(['"]mineflayer/)
    }
  })
})
