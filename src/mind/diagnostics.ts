export type FailureCategory =
  | 'precondition'
  | 'reachability'
  | 'tool'
  | 'world'
  | 'budget'
  | 'safety'
  | 'definition'
  | 'unknown'

export type FailureDiagnostic = {
  code: string
  category: FailureCategory
  hint: string
}

const RULES: Array<{ match: RegExp; category: FailureCategory; hint: string }> = [
  { match: /DIG_PARTIAL/, category: 'world', hint: 'volume dig ended partially; read observed.dug/skipped before continuing' },
  { match: /DIG_VOLUME_TOO_LARGE/, category: 'precondition', hint: 'volume exceeds maxBlocks; split the order or raise the cap' },
  { match: /TOOL_INSUFFICIENT|BLOCK_UNBREAKABLE/, category: 'tool', hint: 'check the tool/block type or use clear instead of harvest' },
  { match: /GOAL_NOT_STANDABLE/, category: 'reachability', hint: 'the exact goal cell is not standable; choose a standable cell or clear it' },
  { match: /APPROACH_NO_STAND|APPROACH_NO_PATH|GOTO_INVALID_TARGET|NO_STAND|NO_SUPPORT/, category: 'reachability', hint: 'target has no reachable standing cell; change the target or clear space' },
  { match: /BODY_OVERLAP/, category: 'world', hint: 'the body AABB intersects a block; clear the listed cell(s) before moving' },
  { match: /APPROACH_UNKNOWN/, category: 'world', hint: 'the stand query could not decide (unloaded window); re-observe before retrying' },
  { match: /GOTO_NO_PATH|GOTO_TIMEOUT|^UNREACHABLE$/, category: 'reachability', hint: 'path is blocked or too long; choose a closer/standable target' },
  { match: /VANILLA_NO_PATH/, category: 'reachability', hint: 'the unvalidated vanilla path got no closer; retry with a closer target or the safe planner' },
  { match: /VANILLA_STUCK|VANILLA_TIMEOUT/, category: 'world', hint: 'unvalidated following made no progress; re-observe and decide whether to retry or give up' },
  { match: /PICKUP_NO_RETURN|COLLECT_NO_RETURN/, category: 'reachability', hint: 'the only pickup stand cell has no proven route back; do not enter the pit, change the approach or accept the loss' },
  { match: /PICKUP_UNREACHABLE|PICKUP_NOT_COLLECTED|PICKUP_ENTITY_GONE|PICKUP_MERGED/, category: 'world', hint: 'drop is unreachable or not collected; adjust the landing/space' },
  { match: /PICKUP_INVENTORY_FULL|COLLECT_INVENTORY_FULL/, category: 'precondition', hint: 'inventory has no storage space; free a slot before harvesting' },
  { match: /COLLECT_TIMEOUT/, category: 'budget', hint: 'the collect pass hit its timeout; re-observe the remaining drops before a new bounded collect' },
  { match: /COLLECT_UNREACHABLE/, category: 'reachability', hint: 'at least one observed drop has no reachable pickup cell; clear the listed cells or accept the loss' },
  { match: /COLLECT_INCOMPLETE/, category: 'world', hint: 'the pass ended with uncollected drops; read observed.items/outcome before deciding' },
  { match: /EQUIP_NO_ITEM|EQUIP_ITEM_MISSING/, category: 'precondition', hint: 'the required item is not in the inventory; obtain it before retrying' },
  { match: /CRAFT_INCOMPLETE/, category: 'world', hint: 'craft ended partially; read observed.crafted/attempted before deciding to continue' },
  { match: /CRAFT_NO_TABLE|CRAFT_NO_INGREDIENTS|CRAFT_UNKNOWN_RECIPE|NO_MATERIAL/, category: 'precondition', hint: 'missing table, ingredients or recipe' },
  { match: /ATTACK_TARGET_LOST|ATTACK_TARGET_CHANGED/, category: 'world', hint: 'target moved or disappeared; reacquire explicitly' },
  { match: /ATTACK_TARGET_PROTECTED/, category: 'safety', hint: 'player/unauthorized passive target; do not attack' },
  { match: /ATTACK_NO_HIT|ATTACK_NOT_KILLED|ATTACK_CHASE_LIMIT/, category: 'reachability', hint: 'target could not be reached or killed within bounds' },
  { match: /ACT_UNCONFIRMED/, category: 'safety', hint: 'the request may have taken effect; re-observe before deciding, never replay blindly' },
  { match: /ACTION_DENIED/, category: 'precondition', hint: 'the server refused the action; check permission, protection or target rules' },
  { match: /BUDGET_EXCEEDED|ACT_TIMEOUT|CLIENT_TIMEOUT/, category: 'budget', hint: 'budget exhausted before the result could be proven; only retry-safe actions may be repeated' },
  { match: /BAD_ARGS|STALE_WRITE|CAPABILITY_MISSING|DEFINITION_ERROR/, category: 'precondition', hint: 'invalid request, stale authority or missing capability' },
  // An assertion is a broken definition/assumption, not a world state: the
  // same job would fail again, so the Agent must change the definition.
  { match: /ERR_ASSERTION/, category: 'definition', hint: 'the driver hit an internal assertion; the definition/assumption is wrong, do not retry the same job' },
  { match: /PLACE_TARGET_OCCUPIED/, category: 'precondition', hint: 'target cell is occupied by a non-replaceable block; choose an empty/replaceable cell or clear it' },
  { match: /PLACE_OFF_TARGET/, category: 'world', hint: 'the item was placed outside the target cell; read facts.placedAt/placedCells before correcting the coordinate' },
  { match: /PLACE_ITEM_CONSUMED/, category: 'world', hint: 'the item left the inventory but no target block was confirmed; re-observe before placing again' },
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
