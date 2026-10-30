/** Shared lexical guard for agent-authored single-file JS content artifacts. */

export const JS_FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ['import', /(?<![\w$])import(?![\w$])/u],
  ['require', /(?<![\w$])require(?![\w$])/u],
  ['eval', /(?<![\w$])eval(?![\w$])/u],
  ['Function', /(?<![\w$])Function(?![\w$])/u],
  ['WebAssembly', /(?<![\w$])WebAssembly(?![\w$])/u],
  ['process', /(?<![\w$])process(?![\w$])/u],
  ['fetch', /(?<![\w$])fetch(?![\w$])/u],
  ['XMLHttpRequest', /(?<![\w$])XMLHttpRequest(?![\w$])/u],
  ['async function', /(?<![\w$])async\s+(?:function\b|\*)/u],
  ['async arrow', /(?<![\w$])async\s*(?:\([^)]*\)|[\w$]+)\s*=>/u],
  ['await', /(?<![\w$])await(?![\w$])/u],
  ['timer', /(?<![\w$])(setTimeout|setInterval|setImmediate|queueMicrotask)(?![\w$])/u],
] as const)

export function forbiddenIn(code: string): { token: string; index: number } | undefined {
  let found: { token: string; index: number } | undefined
  for (const [label, pattern] of JS_FORBIDDEN) {
    pattern.lastIndex = 0
    const match = pattern.exec(code)
    if (match === null) continue
    const index = match.index
    if (found === undefined || index < found.index) found = { token: label, index }
  }
  return found
}

export function lineColumn(code: string, index: number): { line: number; column: number } {
  const before = code.slice(0, index)
  const line = before.split('\n').length
  const lastBreak = before.lastIndexOf('\n')
  return { line, column: index - lastBreak }
}
