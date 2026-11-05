import { readFileSync, statSync } from 'node:fs'

/**
 * Persona text is user-owned and lives outside the plugin package. The
 * provider re-reads only when the file's mtime/size changes, so editing the
 * file takes effect on the next prompt assembly without restarting the body.
 */
export type PersonaRead = {
  text: string
  /** The file that produced the text; undefined means the packaged default. */
  path?: string
  bytes: number
  truncated: boolean
}

export type PersonaProviderOptions = {
  path: string
  fallbackText: string
  maxBytes?: number
  onChange?: (read: PersonaRead) => void
}

export const PERSONA_MAX_BYTES = 4096

export class PersonaProvider {
  private mtimeMs = Number.NaN
  private size = Number.NaN
  private cached: PersonaRead | undefined

  constructor(private readonly options: PersonaProviderOptions) {}

  read(): PersonaRead {
    const maxBytes = this.options.maxBytes ?? PERSONA_MAX_BYTES
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.options.path)
    } catch {
      return this.setCache({
        text: this.fallbackText(),
        bytes: byteLength(this.fallbackText()),
        truncated: false,
      })
    }
    if (this.cached !== undefined && stat.mtimeMs === this.mtimeMs && stat.size === this.size) {
      return this.cached
    }
    this.mtimeMs = stat.mtimeMs
    this.size = stat.size
    let raw: string
    try {
      raw = readFileSync(this.options.path, 'utf8')
    } catch {
      return this.setCache({
        text: this.fallbackText(),
        bytes: byteLength(this.fallbackText()),
        truncated: false,
      })
    }
    const trimmed = raw.replace(/\r\n/gu, '\n').trim()
    if (trimmed.length === 0) {
      return this.setCache({
        text: this.fallbackText(),
        bytes: byteLength(this.fallbackText()),
        truncated: false,
      })
    }
    const truncated = byteLength(trimmed) > maxBytes
    const text = truncated ? truncateUtf8(trimmed, maxBytes) : trimmed
    return this.setCache({
      text,
      path: this.options.path,
      bytes: byteLength(text),
      truncated,
    })
  }

  private fallbackText(): string {
    return this.options.fallbackText.trim()
  }

  private setCache(read: PersonaRead): PersonaRead {
    this.cached = read
    this.options.onChange?.(read)
    return read
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let result = ''
  for (const character of value) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result
}

function byteLength(value: string): number {
  return Buffer.byteLength(value)
}
