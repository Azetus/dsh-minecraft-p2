/**
 * Freeze the code that must not change after T0.
 *
 * Usage: node scripts/accept/freeze.mjs <runDir>
 * Writes <runDir>/code-freeze.json with sha256 of src/**, build scripts,
 * acceptance scripts and the package manifest. Content artifacts (ops/, acts/,
 * strategies/) are intentionally excluded: they may be replaced during the run
 * and are tracked in content.log instead.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const runDir = process.argv[2]
if (!runDir) {
  console.error('usage: freeze.mjs <runDir>')
  process.exit(2)
}
const root = process.cwd()
const targets = [
  'src',
  'scripts/accept',
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'cordis.patch.yml',
  'scripts/build.mjs',
  'scripts/bundle.mjs',
]
const files = {}
function add(path) {
  const absolute = join(root, path)
  const stats = statSync(absolute)
  if (stats.isDirectory()) {
    for (const entry of readdirSync(absolute).sort()) add(join(path, entry))
    return
  }
  files[path.replace(/\\/gu, '/')] = createHash('sha256').update(readFileSync(absolute)).digest('hex')
}
for (const target of targets) add(target)
const manifest = { at: new Date().toISOString(), root, files }
writeFileSync(join(runDir, 'code-freeze.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({ files: Object.keys(files).length, at: manifest.at }))
