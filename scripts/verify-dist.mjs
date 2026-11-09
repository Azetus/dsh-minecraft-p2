#!/usr/bin/env node
/**
 * Verify the built tarball as an installed DSH bundle.
 *
 * This is the non-interactive counterpart of `scripts/dev.mjs`: it creates a
 * throwaway DSH_HOME, installs the exact `bundles/*.tgz` a user would install,
 * and checks that DSH can compose and import it. It never starts a server and
 * never touches the real Desktop profile.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEV_HOME,
  PACKAGE_NAME,
  ROOT,
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
  return mainAsync()
}

async function mainAsync() {
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

  const installedResult = installBundle(home, profile)
  if (installedResult.status !== 0) {
    fail('verify-dist: dsh plugin install failed', home)
    return
  }

  const manifest = readProfile(home, profile)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(PACKAGE_NAME)) {
    fail(`verify-dist: ${PACKAGE_NAME} is not in dsh.profile.bundles (${bundles.join(', ')})`, home)
    return
  }

  const profileDir = join(home, 'profiles', profile)
  const installedDir = join(profileDir, 'node_modules', PACKAGE_NAME)
  for (const relative of [
    'package.json',
    'cordis.patch.yml',
    'lib/bridge.js',
    'lib/body/body.mjs',
    'lib/body/body.manifest.json',
    'lib/provider/minecraft.mjs',
  ]) {
    if (!existsSync(join(installedDir, relative))) {
      fail(`verify-dist: installed package is missing ${relative}`, home)
      return
    }
  }

  const installedManifest = JSON.parse(await readFile(join(installedDir, 'package.json'), 'utf8'))
  const bodyManifest = JSON.parse(await readFile(join(installedDir, 'lib/body/body.manifest.json'), 'utf8'))
  if (bodyManifest.bodyVersion !== installedManifest.version || bodyManifest.protocolVersion !== 1) {
    fail('verify-dist: body manifest version/protocol does not match the package', home)
    return
  }
  const bodyDigest = createHash('sha256')
    .update(await readFile(join(installedDir, 'lib/body/body.mjs')))
    .digest('hex')
  if (bodyManifest.files['body.mjs'] !== bodyDigest) {
    fail('verify-dist: body manifest digest does not match lib/body/body.mjs', home)
    return
  }

  const projectDir = join(home, 'project')
  mkdirSync(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'package.json'), `${JSON.stringify({
    name: 'p2-verify-project',
    private: true,
    type: 'module',
  }, null, 2)}\n`)
  const projectInstall = runNpm([
    'install',
    '--prefix',
    projectDir,
    '--no-audit',
    '--no-fund',
    '--cache',
    join(ROOT, '.npm-cache'),
    TARBALL,
  ])
  if (projectInstall.status !== 0) {
    fail('verify-dist: project install failed', home)
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

await main()
