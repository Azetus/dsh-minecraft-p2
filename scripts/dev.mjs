#!/usr/bin/env node
/**
 * Start DSH against a staged copy of this checkout.
 *
 * The generated profile and DSH_HOME live under `.dev-home/run`, so a dev run
 * cannot modify the real Desktop profile or create a workspace in Documents.
 * The tarball installed here is the same one `npm run bundle` produces.
 *
 * Use `--no-start` to stage and validate the profile without starting a server.
 * Use `--keep` to keep the generated home for inspection.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  DEV_HOME,
  NEEDS_SHELL,
  PACKAGE_NAME,
  captureDsh,
  commandLine,
  copyCredentials,
  ensureDevWorkspace,
  ensureWebProfile,
  fail,
  inspectDevHome,
  installBundle,
  removeHome,
  runNpm,
  writeDevWorkspace,
} from './dev-lib.mjs'

const options = {
  build: true,
  keep: false,
  start: true,
  open: false,
  withCredentials: false,
  reuse: false,
  refresh: false,
  port: 0,
  profile: 'p2-dev',
  credentialsHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
}

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  switch (arg) {
    case '--no-build':
      options.build = false
      break
    case '--keep':
      options.keep = true
      break
    case '--no-start':
      options.start = false
      break
    case '--open':
      options.open = true
      break
    case '--with-credentials':
      options.withCredentials = true
      break
    case '--reuse':
      options.reuse = true
      break
    case '--refresh':
      options.reuse = true
      options.refresh = true
      break
    case '--fresh':
      options.reuse = false
      options.refresh = false
      break
    case '--port':
      options.port = Number(process.argv[++index])
      if (!Number.isInteger(options.port) || options.port < 0) {
        process.stderr.write('dev: --port requires a non-negative integer\n')
        process.exit(2)
      }
      break
    case '--profile':
      options.profile = process.argv[++index]
      break
    case '--dsh-home':
      options.credentialsHome = process.argv[++index]
      break
    case '--help':
    case '-h':
      process.stdout.write(`Usage: node scripts/dev.mjs [options]

Options:
  --no-build          use the existing bundles/*.tgz
  --no-start          stage and validate the profile, then exit
  --keep              keep .dev-home/run after exit
  --reuse             reuse an existing .dev-home/run (sessions/workspace/credentials)
  --refresh           reuse the home and reinstall the current tarball
  --fresh             force a fresh .dev-home/run (default)
  --port <port>       web port; 0 lets the OS choose (default: 0)
  --open              let DSH open a browser (default: no)
  --with-credentials  copy .credentials.yaml from the real DSH_HOME
  --profile <name>    generated profile name (default: p2-dev)
  --dsh-home <path>   where to read credentials from
  -h, --help          this text

The generated home is rebuilt by default. --reuse keeps an existing run and
its sessions/workspace; --refresh updates its installed tarball in place.
`)
      process.exit(0)
      break
    default:
      process.stderr.write(`unknown argument: ${arg}\n`)
      process.exit(2)
  }
}

const home = join(DEV_HOME, 'run')
let reusedHome = false

function stage() {
  const inspection = inspectDevHome(home, options.profile)
  const wantsReuse = options.reuse
  if (wantsReuse && inspection.exists && !inspection.reusable && !options.refresh) {
    fail(
      `dev: cannot reuse ${home}: ${inspection.reason}; use --refresh to reinstall or --fresh to rebuild`,
      home,
    )
    return false
  }

  const reusing = wantsReuse && inspection.exists && (inspection.reusable || options.refresh)
  const needBuild = options.build && (!reusing || options.refresh)
  if (needBuild) {
    const built = runNpm(['run', 'bundle'])
    if (built.status !== 0) {
      fail('dev: bundle build failed', home)
      return false
    }
  }

  let bundles
  let manifest
  let bundleState
  if (reusing) {
    reusedHome = true
    if (options.refresh) {
      const installed = installBundle(home, options.profile, undefined, { force: true })
      if (installed.status !== 0) {
        fail('dev: dsh plugin refresh failed', home)
        return false
      }
      manifest = ensureWebProfile(home, options.profile)
      bundleState = 'refreshed'
    } else {
      manifest = inspection.manifest
      bundleState = 'reused'
    }
    bundles = manifest.dsh?.profile?.bundles ?? []
    if (!bundles.includes(PACKAGE_NAME)) {
      fail(`dev: ${PACKAGE_NAME} is not in the reused profile`, home)
      return false
    }
  } else {
    if (wantsReuse) {
      process.stdout.write(`dev: reuse unavailable (${inspection.reason}); staging fresh\n`)
    }
    removeHome(home)
    mkdirSync(home, { recursive: true })
    const installed = installBundle(home, options.profile)
    if (installed.status !== 0) {
      fail('dev: dsh plugin install failed', home)
      return false
    }
    manifest = ensureWebProfile(home, options.profile)
    bundles = manifest.dsh?.profile?.bundles ?? []
    if (!bundles.includes(PACKAGE_NAME)) {
      fail(`dev: ${PACKAGE_NAME} is not in the generated profile`, home)
      return false
    }
    bundleState = 'installed'
  }

  const workspace = reusing
    ? ensureDevWorkspace(home, 'p2-dev')
    : writeDevWorkspace(home, 'p2-dev')
  const copiedCredentials = options.withCredentials
    ? copyCredentials(options.credentialsHome, home)
    : false
  const credentials = copiedCredentials || existsSync(join(home, '.credentials.yaml'))

  process.stdout.write(
    `${reusing ? 'dev: reused' : 'dev: staged'}\n`
    + `  DSH_HOME: ${home}\n`
    + `  profile: ${options.profile}\n`
    + `  bundle: ${bundleState}\n`
    + `  bundles: ${bundles.join(', ')}\n`
    + `  workspace: ${workspace}\n`
    + `  credentials: ${options.withCredentials
      ? (copiedCredentials ? 'copied' : (credentials ? 'kept' : 'source missing'))
      : (credentials ? 'kept' : 'not copied')}\n`,
  )

  if (!credentials) {
    process.stdout.write('  note: model turns will fail until --with-credentials is used\n')
  }
  return true
}

function checkProfile() {
  const log = join(home, 'dev-check.log')
  const result = captureDsh(['--profile', options.profile, '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    log,
  })
  if (result.status !== 0 || !result.output.includes(PACKAGE_NAME)) {
    process.stderr.write(result.output)
    fail('dev: profile check failed', home)
    return false
  }
  if (options.keep) process.stdout.write(`  check: ${log}\n`)
  else if (reusedHome) {
    process.stdout.write(`  check: ok; home kept (${home})\n`)
  } else {
    removeHome(home)
    process.stdout.write('  check: ok; home removed\n')
  }
  return true
}

function start() {
  const args = ['--profile', options.profile, '--port', String(options.port)]
  if (!options.open) args.push('--no-open')

  process.stdout.write(
    `dev: starting dsh --profile ${options.profile} --port ${options.port}${options.open ? '' : ' --no-open'}\n`,
  )

  const child = spawn(commandLine('dsh', args), {
    cwd: process.cwd(),
    env: { ...process.env, DSH_HOME: home, NODE_NO_WARNINGS: '1' },
    stdio: 'inherit',
    shell: NEEDS_SHELL,
  })

  let stopping = false
  const stop = signal => {
    if (stopping) {
      child.kill('SIGKILL')
      return
    }
    stopping = true
    process.stdout.write(`\ndev: ${signal} received; stopping dsh (again to force)\n`)
    child.kill(signal)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => stop(signal))
  }

  child.on('error', error => {
    fail(`dev: failed to start dsh: ${error.message}`, home)
  })
  child.on('exit', (code, signal) => {
    const success = code === 0 && signal === null
    if (success || options.keep) {
      process.stdout.write(`dev: dsh exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})\n`)
    }
    if (success && !options.keep && !reusedHome) removeHome(home)
    else process.stdout.write(`dev: diagnostics kept at ${home}\n`)
    process.exit(code ?? (success ? 0 : 1))
  })
}

if (stage()) {
  if (!options.start) {
    checkProfile()
  } else {
    start()
  }
}
