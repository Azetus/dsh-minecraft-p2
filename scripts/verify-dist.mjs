#!/usr/bin/env node
/**
 * Verify the built tarball as an installed DSH bundle.
 *
 * This is the non-interactive counterpart of `scripts/dev.mjs`: it creates a
 * throwaway DSH_HOME, installs the exact `bundles/*.tgz` a user would install,
 * and checks that DSH can compose and import it. It never starts a server and
 * never touches the real Desktop profile.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEV_HOME,
  PACKAGE_NAME,
  TARBALL,
  captureDsh,
  fail,
  installBundle,
  readProfile,
  removeHome,
  runNpm,
} from './dev-lib.mjs'

const options = {
  build: true,
  keep: false,
}

for (const arg of process.argv.slice(2)) {
  switch (arg) {
    case '--no-build':
      options.build = false
      break
    case '--keep':
      options.keep = true
      break
    case '--help':
    case '-h':
      process.stdout.write(`Usage: node scripts/verify-dist.mjs [--no-build] [--keep]

Builds the tarball (unless --no-build), installs it into an isolated DSH_HOME,
then checks profile composition and module import. --keep preserves the home.
`)
      process.exit(0)
      break
    default:
      process.stderr.write(`unknown argument: ${arg}\n`)
      process.exit(2)
  }
}

const home = join(DEV_HOME, 'verify')
const profile = 'p2-verify'

function main() {
  if (options.build) {
    const built = runNpm(['run', 'bundle'])
    if (built.status !== 0) {
      fail('verify-dist: bundle build failed', home)
      return
    }
  }

  if (!existsSync(TARBALL)) {
    fail(`verify-dist: missing ${TARBALL}; run \`npm run bundle\` first`, home)
    return
  }

  removeHome(home)
  mkdirSync(home, { recursive: true })

  const installed = installBundle(home, profile)
  if (installed.status !== 0) {
    fail('verify-dist: dsh plugin install failed', home)
    return
  }

  const manifest = readProfile(home, profile)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(PACKAGE_NAME)) {
    fail(`verify-dist: ${PACKAGE_NAME} is not in dsh.profile.bundles (${bundles.join(', ')})`, home)
    return
  }

  const configLog = join(home, 'dump-config.log')
  const config = captureDsh(['--profile', profile, '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    log: configLog,
  })
  if (config.status !== 0 || !config.output.includes(PACKAGE_NAME)) {
    process.stderr.write(config.output)
    fail(`verify-dist: --dump-config failed or omitted ${PACKAGE_NAME}`, home)
    return
  }

  const schemaLog = join(home, 'dump-config-schema.log')
  const schema = captureDsh(['--profile', profile, '--dump-config-schema'], {
    env: { ...process.env, DSH_HOME: home },
    log: schemaLog,
  })
  if (schema.status !== 0) {
    process.stderr.write(schema.output)
    fail('verify-dist: --dump-config-schema failed', home)
    return
  }

  process.stdout.write(
    `verify-dist: ok\n`
    + `  tarball: ${TARBALL}\n`
    + `  profile: ${profile}\n`
    + `  bundles: ${bundles.join(', ')}\n`,
  )

  if (options.keep) {
    process.stdout.write(
      `  composition: ${configLog}\n`
      + `  schema import: ${schemaLog}\n`
      + `  kept: ${home}\n`,
    )
  } else {
    removeHome(home)
    process.stdout.write('  home: removed after successful check\n')
  }
}

main()
