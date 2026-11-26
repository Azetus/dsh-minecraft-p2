import type { BodyApi, Item } from '../../body/api.ts'

export type LoadCrossbowOptions = {
  /** Upper bound for holding the trigger before release. */
  chargeWaitMs?: number
  /** Upper bound for the item update after release. */
  settleWaitMs?: number
  /** Poll interval; also bounds stop responsiveness. */
  pollMs?: number
  now?: () => number
  isStopped?: () => boolean
  onChargeTick?: () => Promise<void>
}

export type LoadCrossbowResult = {
  state: 'succeeded' | 'failed' | 'interrupted'
  code?: string
  observed: {
    kind: 'load-crossbow'
    alreadyLoaded: boolean
    chargedBefore: string[] | undefined
    chargedAfter: string[] | undefined
    chargeMs: number
    released: boolean
    shotObserved: boolean
    stopped: boolean
    item?: string
  }
}

const DEFAULT_CHARGE_WAIT_MS = 1_500
const DEFAULT_SETTLE_WAIT_MS = 1_200
const DEFAULT_POLL_MS = 50

/**
 * Load one crossbow and stop before firing.
 *
 * This is the only crossbow load implementation. It works for both observed
 * server behaviours: 1.21.1 loads on release; 26.1.2 loads during the hold at
 * full charge. The action never activates a second time, so a successful load
 * cannot fire. A stale "unloaded" read is detected if an arrow appears while
 * loading and reported as CROSSBOW_UNEXPECTED_FIRE.
 */
export async function loadCrossbow(
  body: BodyApi,
  options: LoadCrossbowOptions = {},
): Promise<LoadCrossbowResult> {
  const now = options.now ?? (() => Date.now())
  const chargeWaitMs = Math.max(100, options.chargeWaitMs ?? DEFAULT_CHARGE_WAIT_MS)
  const settleWaitMs = Math.max(100, options.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS)
  const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS)
  const stopped = (): boolean => options.isStopped?.() === true
  const startedAt = now()
  let released = false

  const initial = body.held?.()
  if (initial === undefined || normalize(initial.name) !== 'crossbow') {
    return failed('CROSSBOW_NOT_HELD', startedAt, now(), undefined, false, false)
  }
  const chargedBefore = initial.chargedProjectiles
  if (chargedBefore === undefined) {
    return failed('CROSSBOW_LOAD_STATE_UNKNOWN', startedAt, now(), chargedBefore, false, false)
  }
  if (chargedBefore.length > 0) {
    const check = validateProjectiles(chargedBefore)
    if (!check.ok) return failed(check.code, startedAt, now(), chargedBefore, false, false)
    return {
      state: 'succeeded',
      observed: {
        kind: 'load-crossbow',
        alreadyLoaded: true,
        chargedBefore,
        chargedAfter: chargedBefore,
        chargeMs: 0,
        released: false,
        shotObserved: false,
        stopped: false,
        item: initial.name,
      },
    }
  }
  if (!hasArrow(body)) {
    return failed('CROSSBOW_NO_PROJECTILE', startedAt, now(), chargedBefore, false, false)
  }
  if (normalize(body.offhand?.()?.name) === 'firework_rocket') {
    return failed('CROSSBOW_UNSUPPORTED_PROJECTILE', startedAt, now(), chargedBefore, false, false)
  }
  if (body.itemUseStart === undefined || body.itemUseRelease === undefined) {
    return failed('CROSSBOW_LOAD_UNSUPPORTED', startedAt, now(), chargedBefore, false, false)
  }

  const beforeArrows = new Set(arrowIds(body))
  const started = await body.itemUseStart()
  if (started.state !== 'ok') {
    return failed(started.code ?? 'CROSSBOW_LOAD_START_FAILED', startedAt, now(), chargedBefore, false, false)
  }

  let chargedAfter: string[] | undefined = chargedBefore
  let shotObserved = false
  // The loader owns the active use stance, including when a combat input fails.
  const pollStop = async (): Promise<boolean> => {
    if (stopped()) return true
    try {
      await options.onChargeTick?.()
    } catch (error) {
      await cancel(body)
      throw error
    }
    return stopped()
  }
  const chargeDeadline = now() + chargeWaitMs
  while (now() < chargeDeadline) {
    if (await pollStop()) {
      chargedAfter = body.held?.()?.chargedProjectiles
      await cancel(body)
      return interrupted(startedAt, now(), chargedBefore, chargedAfter, released, shotObserved, initial.name)
    }
    const held = body.held?.()
    chargedAfter = held?.chargedProjectiles
    if (chargedAfter !== undefined && chargedAfter.length > 0) break
    if (newArrow(body, beforeArrows)) {
      shotObserved = true
      await cancel(body)
      return failed(
        'CROSSBOW_UNEXPECTED_FIRE',
        startedAt,
        now(),
        chargedBefore,
        released,
        shotObserved,
        initial.name,
      )
    }
    await sleep(pollMs)
  }

  if (chargedAfter === undefined || chargedAfter.length === 0) {
    if (stopped()) {
      await cancel(body)
      return interrupted(startedAt, now(), chargedBefore, chargedAfter, released, shotObserved, initial.name)
    }
    released = true
    const release = await body.itemUseRelease()
    if (release.state !== 'ok') {
      await cancel(body)
      return failed(
        release.code ?? 'CROSSBOW_LOAD_RELEASE_FAILED',
        startedAt,
        now(),
        chargedBefore,
        released,
        shotObserved,
        initial.name,
      )
    }
    const settleDeadline = now() + settleWaitMs
    while (now() < settleDeadline) {
      if (await pollStop()) {
        chargedAfter = body.held?.()?.chargedProjectiles
        await cancel(body)
        return interrupted(startedAt, now(), chargedBefore, chargedAfter, released, shotObserved, initial.name)
      }
      chargedAfter = body.held?.()?.chargedProjectiles
      if (chargedAfter !== undefined && chargedAfter.length > 0) break
      if (newArrow(body, beforeArrows)) {
        shotObserved = true
        return failed(
          'CROSSBOW_UNEXPECTED_FIRE',
          startedAt,
          now(),
          chargedBefore,
          released,
          shotObserved,
          initial.name,
        )
      }
      await sleep(pollMs)
    }
  } else {
    // 26.1.2 can complete the load while the trigger is still held. Release
    // the use stance now; releasing an already loaded crossbow does not fire.
    if (stopped()) {
      await cancel(body)
      return interrupted(startedAt, now(), chargedBefore, chargedAfter, released, shotObserved, initial.name)
    }
    released = true
    const release = await body.itemUseRelease()
    if (release.state !== 'ok') {
      await cancel(body)
      return failed(
        release.code ?? 'CROSSBOW_LOAD_RELEASE_FAILED',
        startedAt,
        now(),
        chargedBefore,
        released,
        shotObserved,
        initial.name,
      )
    }
  }

  if (chargedAfter === undefined) {
    return failed('CROSSBOW_LOAD_UNCONFIRMED', startedAt, now(), chargedBefore, released, shotObserved, initial.name)
  }
  if (chargedAfter.length === 0) {
    return failed('CROSSBOW_LOAD_UNCONFIRMED', startedAt, now(), chargedBefore, released, shotObserved, initial.name)
  }
  const check = validateProjectiles(chargedAfter)
  if (!check.ok) {
    return failed(check.code, startedAt, now(), chargedBefore, released, shotObserved, initial.name)
  }
  return {
    state: 'succeeded',
    observed: {
      kind: 'load-crossbow',
      alreadyLoaded: false,
      chargedBefore,
      chargedAfter,
      chargeMs: Math.max(0, now() - startedAt),
      released,
      shotObserved,
      stopped: false,
      item: initial.name,
    },
  }
}

