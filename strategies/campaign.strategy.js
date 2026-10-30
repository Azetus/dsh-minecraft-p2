/**
 * campaign (S2): drive one commitment stage to completion.
 *
 * The stage lives in the commitment checkpoint. The strategy only proposes the
 * stage act; the op does the work and returns raw evidence. Completion is
 * declared only when the live facts (camp components / inventory) prove it,
 * so a successful act is never enough by itself.
 */
defineStrategy({
  manifest: {
    id: 'campaign',
    version: '1',
    slot: 'S2',
    facts: ['position', 'inventory', 'health', 'camp', 'entities'],
    acts: ['campaign-step'],
    description: 'run one survival campaign stage and verify it from live facts',
  },
  evaluate: function (ctx) {
    var facts = ctx.facts
    if (!facts || !facts.values) return { kind: 'unknown', missing: ['facts'] }
    var commitment = ctx.commitment
    if (!commitment) return { kind: 'idle' }
    var checkpoint = commitment.checkpoint || {}
    var stage = typeof checkpoint.stage === 'string' ? checkpoint.stage : ''
    if (stage.length === 0) {
      return { kind: 'idle' }
    }
    var inventory = facts.values.inventory || []
    var camp = facts.values.camp || {}
    function count(name) {
      var total = 0
      for (var i = 0; i < inventory.length; i += 1) {
        if (inventory[i] && inventory[i].name === name) total += inventory[i].count
      }
      return total
    }
    var done = false
    var evidence = ['inventory']
    if (stage === 'shelter') {
      done = camp.shelter === 1 && camp.door === 1 && camp.torch === 1 && camp.inside === 1
      evidence = ['inventory', 'camp']
    } else if (stage === 'bed') {
      done = camp.bed === 1 && camp.spawn === 1
      evidence = ['inventory', 'camp']
    } else if (stage === 'tools') {
      done = count('stone_pickaxe') > 0 && count('stone_axe') > 0 && count('stone_sword') > 0
    } else if (stage === 'copper') {
      done = count('raw_copper') + count('copper_ore') > 0
    } else if (stage === 'smelt') {
      done = count('copper_ingot') > 0
    }
    if (ctx.activeAction) return { kind: 'running', intent: ctx.activeAction.intent }
    var last = ctx.lastOutcome && ctx.lastOutcome.attemptId === ctx.attemptId ? ctx.lastOutcome : null
    var failures = typeof checkpoint.failures === 'number' ? checkpoint.failures : 0
    var verifySince = typeof checkpoint.verifySince === 'number' ? checkpoint.verifySince : 0
    var retryAt = typeof checkpoint.retryAt === 'number' ? checkpoint.retryAt : 0
    if (done) {
      return { kind: 'candidate-complete', evidence: evidence, checkpoint: { stage: stage, failures: failures } }
    }
    if (last && last.status === 'succeeded') {
      // Act succeeded but the live facts have not caught up yet; wait for a
      // fresh sample instead of re-running the whole stage immediately.
      var since = verifySince > 0 ? verifySince : ctx.now
      if (ctx.now - since < 6000) {
        return { kind: 'running', intent: 'verify:' + stage, progress: { step: 'waiting-for-facts' }, checkpoint: { stage: stage, failures: failures, verifySince: since } }
      }
      return {
        kind: 'propose',
        intent: 'campaign:' + stage + ':recheck',
        act: 'campaign-step',
        args: { stage: stage },
        checkpoint: { stage: stage, failures: failures, verifySince: 0 },
      }
    }
    if (last && last.status === 'failed') {
      failures += 1
      if (failures >= 3) {
        return {
          kind: 'blocked',
          missing: [],
          since: ctx.now,
          diagnostics: [{
            code: 'CAMPAIGN_STAGE_FAILED',
            message: 'stage ' + stage + ' failed ' + failures + ' times',
            detail: { stage: stage, error: last.error || null },
          }],
          checkpoint: { stage: stage, failures: failures },
        }
      }
      if (ctx.now < retryAt) {
        return { kind: 'running', intent: 'retry-delay', checkpoint: { stage: stage, failures: failures, retryAt: retryAt } }
      }
      return {
        kind: 'propose',
        intent: 'campaign:' + stage + ':retry' + failures,
        act: 'campaign-step',
        args: { stage: stage },
        checkpoint: { stage: stage, failures: failures, verifySince: 0, retryAt: ctx.now + 1500 },
      }
    }
    return {
      kind: 'propose',
      intent: 'campaign:' + stage,
      act: 'campaign-step',
      args: { stage: stage },
      checkpoint: { stage: stage, failures: failures, verifySince: 0 },
    }
  },
})
