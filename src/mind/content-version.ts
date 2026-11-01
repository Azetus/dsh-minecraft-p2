import { createHash } from 'node:crypto'

/** Content identity for the plan templates that a journal can reference. */
export const CONTENT_SCHEMA = 'plans-v1'

/**
 * Stable hash of the plan templates. Object keys are sorted so a filesystem
 * read order cannot change the identity. Trees are code now and intentionally
 * do not participate: changing a tree must not reject an old journal.
 */
export function contentVersion(plans: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify({ schema: CONTENT_SCHEMA, plans: sortValue(plans) }))
    .digest('hex')
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key])
    return sorted
  }
  return value
}
