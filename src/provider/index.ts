import { MineflayerBody } from './body.ts'
import { connectMineflayer, MineflayerProvider, PROVIDER_ID } from './mineflayer.ts'
import type { ProviderRuntimeStatus } from '../contracts/protocol.ts'
import type { BodyApi } from '../body/api.ts'

export { MineflayerBody } from './body.ts'
export { MineflayerProvider, connectMineflayer, mineflayerModule, PROVIDER_ID } from './mineflayer.ts'
export type {
  MineflayerConnectionOptions,
  MineflayerProviderOptions,
} from './mineflayer.ts'

export type OpenMineflayerBodyOptions = {
  host: string
  port: number
  username: string
  version: string
  connectTimeoutMs: number
  serverIdleMs: number
  worldId: string
  providerVersion?: string
}

export type OpenedMineflayerBody = {
  body: BodyApi
  providerId: string
  providerVersion: string
  liveStatus(): ProviderRuntimeStatus
  dispose(): void
}

/**
 * The only runtime entry into mineflayer. The body bundle dynamically imports
 * the compiled form of this module; everything below it keeps the bot.
 */
export async function openMineflayerBody(options: OpenMineflayerBodyOptions): Promise<OpenedMineflayerBody> {
  const bot = await connectMineflayer({
    host: options.host,
    port: options.port,
    username: options.username,
    version: options.version,
    timeoutMs: options.connectTimeoutMs,
  })
  const provider = new MineflayerProvider(bot, {
    serverIdleMs: options.serverIdleMs,
    providerVersion: options.providerVersion ?? 'unknown',
  })
  const body = new MineflayerBody(bot, provider, { worldId: options.worldId })
  return {
    body,
    providerId: PROVIDER_ID,
    providerVersion: provider.providerVersion,
    liveStatus: () => provider.liveStatus(),
    dispose: () => {
      try {
        bot.quit('body shutdown')
      } catch {
        // The connection may already be gone; disposal is best effort.
      }
    },
  }
}
