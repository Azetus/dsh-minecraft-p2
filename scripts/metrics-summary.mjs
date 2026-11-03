#!/usr/bin/env node
/**
 * Read-only summary for `.p2/metrics.jsonl` order lines.
 *
 * Usage:
 *   node scripts/metrics-summary.mjs [--file <path>] [--from <iso|ms>] [--to <iso|ms>]
 *                                    [--baseline <path>] [--baseline-from <iso|ms>]
 *                                    [--baseline-to <iso|ms>] [--json]
 *
 * It never writes, never calls the body, and never changes order state.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(`Usage: node scripts/metrics-summary.mjs [options]

Options:
  --file <path>           metrics.jsonl (default: .p2/metrics.jsonl)
  --from <iso|epoch-ms>   include order terminals at/after this time
  --to <iso|epoch-ms>     include order terminals at/before this time
  --baseline <path>       compare against a second metrics file
  --baseline-from <time>  baseline window start (default: no lower bound)
  --baseline-to <time>    baseline window end (default: no upper bound)
  --json                  print machine-readable JSON
  --help                  this message`)
  process.exit(0)
}

const file = resolve(args.file ?? '.p2/metrics.jsonl')
const current = summarize(readMetrics(file), window(args.from, args.to))
const baseline = args.baseline === undefined
  ? undefined
  : summarize(readMetrics(resolve(args.baseline)), window(args.baselineFrom, args.baselineTo))

if (args.json) {
  console.log(JSON.stringify({
    file,
    window: { from: args.from ?? null, to: args.to ?? null },
    current,
    ...(baseline === undefined ? {} : { baseline }),
  }, null, 2))
  process.exit(0)
}

printSummary('current', file, current)
if (baseline !== undefined) {
  console.log('')
  printComparison(baseline, current, resolve(args.baseline), file)
}

function parseArgs(argv) {
  const result = { help: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--help': result.help = true; break
      case '--json': result.json = true; break
      case '--file': result.file = argv[++index]; break
      case '--from': result.from = argv[++index]; break
      case '--to': result.to = argv[++index]; break
      case '--baseline': result.baseline = argv[++index]; break
      case '--baseline-from': result.baselineFrom = argv[++index]; break
      case '--baseline-to': result.baselineTo = argv[++index]; break
      default:
        if (arg.startsWith('--file=')) result.file = arg.slice('--file='.length)
        else if (arg.startsWith('--from=')) result.from = arg.slice('--from='.length)
        else if (arg.startsWith('--to=')) result.to = arg.slice('--to='.length)
        else if (arg.startsWith('--baseline=')) result.baseline = arg.slice('--baseline='.length)
        else if (arg.startsWith('--baseline-from=')) result.baselineFrom = arg.slice('--baseline-from='.length)
        else if (arg.startsWith('--baseline-to=')) result.baselineTo = arg.slice('--baseline-to='.length)
        else throw new Error(`unknown argument: ${arg}`)
    }
  }
  return result
}

function readMetrics(path) {
  if (!existsSync(path)) throw new Error(`metrics file not found: ${path}`)
  const lines = []
  let malformed = 0
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (raw.trim().length === 0) continue
    try {
      const value = JSON.parse(raw)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && typeof value.orderId === 'string') lines.push(value)
      else malformed += 1
    } catch {
      malformed += 1
    }
  }
  return { lines, malformed }
}

function window(from, to) {
  return {
    from: parseTime(from),
    to: parseTime(to),
  }
}

function parseTime(value) {
  if (value === undefined) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && String(numeric) === String(value).trim()) return numeric
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid time: ${value}`)
  return parsed
}

function summarize(input, range) {
  const filtered = input.lines.filter(line => {
    const at = typeof line.at === 'number' ? line.at : line.acceptedAt
    if (typeof at !== 'number') return false
    if (range.from !== undefined && at < range.from) return false
    if (range.to !== undefined && at > range.to) return false
    return true
  })
  const states = { succeeded: 0, failed: 0, blocked: 0, cancelled: 0, abandoned: 0, unknown: 0 }
  const verbs = new Map()
  const codes = new Map()
  const layers = new Map()
  const durations = []
  let attempts = 0
  let attemptsCount = 0
  for (const line of filtered) {
    const state = text(line.state) ?? 'unknown'
    states[state in states ? state : 'unknown'] += 1
    const verb = text(line.verb) ?? 'unknown'
    verbBucket(verbs, verb, state)
    const code = text(line.lastCode) ?? (state === 'succeeded' ? 'OK' : state.toUpperCase())
    const layer = text(line.lastLayer) ?? '-'
    codeBucket(codes, code, layer)
    layers.set(layer, (layers.get(layer) ?? 0) + 1)
    if (typeof line.durationMs === 'number' && Number.isFinite(line.durationMs)) durations.push(line.durationMs)
    if (typeof line.attempts === 'number' && Number.isFinite(line.attempts)) {
      attempts += line.attempts
      attemptsCount += 1
    }
  }
  const total = filtered.length
  const ok = states.succeeded
  return {
    total,
    states,
    okRate: total === 0 ? 0 : ok / total,
    verbs: mapToObject(verbs, value => ({
      total: value.total,
      ok: value.ok,
      failed: value.failed,
      blocked: value.blocked,
    })),
    codes: mapToObject(codes, value => ({
      count: value.count,
      layer: value.layer,
    })),
    layers: mapToObject(layers, count => count),
    duration: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length === 0 ? null : Math.max(...durations),
    },
    attempts: {
      average: attemptsCount === 0 ? null : attempts / attemptsCount,
    },
    malformed: input.malformed,
  }
}

function verbBucket(map, verb, state) {
  let value = map.get(verb)
  if (value === undefined) {
    value = { total: 0, ok: 0, failed: 0, blocked: 0 }
    map.set(verb, value)
  }
  value.total += 1
  if (state === 'succeeded') value.ok += 1
  else if (state === 'blocked') value.blocked += 1
  else if (state !== 'cancelled' && state !== 'abandoned') value.failed += 1
}

function codeBucket(map, code, layer) {
  let value = map.get(code)
  if (value === undefined) {
    value = { count: 0, layer }
    map.set(code, value)
  }
  value.count += 1
  if (value.layer === '-') value.layer = layer
}

function mapToObject(map, convert) {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, convert(value)]))
}

function percentile(values, ratio) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function printSummary(title, file, summary) {
  const states = summary.states
  console.log(`== ${title} ==`)
  console.log(`file: ${file}`)
  console.log(`orders: ${summary.total}  ok: ${states.succeeded} (${rate(summary.okRate)})  failed: ${states.failed}  blocked: ${states.blocked}  cancelled: ${states.cancelled}  unknown: ${states.unknown}`)
  if (summary.malformed > 0) console.log(`malformed lines skipped: ${summary.malformed}`)
  console.log('verbs:')
  for (const [verb, value] of sortedEntries(summary.verbs)) {
    console.log(`  ${verb.padEnd(12)} total ${pad(value.total)}  ok ${pad(value.ok)}  fail ${pad(value.failed)}  blocked ${pad(value.blocked)}`)
  }
  console.log('codes:')
  for (const [code, value] of sortedEntries(summary.codes).slice(0, 12)) {
    console.log(`  ${code.padEnd(24)} ${pad(value.count)}  layer=${value.layer}`)
  }
  console.log('layers:')
  for (const [layer, count] of sortedEntries(summary.layers)) {
    console.log(`  ${layer.padEnd(12)} ${pad(count)}`)
  }
  console.log(`duration: p50 ${ms(summary.duration.p50)}  p95 ${ms(summary.duration.p95)}  max ${ms(summary.duration.max)}`)
  console.log(`attempts: avg ${summary.attempts.average === null ? '-' : summary.attempts.average.toFixed(2)}`)
}

function printComparison(baseline, current, baselineFile, currentFile) {
  console.log('== baseline vs current ==')
  console.log(`baseline: ${baselineFile}`)
  console.log(`current:  ${currentFile}`)
  console.log(`orders:   ${baseline.total} -> ${current.total}`)
  console.log(`ok rate:  ${rate(baseline.okRate)} -> ${rate(current.okRate)} (${delta(current.okRate - baseline.okRate)})`)
  console.log(`failed:   ${baseline.states.failed} -> ${current.states.failed}`)
  console.log(`blocked:  ${baseline.states.blocked} -> ${current.states.blocked}`)
  console.log(`p95:      ${ms(baseline.duration.p95)} -> ${ms(current.duration.p95)}`)

  const baselineCodes = new Map(Object.entries(baseline.codes))
  const currentCodes = new Map(Object.entries(current.codes))
  const codes = [...new Set([...baselineCodes.keys(), ...currentCodes.keys()])]
    .map(code => ({
      code,
      before: baselineCodes.get(code)?.count ?? 0,
      after: currentCodes.get(code)?.count ?? 0,
    }))
    .sort((left, right) => (right.before - left.before) || (right.after - left.after))
  console.log('code changes:')
  for (const entry of codes.slice(0, 10)) {
    console.log(`  ${entry.code.padEnd(24)} ${pad(entry.before)} -> ${pad(entry.after)} (${entry.after - entry.before >= 0 ? '+' : ''}${entry.after - entry.before})`)
  }
}

function sortedEntries(record) {
  return Object.entries(record).sort((left, right) => {
    const leftCount = typeof left[1] === 'number' ? left[1] : left[1].total ?? left[1].count ?? 0
    const rightCount = typeof right[1] === 'number' ? right[1] : right[1].total ?? right[1].count ?? 0
    return rightCount - leftCount
  })
}

function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function rate(value) {
  return `${(value * 100).toFixed(1)}%`
}

function delta(value) {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`
}

function pad(value) {
  return String(value).padStart(4)
}

function ms(value) {
  if (value === null) return '-'
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value)}ms`
}
