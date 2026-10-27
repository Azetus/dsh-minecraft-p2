import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const destination = join(root, 'bundles')
await mkdir(destination, { recursive: true })

const npmCli = process.env.npm_execpath
if (!npmCli) {
  console.error('npm_execpath is unavailable; run this script through `npm run bundle`.')
  process.exit(1)
}

const result = spawnSync(process.execPath, [
  npmCli,
  'pack',
  '--pack-destination',
  destination,
  '--cache',
  join(root, '.npm-cache'),
], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
