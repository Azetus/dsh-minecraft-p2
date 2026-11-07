import { createP2Plugin } from './plugin.ts'

export { createP2Plugin, handleP2Command } from './plugin.ts'
export { BodyManager, createProcessSpawner } from './process-manager.ts'
export { BodyClient } from './body-client.ts'

export default createP2Plugin({ bodyControl: true, autoRestart: true })

