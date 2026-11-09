import { readFile } from 'node:fs/promises'

import { bindingId as computeBindingId, bodyManifestDigest } from '../contracts/digest.ts'
import type { BindingManifest, BodyInfo, BodyManifest } from '../contracts/index.ts'
import type { BindingId } from '../contracts/types.ts'

/** Read the build-generated manifest next to the body entry. */
export async function loadBodyInfo(entryUrl: string | URL = import.meta.url): Promise<BodyInfo> {
  const url = new URL('./body.manifest.json', entryUrl)
  const manifest = JSON.parse(await readFile(url, 'utf8')) as BodyManifest
  const manifestDigest = bodyManifestDigest(manifest)
  const binding: BindingManifest = {
    schemaVersion: 1,
    body: {
      version: manifest.bodyVersion,
      protocolVersion: manifest.protocolVersion,
      manifestDigest,
    },
    provider: null,
    irVersion: 1,
    opContractVersion: '1',
    driver: null,
    config: {},
  }
  return {
    manifest,
    manifestDigest,
    bindingId: computeBindingId(binding) as BindingId,
    provider: null,
  }
}


