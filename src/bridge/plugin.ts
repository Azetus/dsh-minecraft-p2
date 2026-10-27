import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

import type { OwnerContext } from '../contracts/protocol.ts'
import type { P2Error } from '../contracts/types.ts'
import { BodyClientError } from './body-client.ts'
import { BodyManager } from './process-manager.ts'
import type { BodySpawner } from './process-manager.ts'

type CommandResult = { kind: 'success' | 'error'; text: string }

type CommandInvocation = {
  agent: {
    id: string
    session: {
      id: string
      header: { cwd?: string }
    }
  }
  rawInput: string
}

type CommandsService = {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
}

type P2Context = Context & { commands: CommandsService }

export type P2PluginOptions = {
  bodyEntry?: string
  spawnBody?: BodySpawner
  heartbeatMs?: number
  stopTimeoutMs?: number
  log?: (line: string) => void
}

export function createP2Plugin(options: P2PluginOptions = {}): {
  name: string
  inject: string[]
  apply(ctx: P2Context): void
} {
  const manager = new BodyManager({
    bodyEntry: options.bodyEntry ?? fileURLToPath(new URL('./body/body.mjs', import.meta.url)),
    ...(options.spawnBody === undefined ? {} : { spawnBody: options.spawnBody }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })

  return {
    name: 'dsh-minecraft-p2',
    inject: ['commands'],
    apply(ctx: P2Context): void {
      ctx.effect(
        () => ctx.commands.register({
          name: 'p2',
          description: 'Manage the P2 Minecraft player runtime',
          input: { hint: '<setup|start|status|stop>' },
          handler: invocation => handleP2Command(manager, invocation),
        }),
        'p2.commands',
      )
      ctx.effect(
        () => async () => {
          await manager.dispose()
        },
        'p2.body',
      )
    },
  }
}

export async function handleP2Command(
  manager: BodyManager,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const input = invocation.rawInput.trim()
  const [verb = '', ...rest] = input.split(/\s+/u)

  try {
    switch (verb) {
      case '':
      case 'help':
        return success('P2 commands: /p2 setup | start | status | stop')
      case 'setup':
        return setup(invocation.agent)
      case 'start': {
        const owner = ownerOf(invocation.agent)
        const result = await manager.start(owner)
        return success(`P2 body active (epoch ${result.epoch})`)
      }
      case 'status':
        return success(await statusText(manager))
      case 'stop':
      case 'shutdown': {
        const result = await manager.stop()
        if (result.state === 'faulted') {
          return error(`P2 body stop was not confirmed${result.error === undefined ? '' : `: ${result.error}`}`)
        }
        return success('P2 body stopped')
      }
      default:
        return error(`unknown /p2 command: ${verb}${rest.length === 0 ? '' : ' (input is not supported)'}`)
    }
  } catch (cause) {
    return error(formatError(cause))
  }
}

function setup(agent: CommandInvocation['agent']): CommandResult {
  const cwd = agent.session.header.cwd
  if (cwd === undefined || cwd.length === 0) {
    return error('session has no project cwd; create the session in the P2 project')
  }
  if (!existsSync(cwd)) return error(`project directory does not exist: ${cwd}`)
  return success(`P2 project ready: ${cwd}`)
}

function ownerOf(agent: CommandInvocation['agent']): OwnerContext {
  const cwd = agent.session.header.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new Error('session has no project cwd; create the session in the P2 project')
  }
  if (!existsSync(cwd)) throw new Error(`project directory does not exist: ${cwd}`)
  return {
    sessionId: agent.session.id,
    agentId: agent.id,
    cwd,
  }
}

async function statusText(manager: BodyManager): Promise<string> {
  if (manager.currentState !== 'active') return `P2 body ${manager.currentState}`
  const result = await manager.status()
  if (result.state !== 'active') return `P2 body ${result.state}`
  const status = result.status
  return [
    'P2 body active',
    `epoch=${status.bodyEpoch}`,
    `health=${status.health}`,
    `owner=${status.owner?.sessionId ?? 'none'}`,
    `commands=${status.commandCount}`,
  ].join(' ')
}

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

function error(text: string): CommandResult {
  return { kind: 'error', text }
}

function formatError(cause: unknown): string {
  if (cause instanceof BodyClientError) return formatP2Error(cause.error)
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function formatP2Error(error: P2Error): string {
  return `${error.code}: ${error.message}`
}
