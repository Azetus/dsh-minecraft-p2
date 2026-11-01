export type FailureCategory =
  | 'precondition'
  | 'reachability'
  | 'tool'
  | 'world'
  | 'budget'
  | 'safety'
  | 'unknown'

export type FailureDiagnostic = {
  code: string
  category: FailureCategory
  hint: string
}

const RULES: Array<{ match: RegExp; category: FailureCategory; hint: string }> = [
  { match: /TOOL_INSUFFICIENT|BLOCK_UNBREAKABLE/, category: 'tool', hint: 'check the tool/block type or use clear instead of harvest' },
  { match: /APPROACH_NO_STAND|GOTO_INVALID_TARGET|NO_STAND|NO_SUPPORT/, category: 'reachability', hint: 'target has no safe standing cell; change the target or clear space' },
  { match: /GOTO_NO_PATH|GOTO_TIMEOUT|^UNREACHABLE$/, category: 'reachability', hint: 'path is blocked or too long; choose a closer/standable target' },
  { match: /PICKUP_UNREACHABLE|PICKUP_NOT_COLLECTED/, category: 'world', hint: 'drop is unreachable or not collected; adjust the landing/space' },
  { match: /CRAFT_NO_TABLE|CRAFT_NO_INGREDIENTS|CRAFT_UNKNOWN_RECIPE|NO_MATERIAL/, category: 'precondition', hint: 'missing table, ingredients or recipe' },
  { match: /ATTACK_TARGET_LOST|ATTACK_TARGET_CHANGED/, category: 'world', hint: 'target moved or disappeared; reacquire explicitly' },
  { match: /ATTACK_TARGET_PROTECTED/, category: 'safety', hint: 'player/unauthorized passive target; do not attack' },
  { match: /ATTACK_NO_HIT|ATTACK_NOT_KILLED|ATTACK_CHASE_LIMIT/, category: 'reachability', hint: 'target could not be reached or killed within bounds' },
  { match: /BUDGET_EXCEEDED|CLIENT_TIMEOUT/, category: 'budget', hint: 'budget exhausted before the result could be proven' },
  { match: /BAD_ARGS|STALE_WRITE|CAPABILITY_MISSING|DEFINITION_ERROR/, category: 'precondition', hint: 'invalid request, stale authority or missing capability' },
  { match: /DIG_NO_BLOCK|DIG_READBACK_UNSTABLE|CHECK_|PLACE_|CONTAINER_/, category: 'world', hint: 'the world did not match the request; observe and retry deliberately' },
  { match: /STOP_UNCONFIRMED|DRIVER_FAULT/, category: 'safety', hint: 'stop/release was not confirmed; do not assume the action ended' },
]

export function classifyFailure(code: string | undefined): FailureDiagnostic {
  if (code === undefined || code.length === 0) {
    return { code: 'UNKNOWN', category: 'unknown', hint: 'no failure code was reported' }
  }
  for (const rule of RULES) {
    if (rule.match.test(code)) return { code, category: rule.category, hint: rule.hint }
  }
  return { code, category: 'unknown', hint: 'inspect the structured observed payload' }
}
