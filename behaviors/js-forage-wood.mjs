/**
 * M5.5 JS round: forage the nearest exposed log until the inventory quota is met.
 *
 * Counterpart of `behaviors/forage-wood.mjs` (IR). Same loop, same policies:
 * one iteration = count -> scan -> pick -> walk -> dig -> collect. The quota and
 * the selection still go through policies so the two rounds stay comparable;
 * only the loop, the unreachable-target bookkeeping and the arithmetic are JS.
 *
 * Unreachable targets are skipped by feeding their block cells back to the
 * policy as `avoid` boxes. The policy stays the only selector, and the same bad
 * target cannot be picked again in the next iteration (a plain "skip" set of
 * keys would not stop that, because the policy would keep returning it).
 */
defineBehavior({
  manifest: {
    id: 'js-forage-wood',
    description: 'Dig exposed logs within radius until the inventory holds `want` of `item`',
    mode: 'finite',
    parameters: {
      item: { type: 'string', required: true },
      want: { type: 'number', required: true },
      radius: { type: 'number', required: true },
      count: { type: 'number', required: true },
      avoid: { type: 'json', required: true },
      maxDy: { type: 'number', required: true },
    },
  },
  *run(ctx) {
    const maxSkip = 8
    const skipBoxes = []
    const skippedKeys = {}
    let mined = 0

    while (true) {
      const inv = yield ctx.query('inventory', {})
      const verdict = yield ctx.decide('item-count', {
        items: inv.value,
        name: ctx.params.item,
        want: ctx.params.want,
      })
      if (verdict !== null && verdict !== undefined && verdict.atLeast === true) {
        return ctx.succeed({ item: ctx.params.item, want: ctx.params.want, mined: mined })
      }

      const here = yield ctx.query('position', {})
      const found = yield ctx.query('blocks', {
        names: [ctx.params.item],
        radius: ctx.params.radius,
        count: ctx.params.count,
        exposed: true,
      })
      const avoid = skipBoxes.length === 0 ? ctx.params.avoid : ctx.params.avoid.concat(skipBoxes)
      const pick = yield ctx.decide('pick-nearest-candidate', {
        items: found.value,
        x: here.value.x,
        y: here.value.y,
        z: here.value.z,
        avoid: avoid,
        maxDy: ctx.params.maxDy,
      })
      if (pick === null || pick === undefined || pick.kind !== 'target') {
        return ctx.fail('NO_TARGET', 'no reachable log left within ' + ctx.params.radius + ' blocks')
      }

      const target = pick.item
      const x = Math.floor(target.x)
      const y = Math.floor(target.y)
      const z = Math.floor(target.z)
      const pos = { x: x, y: y, z: z }
      const key = x + ',' + y + ',' + z

      try {
        yield ctx.act('goto', { x: x, y: y, z: z, range: 4, timeoutMs: 12000 })
        yield ctx.act('mine-one', { pos: pos })
        yield ctx.act('goto', { x: x, y: y, z: z, range: 2, timeoutMs: 8000 })
        yield ctx.wait(400)
      } catch (error) {
        const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : 'ACT_FAILED'
        if (skippedKeys[key] !== true) {
          skippedKeys[key] = true
          skipBoxes.push({ x1: x, x2: x, y1: y, y2: y, z1: z, z2: z })
        }
        if (skipBoxes.length >= maxSkip) {
          return ctx.fail('NO_PROGRESS', 'too many unreachable targets: ' + code)
        }
        yield ctx.log('skipped ' + key + ': ' + code)
        yield ctx.progress({ mined: mined, skipped: skipBoxes.length })
        continue
      }

      mined += 1
      yield ctx.progress({ mined: mined })
    }
  },
})
