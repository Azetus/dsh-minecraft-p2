/**
 * Extract per-checkpoint evidence from the body's authored-op log.
 *
 * The campaign op writes one `[campaign-evidence] <json>` line when a stage
 * changes state. This script is the only bridge from the body log to the
 * acceptance evidence directory; it never talks to the game.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [logPath, outDir] = process.argv.slice(2)
if (!logPath || !outDir) {
  console.error('usage: extract.mjs <op.log> <evidence-dir>')
  process.exit(2)
}
const STAGES = { shelter: 'cp1', bed: 'cp2', tools: 'cp3', copper: 'cp4', smelt: 'cp5' }
const MARK = '[campaign-evidence] '
const lines = readFileSync(logPath, 'utf8').split(/\r?\n/u)
const extracted = {}
let malformed = 0
for (const line of lines) {
  const index = line.indexOf(MARK)
  if (index < 0) continue
  let value
  try {
    value = JSON.parse(line.slice(index + MARK.length))
  } catch {
    malformed += 1
    continue
  }
  if (!value || typeof value.stage !== 'string' || STAGES[value.stage] === undefined) continue
  extracted[value.stage] = value
}
let missing = 0
for (const [stage, cp] of Object.entries(STAGES)) {
  const dir = join(outDir, cp)
  mkdirSync(dir, { recursive: true })
  const evidence = extracted[stage]
  if (evidence === undefined) {
    writeFileSync(join(dir, 'MISSING.txt'), `no evidence for stage ${stage}\n`)
    missing += 1
    continue
  }
  writeFileSync(join(dir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  for (const key of ['blocks', 'inventory', 'position', 'time', 'steps', 'events', 'camp', 'bed', 'sleep', 'respawn', 'crafted', 'copper', 'smelt']) {
    if (evidence[key] !== undefined) {
      writeFileSync(join(dir, `${key}.json`), `${JSON.stringify(evidence[key], null, 2)}\n`)
    }
  }
  // convenience snapshots required by the acceptance book
  const inventory = evidence.inventory ?? []
  const position = evidence.position ?? {}
  const time = evidence.time ?? {}
  writeFileSync(join(dir, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`)
  writeFileSync(join(dir, 'position.json'), `${JSON.stringify(position, null, 2)}\n`)
  writeFileSync(join(dir, 'time.json'), `${JSON.stringify(time, null, 2)}\n`)
  if (evidence.blocks === undefined) writeFileSync(join(dir, 'blocks.json'), '[]\n')
}
writeFileSync(join(outDir, 'extract-summary.json'), `${JSON.stringify({
  extracted: Object.keys(extracted).sort(),
  missing,
  malformed,
  at: new Date().toISOString(),
}, null, 2)}\n`)
console.log(JSON.stringify({ extracted: Object.keys(extracted).sort(), missing, malformed }))
if (missing > 0) process.exitCode = 1
