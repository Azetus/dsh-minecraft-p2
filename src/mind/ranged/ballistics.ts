import type { Vec3 } from '../../body/api.ts'

/**
 * Discrete vanilla arrow model shared by bow and crossbow. The server owns the
 * final trajectory; this module only provides the deterministic aiming model.
 *
 * Each tick: position += velocity, then velocity *= drag, then velocity.y -=
 * gravity. The closed form below is the sum of that sequence.
 */
export type ArrowProfile = {
  speed: number
  drag: number
  gravity: number
}

export const BOW_PROFILE: ArrowProfile = Object.freeze({ speed: 3, drag: 0.99, gravity: 0.05 })
export const CROSSBOW_PROFILE: ArrowProfile = Object.freeze({ speed: 3.15, drag: 0.99, gravity: 0.05 })

export type AimSolution = {
  yaw: number
  pitch: number
  /** Continuous ticks-to-target from the closed form. */
  flightTicks: number
  /** Integer-tick simulated points, starting at the arrow origin. */
  trajectory: Vec3[]
  impact: Vec3
}

export type AimFailure = {
  code: 'OUT_OF_RANGE' | 'NO_SOLUTION'
  range: number
  targetY: number
  profile: ArrowProfile
}

export type AimResult = AimSolution | AimFailure

const MIN_PITCH_DEG = -80
const MAX_PITCH_DEG = 85
const PITCH_STEP_DEG = 0.25
const MAX_FLIGHT_TICKS = 220

/** Unit launch direction in mineflayer coordinates (yaw 0 = -z). */
export function launchDirection(yaw: number, pitch: number): Vec3 {
  const cos = Math.cos(pitch)
  return {
    x: -Math.sin(yaw) * cos,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cos,
  }
}

/** One-tick trajectory samples for a fixed launch direction. */
export function simulateShot(
  origin: Vec3,
  yaw: number,
  pitch: number,
  profile: ArrowProfile,
  ticks: number,
): Vec3[] {
  const dir = launchDirection(yaw, pitch)
  let velocity = { x: dir.x * profile.speed, y: dir.y * profile.speed, z: dir.z * profile.speed }
  const point = { ...origin }
  const points: Vec3[] = [{ ...point }]
  const count = Math.max(0, Math.min(MAX_FLIGHT_TICKS, Math.floor(ticks)))
  for (let index = 0; index < count; index += 1) {
    point.x += velocity.x
    point.y += velocity.y
    point.z += velocity.z
    points.push({ ...point })
    velocity = {
      x: velocity.x * profile.drag,
      y: velocity.y * profile.drag - profile.gravity,
      z: velocity.z * profile.drag,
    }
  }
  return points
}

/**
 * Solve the low-angle launch for a point target. The search is bounded and
 * uses the same constants as the server model; it returns OUT_OF_RANGE when no
 * real root exists, never a guessed pitch.
 */
export function solveAim(origin: Vec3, target: Vec3, profile: ArrowProfile): AimResult {
  const dx = target.x - origin.x
  const dz = target.z - origin.z
  const dy = target.y - origin.y
  const range = Math.hypot(dx, dz)
  const yaw = Math.atan2(-dx, -dz)
  if (!(range > 1e-4) || !Number.isFinite(range)) {
    return { code: 'NO_SOLUTION', range, targetY: target.y, profile }
  }
  const roots: number[] = []
  let previousPitch: number | undefined
  let previousValue: number | undefined
  for (let degree = MIN_PITCH_DEG; degree <= MAX_PITCH_DEG; degree += PITCH_STEP_DEG) {
    const pitch = (degree * Math.PI) / 180
    const value = heightError(range, dy, pitch, profile)
    if (value !== undefined && previousValue !== undefined && previousPitch !== undefined
      && Math.sign(value) !== Math.sign(previousValue)) {
      const root = bisect(previousPitch, pitch, previousValue, value => heightError(range, dy, value, profile))
      if (root !== undefined) roots.push(root)
    }
    previousPitch = pitch
    previousValue = value
    if (roots.length > 0 && degree > 0) break
  }
  if (roots.length === 0) {
    return { code: 'OUT_OF_RANGE', range, targetY: target.y, profile }
  }
  const pitch = roots.reduce((best, candidate) =>
    Math.abs(candidate) < Math.abs(best) ? candidate : best)
  const flight = flightTicksFor(range, pitch, profile)
  if (flight === undefined || flight > MAX_FLIGHT_TICKS) {
    return { code: 'OUT_OF_RANGE', range, targetY: target.y, profile }
  }
  const points = simulateShot(origin, yaw, pitch, profile, Math.ceil(flight) + 2)
  const impactIndex = Math.max(1, Math.min(points.length - 1, Math.round(flight)))
  return {
    yaw,
    pitch,
    flightTicks: flight,
    trajectory: points,
    impact: { ...points[impactIndex]! },
  }
}

/** Continuous horizontal range at a given pitch, or undefined when the horizontal range cannot reach. */
export function horizontalRange(range: number, pitch: number, profile: ArrowProfile): number | undefined {
  const n = flightTicksFor(range, pitch, profile)
  if (n === undefined) return undefined
  return 100 * profile.speed * Math.cos(pitch) * (1 - profile.drag ** n)
}

/** Vertical displacement after `n` ticks at a given pitch. */
export function verticalDrop(n: number, pitch: number, profile: ArrowProfile): number {
  const k = profile.gravity / (1 - profile.drag)
  return 100 * (profile.speed * Math.sin(pitch) + k) * (1 - profile.drag ** n) - k * n
}

function heightError(range: number, dy: number, pitch: number, profile: ArrowProfile): number | undefined {
  const n = flightTicksFor(range, pitch, profile)
  if (n === undefined) return undefined
  return verticalDrop(n, pitch, profile) - dy
}

function flightTicksFor(range: number, pitch: number, profile: ArrowProfile): number | undefined {
  const horizontalSpeed = profile.speed * Math.cos(pitch)
  if (horizontalSpeed <= 0) return undefined
  const ratio = range / (100 * horizontalSpeed)
  if (!(ratio > 0 && ratio < 1)) return undefined
  const n = Math.log(1 - ratio) / Math.log(profile.drag)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function bisect(
  left: number,
  right: number,
  leftValue: number,
  evaluate: (pitch: number) => number | undefined,
): number | undefined {
  let low = left
  let high = right
  let lowValue = leftValue
  for (let index = 0; index < 48; index += 1) {
    const middle = (low + high) / 2
    const value = evaluate(middle)
    if (value === undefined) return undefined
    if (Math.abs(value) < 1e-7) return middle
    if (Math.sign(value) === Math.sign(lowValue)) {
      low = middle
      lowValue = value
    } else {
      high = middle
    }
  }
  return (low + high) / 2
}

export function segmentHitsBox(
  from: Vec3,
  to: Vec3,
  min: Vec3,
  max: Vec3,
): boolean {
  let tMin = 0
  let tMax = 1
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = to[axis] - from[axis]
    if (Math.abs(delta) < 1e-9) {
      if (from[axis] < min[axis] || from[axis] > max[axis]) return false
      continue
    }
    let t1 = (min[axis] - from[axis]) / delta
    let t2 = (max[axis] - from[axis]) / delta
    if (t1 > t2) [t1, t2] = [t2, t1]
    tMin = Math.max(tMin, t1)
    tMax = Math.min(tMax, t2)
    if (tMin > tMax) return false
  }
  return true
}
