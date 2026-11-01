import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const DEV_HOME = join(ROOT, '.dev-home')
export const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
export const PACKAGE_NAME = MANIFEST.name
export const PACKAGE_VERSION = MANIFEST.version
export const TARBALL = join(ROOT, 'bundles', `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`)
export const NEEDS_SHELL = true
export const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

export function runNpm(args, env = process.env) {
  const npmCli = process.env.npm_execpath
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...args], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    })
  }
  return spawnSync(commandLine('npm', args), {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: NEEDS_SHELL,
  })
}

export function runDsh(args, { env = process.env, stdio = 'inherit' } = {}) {
  return spawnSync(commandLine('dsh', args), {
    cwd: ROOT,
    env,
    stdio,
    shell: NEEDS_SHELL,
  })
}

export function captureDsh(args, { env = process.env, log } = {}) {
  const fd = openSync(log, 'w')
  try {
    const result = spawnSync(commandLine('dsh', args), {
      cwd: ROOT,
      env,
      stdio: ['ignore', fd, fd],
      shell: NEEDS_SHELL,
    })
    return {
      status: result.status,
      output: existsSync(log) ? readFileSync(log, 'utf8') : '',
    }
  } finally {
    closeSync(fd)
  }
}

/** Quote one argument for the platform shell; paths may contain spaces. */
export function quoteArg(arg) {
  if (arg === '') return '""'
  if (/^[A-Za-z0-9_./:=@\\-]+$/.test(arg)) return arg
  return `"${arg.replaceAll('"', '\\"')}"`
}

export function commandLine(command, args) {
  return [command, ...args].map(quoteArg).join(' ')
}

export function installBundle(home, profile, tarball = TARBALL, options = {}) {
  if (!existsSync(tarball)) throw new Error(`missing bundle: ${tarball}; run \`npm run bundle\` first`)
  const env = { ...process.env, DSH_HOME: home }
  if (options.force === true && existsSync(join(home, 'profiles', profile, 'node_modules', PACKAGE_NAME))) {
    runDsh(['plugin', '--profile', profile, 'remove', PACKAGE_NAME], { env })
  }
  const args = ['plugin', '--profile', profile, 'add', tarball]
  if (options.force === true) args.push('--force')
  return runDsh(args, { env })
}

export function readProfile(home, profile) {
  return JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
}

export function writeProfile(home, profile, manifest) {
  writeFileSync(
    join(home, 'profiles', profile, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

export function ensureWebProfile(home, profile) {
  const manifest = readProfile(home, profile)
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles = [...WEB_BUNDLES, PACKAGE_NAME]
  writeProfile(home, profile, manifest)
  return manifest
}

/** Inspect an existing dev home without modifying it. */
export function inspectDevHome(home, profile) {
  if (!existsSync(home)) {
    return { exists: false, reusable: false, reason: 'missing' }
  }
  const profilePath = join(home, 'profiles', profile, 'package.json')
  if (!existsSync(profilePath)) {
    return { exists: true, reusable: false, reason: `missing profile ${profile}` }
  }
  try {
    const manifest = readProfile(home, profile)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (!bundles.includes(PACKAGE_NAME)) {
      return {
        exists: true,
        reusable: false,
        reason: `${PACKAGE_NAME} is not in profile ${profile}`,
        bundles,
      }
    }
    return { exists: true, reusable: true, profile: profilePath, bundles, manifest }
  } catch (error) {
    return {
      exists: true,
      reusable: false,
      reason: `invalid profile ${profile}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Keep an existing workspace/storage; create the dev workspace only when absent. */
export function ensureDevWorkspace(home, title = 'p2-dev') {
  const path = join(home, 'workspace')
  if (existsSync(path) && existsSync(join(home, 'storages', 'workspace.json'))) return path
  return writeDevWorkspace(home, title)
}

export function writeDevWorkspace(home, title = 'p2-dev') {
  const id = '00000000-0000-4000-8000-000000000001'
  const path = join(home, 'workspace')
  const now = new Date().toISOString()
  mkdirSync(path, { recursive: true })
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [id],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: id,
    },
    tables: {
      workspaces: {
        [id]: {
          path,
          title,
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  }, null, 2)}\n`)
  return path
}

export function copyCredentials(sourceHome, home) {
  const source = join(sourceHome, '.credentials.yaml')
  if (!existsSync(source)) return false
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.credentials.yaml'), readFileSync(source))
  return true
}

export function removeHome(home) {
  rmSync(home, { recursive: true, force: true })
}

export function fail(message, home) {
  process.stderr.write(`\n${message}\n`)
  if (home !== undefined) process.stderr.write(`diagnostics kept at ${home}\n`)
  process.exitCode = 1
}
