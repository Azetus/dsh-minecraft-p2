import { createP2Plugin } from './plugin.ts'

export { createP2Plugin, handleP2Command } from './plugin.ts'
export { BodyManager, createProcessSpawner } from './process-manager.ts'
export { BodyClient } from './body-client.ts'

// TEMPORARY development build: enables the global `p2_body` start/stop/status
// tool, the `p2_trace` tool and bounded auto-restart so the infrastructure can
// be exercised on a real LAN world. Remove these options (or set them to false)
// before a release; `/p2` remains the human entry point.
export default createP2Plugin({ devBodyControl: true, devTrace: true, devAutoRestart: true })
