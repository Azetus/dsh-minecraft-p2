import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = process.cwd()
const lib = join(root, 'lib')
const esbuildCli = join(root, 'node_modules/esbuild/bin/esbuild')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await rm(lib, { recursive: true, force: true })

function compile(entry, outfile, extraArgs = []) {
  const out = join(root, outfile)
  mkdirSync(dirname(out), { recursive: true })
  const result = spawnSync(process.execPath, [
    esbuildCli,
    join(root, entry),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    `--outfile=${out}`,
    ...extraArgs,
  ], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

compile('src/bridge/index.ts', 'lib/bridge.js', ['--packages=external'])
compile('src/body/index.ts', 'lib/body/body.mjs')
compile('src/authoring/index.ts', 'lib/authoring/index.js')

const body = await readFile(join(root, 'lib/body/body.mjs'))
const bodyManifest = {
  schemaVersion: 1,
  bodyVersion: pkg.version,
  protocolVersion: 1,
  entry: 'body.mjs',
  files: { 'body.mjs': sha256(body) },
}
await writeFile(join(root, 'lib/body/body.manifest.json'), `${JSON.stringify(bodyManifest, null, 2)}\n`)

if (existsSync(join(root, 'src/provider/index.ts'))) {
  compile('src/provider/index.ts', 'lib/provider/minecraft.mjs', ['--packages=external'])
  const provider = await readFile(join(root, 'lib/provider/minecraft.mjs'))
  const providerManifest = {
    schemaVersion: 1,
    providerId: 'mineflayer',
    providerVersion: pkg.version,
    opContractVersion: '1',
    protocolVersion: 1,
    capabilities: ['query.position', 'query.inventory', 'query.entities', 'query.time', 'query.block', 'act.look', 'act.move', 'act.moveTo', 'act.jump', 'act.stop'],
    gameCompatibility: ['1.21.1'],
    entry: 'minecraft.mjs',
    files: { 'minecraft.mjs': sha256(provider) },
  }
  await writeFile(join(root, 'lib/provider/provider.manifest.json'), `${JSON.stringify(providerManifest, null, 2)}\n`)
}

console.log('built lib/bridge.js, lib/body/body.mjs, lib/authoring/index.js')
