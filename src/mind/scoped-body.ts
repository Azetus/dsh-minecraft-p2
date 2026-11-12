import type {
  ActResult,
  BodyApi,
  ContainerCheckResult,
  WriteToken,
} from '../body/api.ts'
import { BodyErrorCodes } from '../body/api.ts'
import type { RunScope } from './scope.ts'

/**
 * A body view bound to one Driver execution.
 *
 * The view is what keeps the single-writer invariant honest across the async
 * boundary: a driver that was preempted keeps holding *its* view, and once the
 * JobTracker revokes the scope every write through it is refused locally. The
 * provider is never reached, so a late continuation cannot borrow the next
 * run's authority.
 *
 * Reads are always forwarded: revocation removes permission to change the
 * body, not permission to observe it, and an interrupted driver still needs a
 * bounded readback for its evidence.
 *
 * Optional methods keep their presence: a missing `combatInput` on the inner
 * body means the adapter cannot do it, and the caller's `=== undefined`
 * fallback must keep working. Do not turn them into `undefined` values.
 */
export function scopeWrites(
  body: BodyApi,
  scope: RunScope,
  onReject?: (method: string) => void,
): BodyApi {
  const deniedAct = (): ActResult => ({
    state: 'failed',
    code: BodyErrorCodes.STALE_WRITE,
    elapsedMs: 0,
  })

  const deny = (method: string): boolean => {
    if (!scope.revoked) return false
    scope.rejected += 1
    onReject?.(method)
    return true
  }

  const managementDenied = (method: string): never => {
    throw new Error(`${method} is not available to a driver: write authority belongs to the JobTracker`)
  }

  const view: BodyApi = {
    // Reads: always allowed.
    self: () => body.self(),
    identity: () => body.identity(),
    blockAt: p => body.blockAt(p),
    biomeAt: p => body.biomeAt(p),
    blocksIn: (box, filter) => body.blocksIn(box, filter),
    findBlocks: query => body.findBlocks(query),
    inventory: () => body.inventory(),
    entities: box => body.entities(box),
    time: () => body.time(),
    ...(body.suspension === undefined ? {} : { suspension: () => body.suspension!() }),
    ...(body.offhand === undefined ? {} : { offhand: () => body.offhand!() }),
    ...(body.entityByName === undefined
      ? {}
      : { entityByName: (name: string) => body.entityByName!(name) }),
    ...(body.entityById === undefined
      ? {}
      : { entityById: (id: string) => body.entityById!(id) }),
    ...(body.playerOnline === undefined
      ? {}
      : { playerOnline: (name: string) => body.playerOnline!(name) }),
    ...(body.canSee === undefined ? {} : { canSee: (id: string) => body.canSee!(id) }),
    ...(body.attackSpeed === undefined ? {} : { attackSpeed: () => body.attackSpeed!() }),
    ...(body.attackReach === undefined ? {} : { attackReach: () => body.attackReach!() }),

    // Authority management belongs to the JobTracker, never to a driver.
    beginWrite: (_token: WriteToken) => managementDenied('beginWrite'),
    endWrite: (_token: WriteToken) => managementDenied('endWrite'),

    // Writes: refused once the scope is revoked.
    moveTo: async (target, opts) => (deny('moveTo') ? deniedAct() : body.moveTo(target, opts)),
    lookAt: async p => (deny('lookAt') ? deniedAct() : body.lookAt(p)),
    dig: async p => (deny('dig') ? deniedAct() : body.dig(p)),
    place: async (p, face, item) => (deny('place') ? deniedAct() : body.place(p, face, item)),
    useItem: async opts => (deny('useItem') ? deniedAct() : body.useItem(opts)),
    equip: async (item, destination) => (deny('equip') ? deniedAct() : body.equip(item, destination)),
    craft: async (item, count) => (deny('craft') ? deniedAct() : body.craft(item, count)),
    useOn: async p => (deny('useOn') ? deniedAct() : body.useOn(p)),
    attack: async entityId => (deny('attack') ? deniedAct() : body.attack(entityId)),
    sleep: async bed => (deny('sleep') ? deniedAct() : body.sleep(bed)),
    fatalStep: async target => (deny('fatalStep') ? deniedAct() : body.fatalStep(target)),
    containerTransfer: async (p, action, item, count) => (deny('containerTransfer')
      ? deniedAct()
      : body.containerTransfer(p, action, item, count)),
    // Opening a container changes interaction state, so it is a write.
    containerAt: async (p): Promise<ContainerCheckResult> => (deny('containerAt')
      ? { state: 'failed', code: BodyErrorCodes.STALE_WRITE }
      : body.containerAt(p)),
    ...(body.combatInput === undefined
      ? {}
      : {
          combatInput: async (opts: Parameters<NonNullable<BodyApi['combatInput']>>[0]) =>
            (deny('combatInput') ? deniedAct() : body.combatInput!(opts)),
        }),
    ...(body.lookYaw === undefined
      ? {}
      : { lookYaw: async (yaw: number) => (deny('lookYaw') ? deniedAct() : body.lookYaw!(yaw)) }),
    ...(body.offhandHold === undefined
      ? {}
      : {
          offhandHold: async (active: boolean) =>
            (deny('offhandHold') ? deniedAct() : body.offhandHold!(active)),
        }),
    ...(body.unequip === undefined
      ? {}
      : {
          unequip: async (destination?: 'hand' | 'offhand') =>
            (deny('unequip') ? deniedAct() : body.unequip!(destination)),
        }),

    // Read-only planning and chat are not body writes.
    ...(body.pathTo === undefined
      ? {}
      : { pathTo: (target, range, timeoutMs) => body.pathTo!(target, range, timeoutMs) }),
    say: text => body.say(text),

    // Subscriptions pass through: a late listener only records a local fact.
    on: (event, cb) => body.on(event, cb),
    ...(body.off === undefined ? {} : { off: (event, cb) => body.off!(event, cb) }),
  }

  return view
}
