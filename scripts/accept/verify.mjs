/**
 * Independent acceptance verifier.
 *
 * Usage: node scripts/accept/verify.mjs <runDir> [--dev]
 *
 * Reads only files written during the run (evidence extracted from the body's
 * op log, code freeze, metadata, content log). It never talks to the game and
 * never imports the op/strategy code it is checking. Exit code 0 = pass.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const runDir = resolve(process.argv[2] ?? '')
const dev = process.argv.includes('--dev')
const root = process.cwd()
const lines = []
let failures = 0
function record(ok, name, detail) {
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
  if (!ok) failures += 1
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
const AIR = new Set(['air', 'cave_air', 'void_air'])
const FLUID = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column'])
const FURNITURE = /^(torch|wall_torch|soul_torch|soul_wall_torch|crafting_table|furnace|blast_furnace|smoker|.*_bed)$/u
const DOOR = /_door$/u
const BED = /_bed$/u

function blockMap(blocks) {
  const map = new Map()
  for (const block of blocks ?? []) {
    if (block && typeof block.x === 'number') map.set(`${block.x},${block.y},${block.z}`, block.name)
  }
  return map
}
function countItem(inventory, name) {
  let total = 0
  for (const item of inventory ?? []) if (item && item.name === name) total += item.count
  return total
}

// ------------------------------------------------------------------ metadata
let metadata = null
try {
  metadata = readJson(join(runDir, 'run-metadata.json'))
  record(true, 'run-metadata present')
} catch (error) {
  record(false, 'run-metadata present', error.message)
}
if (metadata !== null) {
  record(typeof metadata.t0 === 'string' && metadata.t0.length > 0, 'metadata.t0')
  record(metadata.keepInventory === true, 'metadata.keepInventory true', String(metadata.keepInventory))
  record(metadata.commandsUsed === 0, 'metadata.commandsUsed == 0', String(metadata.commandsUsed))
  record(metadata.rescueUsed === false, 'metadata.rescueUsed == false', String(metadata.rescueUsed))
  record(typeof metadata.t0WorldAge === 'number', 'metadata.t0WorldAge recorded')
  record(metadata.minecraftVersion === '1.21.1', 'minecraft version 1.21.1')
}

// --------------------------------------------------------------- code freeze
try {
  const freeze = readJson(join(runDir, 'code-freeze.json'))
  let changed = 0
  let checked = 0
  for (const [path, digest] of Object.entries(freeze.files ?? {})) {
    const absolute = join(freeze.root ?? root, path)
    if (!existsSync(absolute)) { changed += 1; lines.push(`FAIL freeze-missing ${path}`); continue }
    checked += 1
    if (sha256(absolute) !== digest) { changed += 1; lines.push(`FAIL freeze-changed ${path}`) }
  }
  record(changed === 0, 'code-freeze unchanged', `${checked} files checked, ${changed} changed`)
} catch (error) {
  record(false, 'code-freeze readable', error.message)
}

// -------------------------------------------------------------- content log
try {
  const entries = readFileSync(join(runDir, 'content.log'), 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
  record(entries.length > 0, 'content.log non-empty', `${entries.length} entries`)
  const lastByPath = new Map()
  let shaped = 0
  for (const entry of entries) {
    if (typeof entry.path === 'string' && typeof entry.sha256 === 'string' && typeof entry.action === 'string') shaped += 1
    if (typeof entry.path === 'string') lastByPath.set(entry.path, entry)
  }
  record(shaped === entries.length, 'content.log entries shaped', `${shaped}/${entries.length}`)
  let mismatch = 0
  for (const [path, entry] of lastByPath) {
    const absolute = resolve(root, path)
    if (!existsSync(absolute)) { mismatch += 1; lines.push(`FAIL content-missing ${path}`); continue }
    if (sha256(absolute) !== entry.sha256) { mismatch += 1; lines.push(`FAIL content-changed ${path}`) }
  }
  record(mismatch === 0, 'content.log matches final content', `${lastByPath.size} paths`)
} catch (error) {
  record(false, 'content.log readable', error.message)
}

// --------------------------------------------------------------- rescue audit
try {
  const audit = join(runDir, '..', 'rescue.jsonl')
  if (existsSync(audit)) {
    const entries = readFileSync(audit, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    const t0 = metadata === null ? 0 : Date.parse(metadata.t0)
    const after = entries.filter(entry => Date.parse(entry.at ?? '') >= t0)
    record(after.length === 0, 'no rescue/command after T0', `${after.length} entries after T0`)
  } else {
    record(true, 'no rescue audit file')
  }
} catch (error) {
  record(false, 'rescue audit readable', error.message)
}

// --------------------------------------------------------------------- CP1
try {
  const evidence = readJson(join(runDir, 'cp1', 'evidence.json'))
  const room = evidence.camp?.room
  const doorCells = evidence.camp?.door ?? []
  const blocks = blockMap(evidence.blocks)
  record(room !== undefined && room.min !== undefined, 'cp1 room geometry recorded')
  let interior = true
  let torchInside = 0
  let missing = 0
  for (let x = room.min.x; x <= room.max.x; x += 1) {
    for (let z = room.min.z; z <= room.max.z; z += 1) {
      for (let y = room.min.y; y <= room.max.y; y += 1) {
        const name = blocks.get(`${x},${y},${z}`)
        if (name === undefined) { missing += 1; interior = false; continue }
        if (AIR.has(name)) continue
        if (FURNITURE.test(name)) { if (/torch/u.test(name)) torchInside += 1; continue }
        interior = false
      }
    }
  }
  record(interior && missing === 0, 'cp1 interior is 3x3x2 open', `missing=${missing}`)
  // dimensions: exactly 3 x 3 x 2
  record(room.max.x - room.min.x === 2 && room.max.z - room.min.z === 2 && room.max.y - room.min.y === 1, 'cp1 interior size 3x3x2')
  const doorSet = new Set(doorCells.map(cell => `${cell.x},${cell.y},${cell.z}`))
  let sealed = true
  const boundary = []
  for (let x = room.min.x; x <= room.max.x; x += 1) {
    for (let z = room.min.z; z <= room.max.z; z += 1) {
      boundary.push([x, room.min.y - 1, z])
      boundary.push([x, room.max.y + 1, z])
    }
  }
  for (let y = room.min.y; y <= room.max.y; y += 1) {
    for (let z = room.min.z; z <= room.max.z; z += 1) {
      boundary.push([room.min.x - 1, y, z])
      boundary.push([room.max.x + 1, y, z])
    }
    for (let x = room.min.x; x <= room.max.x; x += 1) {
      boundary.push([x, y, room.min.z - 1])
      boundary.push([x, y, room.max.z + 1])
    }
  }
  for (const [x, y, z] of boundary) {
    const key = `${x},${y},${z}`
    const name = blocks.get(key)
    if (doorSet.has(key)) {
      if (name === undefined || !DOOR.test(name)) sealed = false
      continue
    }
    if (name === undefined || AIR.has(name) || FLUID.has(name)) sealed = false
  }
  record(sealed, 'cp1 boundary closed (floor/ceiling/4 walls)')
  record(doorCells.length === 2 && doorCells.every(cell => DOOR.test(blocks.get(`${cell.x},${cell.y},${cell.z}`) ?? '')), 'cp1 2-cell door in the wall')
  record(torchInside > 0, 'cp1 torch inside', `torch cells=${torchInside}`)
  record(evidence.camp?.doorToggled === true, 'cp1 door opened and closed')
  const pos = evidence.position ?? {}
  const inside = Math.floor(pos.x ?? 1e9) >= room.min.x && Math.floor(pos.x ?? 1e9) <= room.max.x
    && Math.floor(pos.z ?? 1e9) >= room.min.z && Math.floor(pos.z ?? 1e9) <= room.max.z
    && Math.floor(pos.y ?? 1e9) >= room.min.y && Math.floor(pos.y ?? 1e9) <= room.max.y + 1
  record(inside, 'cp1 bot inside the shelter')
  if (!dev) {
    const t = evidence.time ?? {}
    record(typeof t.timeOfDay === 'number' && t.timeOfDay < 12000, 'cp1 before nightfall (timeOfDay < 12000)', String(t.timeOfDay))
  }
} catch (error) {
  record(false, 'cp1 evidence readable', error.message)
}

// --------------------------------------------------------------------- CP2
try {
  const evidence = readJson(join(runDir, 'cp2', 'evidence.json'))
  const blocks = blockMap(evidence.blocks)
  const bedCells = evidence.bed?.cells ?? []
  record(bedCells.length === 2, 'cp2 bed occupies 2 cells')
  record(bedCells.every(cell => BED.test(blocks.get(`${cell.x},${cell.y},${cell.z}`) ?? '')), 'cp2 bed blocks read back')
  const sleepEvent = (evidence.events ?? []).find(entry => entry.kind === 'sleep')
  record(sleepEvent !== undefined, 'cp2 sleep event recorded')
  if (sleepEvent !== undefined) {
    const timeOfDay = sleepEvent.detail?.timeOfDay
    record(typeof timeOfDay === 'number' && timeOfDay >= 12000 && timeOfDay <= 24000, 'cp2 slept at night', String(timeOfDay))
    if (!dev) record(timeOfDay < 24000, 'cp2 within day one (timeOfDay < 24000)')
  }
  const respawn = evidence.respawn
  record(respawn?.ok === true, 'cp2 respawn point is the bed', JSON.stringify(respawn?.position ?? null))
  if (respawn?.ok === true) {
    const [rx, ry, rz] = respawn.position
    record(bedCells.some(cell => Math.abs(cell.x - rx) <= 1 && Math.abs(cell.y - ry) <= 1 && Math.abs(cell.z - rz) <= 1), 'cp2 respawn cell within the bed footprint')
    record(respawn.deathPosition !== undefined && typeof respawn.deathPosition.health === 'number', 'cp2 death observed before respawn')
  }
} catch (error) {
  record(false, 'cp2 evidence readable', error.message)
}

// --------------------------------------------------------------------- CP3
try {
  const evidence = readJson(join(runDir, 'cp3', 'evidence.json'))
  const crafted = evidence.crafted ?? []
  const wanted = ['stone_pickaxe', 'stone_axe', 'stone_sword']
  for (const name of wanted) {
    const entry = crafted.find(item => item.item === name)
    record(entry !== undefined && entry.after > entry.before, `cp3 crafted ${name}`, entry === undefined ? 'no craft event' : `${entry.before}->${entry.after}`)
    record(countItem(evidence.inventory, name) >= 1, `cp3 inventory has ${name}`)
  }
  if (!dev) {
    const t = evidence.time ?? {}
    record(typeof t.timeOfDay === 'number' && t.timeOfDay < 48000, 'cp3 within deadline', String(t.timeOfDay))
  }
} catch (error) {
  record(false, 'cp3 evidence readable', error.message)
}

// --------------------------------------------------------------------- CP4
try {
  const evidence = readJson(join(runDir, 'cp4', 'evidence.json'))
  const copper = evidence.copper
  record(copper !== undefined, 'cp4 copper evidence present')
  if (copper !== undefined) {
    record(/copper_ore$/u.test(copper.blockBefore?.name ?? ''), 'cp4 mined a copper ore block', String(copper.blockBefore?.name))
    record(copper.blockAfter === 'air' || copper.blockAfter === 'cave_air', 'cp4 ore block is gone after dig', String(copper.blockAfter))
    record((copper.rawCopper ?? 0) + (copper.copperOre ?? 0) >= 1, 'cp4 raw copper/ore in inventory', `raw=${copper.rawCopper} ore=${copper.copperOre}`)
  }
  if (!dev) {
    const t = evidence.time ?? {}
    record(typeof t.timeOfDay === 'number' && t.timeOfDay < 60000, 'cp4 within deadline', String(t.timeOfDay))
  }
} catch (error) {
  record(false, 'cp4 evidence readable', error.message)
}

// --------------------------------------------------------------------- CP5
try {
  const evidence = readJson(join(runDir, 'cp5', 'evidence.json'))
  const smelt = evidence.smelt
  record(smelt !== undefined, 'cp5 smelt evidence present')
  if (smelt !== undefined) {
    record(smelt.smelted?.item === 'copper_ingot', 'cp5 smelted output is copper_ingot', String(smelt.smelted?.item))
    record(/^(raw_copper|copper_ore)$/u.test(smelt.input ?? ''), 'cp5 input was raw copper/ore', String(smelt.input))
    record(countItem(evidence.inventory, 'copper_ingot') >= 1, 'cp5 inventory has copper_ingot', String(countItem(evidence.inventory, 'copper_ingot')))
  }
  if (metadata !== null) {
    const t = evidence.time ?? {}
    record(typeof t.worldAge === 'number' && typeof metadata.t0WorldAge === 'number'
      && t.worldAge <= metadata.t0WorldAge + 72000, 'cp5 within T0 + 72000 ticks', String(t.worldAge - (metadata.t0WorldAge ?? 0)))
  }
} catch (error) {
  record(false, 'cp5 evidence readable', error.message)
}

// --------------------------------------------------------------------- output
const summary = { at: new Date().toISOString(), dev, failures, checks: lines.length }
writeFileSync(join(runDir, 'verifier.log'), `${lines.join('\n')}\n${JSON.stringify(summary)}\n`)
console.log(lines.join('\n'))
console.log(JSON.stringify(summary))
process.exitCode = failures === 0 ? 0 : 1
