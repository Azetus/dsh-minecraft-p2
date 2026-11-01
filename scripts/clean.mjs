import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

for (const path of ['lib', 'coverage', '.dev-home']) {
  await rm(path, { recursive: true, force: true })
}

const bundles = join(process.cwd(), 'bundles')
try {
  for (const entry of await readdir(bundles)) {
    if (entry === '.gitkeep') continue
    await rm(join(bundles, entry), { recursive: true, force: true })
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
