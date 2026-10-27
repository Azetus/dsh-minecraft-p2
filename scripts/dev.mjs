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
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  DEV_HOME,
  NEEDS_SHELL,
  PACKAGE_NAME,
  captureDsh,
  commandLine,
  copyCredentials,
  ensureWebProfile,
  fail,
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
  --port <port>       web port; 0 lets the OS choose (default: 0)
  --open              let DSH open a browser (default: no)
  --with-credentials  copy .credentials.yaml from the real DSH_HOME
  --profile <name>    generated profile name (default: p2-dev)
  --dsh-home <path>   where to read credentials from
  -h, --help          this text

The generated home is always rebuilt, except with --keep after a failed run.
`)
      process.exit(0)
      break
    default:
      process.stderr.write(`unknown argument: ${arg}\n`)
      process.exit(2)
  }
}

const home = join(DEV_HOME, 'run')

function stage() {
  if (options.build) {
    const built = runNpm(['run', 'bundle'])
    if (built.status !== 0) {
      fail('dev: bundle build failed', home)
      return false
    }
  }

  removeHome(home)
  mkdirSync(home, { recursive: true })

  const installed = installBundle(home, options.profile)
  if (installed.status !== 0) {
    fail('dev: dsh plugin install failed', home)
    return false
  }

  const manifest = ensureWebProfile(home, options.profile)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(PACKAGE_NAME)) {
    fail(`dev: ${PACKAGE_NAME} is not in the generated profile`, home)
    return false
  }

  const workspace = writeDevWorkspace(home, 'p2-dev')
  const credentials = options.withCredentials
    ? copyCredentials(options.credentialsHome, home)
    : false

  process.stdout.write(
    `dev: staged\n`
    + `  DSH_HOME: ${home}\n`
    + `  profile: ${options.profile}\n`
    + `  bundles: ${bundles.join(', ')}\n`
    + `  workspace: ${workspace}\n`
    + `  credentials: ${credentials ? 'copied' : 'not copied'}\n`,
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
  else {
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
    if (success && !options.keep) removeHome(home)
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