/** Arrow-family item names accepted by vanilla ARROW_ONLY (including tipped/spectral). */
export function isArrowName(name: string): boolean {
  const normalized = name.replace(/^minecraft:/u, '').trim()
  return normalized === 'arrow' || normalized.endsWith('_arrow')
}

export function isCrossbowLoadedWithArrow(item: Item | undefined): boolean {
  if (item === undefined || normalize(item.name) !== 'crossbow') return false
  const projectiles = item.chargedProjectiles
  return projectiles !== undefined && projectiles.length > 0 && projectiles.every(projectile => isArrowName(projectile))
}

function validateProjectiles(projectiles: string[]): { ok: true } | { ok: false; code: string } {
  if (projectiles.length === 0) return { ok: false, code: 'CROSSBOW_LOAD_UNCONFIRMED' }
  if (!projectiles.every(projectile => isArrowName(projectile))) {
    return { ok: false, code: 'CROSSBOW_UNSUPPORTED_PROJECTILE' }
  }
  return { ok: true }
}

function hasArrow(body: BodyApi): boolean {
  return body.inventory().some(item => isArrowName(item.name))
    || isArrowName(body.offhand?.()?.name ?? '')
}

function archetype(body: BodyApi): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } {
  const self = body.self().pos
  return {
    min: { x: self.x - 16, y: self.y - 16, z: self.z - 16 },
    max: { x: self.x + 16, y: self.y + 16, z: self.z + 16 },
  }
}

function arrowIds(body: BodyApi): string[] {
  return body.entities(archetype(body))
    .filter(entity => normalize(entity.name) === 'arrow')
    .map(entity => entity.id)
}

function newArrow(body: BodyApi, before: Set<string>): boolean {
  return body.entities(archetype(body))
    .some(entity => normalize(entity.name) === 'arrow' && !before.has(entity.id))
}

async function cancel(body: BodyApi): Promise<void> {
  try {
    await body.itemUseCancel?.()
  } catch {
    // The stop path keeps the failure visible through the run result; a
    // cancellation error must not be reported as a successful load.
  }
}

function failed(
  code: string,
  startedAt: number,
  now: number,
  chargedBefore: string[] | undefined,
  released: boolean,
  shotObserved: boolean,
  item?: string,
): LoadCrossbowResult {
  return {
    state: 'failed',
    code,
    observed: {
      kind: 'load-crossbow',
      alreadyLoaded: false,
      chargedBefore,
      chargedAfter: chargedBefore,
      chargeMs: Math.max(0, now - startedAt),
      released,
      shotObserved,
      stopped: false,
      ...(item === undefined ? {} : { item }),
    },
  }
}

function interrupted(
  startedAt: number,
  now: number,
  chargedBefore: string[] | undefined,
  chargedAfter: string[] | undefined,
  released: boolean,
  shotObserved: boolean,
  item?: string,
): LoadCrossbowResult {
  return {
    state: 'interrupted',
    code: 'CROSSBOW_LOAD_INTERRUPTED',
    observed: {
      kind: 'load-crossbow',
      alreadyLoaded: false,
      chargedBefore,
      chargedAfter,
      chargeMs: Math.max(0, now - startedAt),
      released,
      shotObserved,
      stopped: true,
      ...(item === undefined ? {} : { item }),
    },
  }
}

function normalize(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.replace(/^minecraft:/u, '').trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
