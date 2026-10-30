/**
 * Append one content change to content.log (JSONL).
 *
 * Usage:
 *   node scripts/accept/content-log.mjs <runDir> '<json>'
 * The JSON must carry: path, sha256, artifactId, definitionId, version, action,
 * mode, reason, activeVersion, mineflayerApi, notes.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const [runDir, raw] = process.argv.slice(2)
if (!runDir || !raw) {
  console.error('usage: content-log.mjs <runDir> <json-entry>')
  process.exit(2)
}
let entry
try {
  entry = JSON.parse(raw)
} catch (error) {
  console.error(`invalid json: ${error.message}`)
  process.exit(2)
}
const path = resolve(String(entry.path ?? ''))
if (entry.path !== undefined) {
  if (!existsSync(path)) {
    console.error(`content path does not exist: ${path}`)
    process.exit(2)
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (entry.sha256 !== undefined && entry.sha256 !== actual) {
    console.error(`sha256 mismatch for ${path}: logged ${entry.sha256} actual ${actual}`)
    process.exit(2)
  }
  entry.sha256 = actual
}
entry.at = new Date().toISOString()
appendFileSync(join(runDir, 'content.log'), `${JSON.stringify(entry)}\n`)
console.log(JSON.stringify({ logged: true, path: entry.path ?? null, sha256: entry.sha256 ?? null }))
