import { readFile } from 'node:fs/promises'

import { bodyManifestDigest } from '../contracts/digest.ts'
import type { BodyInfo, BodyManifest } from '../contracts/index.ts'

/** Read the build-generated manifest next to the body entry. */
export async function loadBodyInfo(entryUrl: string | URL = import.meta.url): Promise<BodyInfo> {
  const url = new URL('./body.manifest.json', entryUrl)
  const manifest = JSON.parse(await readFile(url, 'utf8')) as BodyManifest
  return {
    manifest,
    manifestDigest: bodyManifestDigest(manifest),
    bindingId: null,
    capabilities: [],
    provider: null,
  }
}
