import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The provider is published as a bundled ESM file. Vitest normally imports the
 * TypeScript sources, so a CommonJS/ESM interop mistake only shows up after
 * bundling (for example a named import from a CommonJS dependency). Importing
 * the built file here keeps that failure in the fast suite instead of the game.
 */
const builtProvider = join(process.cwd(), 'lib', 'provider', 'minecraft.mjs')

describe('built provider bundle', () => {
  it.skipIf(!existsSync(builtProvider))('loads as ESM and exposes the capability list', async () => {
    // Import through a runtime URL so the test does not need type declarations
    // for the generated file.
    const module = await import(/* @vite-ignore */ pathToFileURL(builtProvider).href) as {
      MineflayerProvider?: unknown
      PROVIDER_CAPABILITIES?: unknown
      PROVIDER_ID?: unknown
    }
    expect(typeof module.MineflayerProvider).toBe('function')
    expect(Array.isArray(module.PROVIDER_CAPABILITIES)).toBe(true)
    expect(module.PROVIDER_CAPABILITIES).toContain('pathfind')
    expect(typeof module.PROVIDER_ID).toBe('string')
  })
})
