/**
 * Throwaway profile management.
 *
 * Every measurement runs against a fresh profile under a fresh DSH_HOME, in a
 * fresh working directory. Nothing here reads or writes the real `~/.dsh`
 * profile: the subject plugin only ever executes inside that disposable tree.
 */
import fs from 'node:fs'
import path from 'node:path'
import { runChild, childEnv } from './environment.mjs'

/** Recursively copy a directory, skipping installed dependencies of the source. */
export function copyPackage(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) copyPackage(from, to)
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to)
    else fs.copyFileSync(from, to)
  }
}

/** A package directory in a profile's node_modules for a package name. */
export function packageDir(profileDir, name) {
  return path.join(profileDir, 'node_modules', ...name.split('/'))
}

/** Read the package name from a package.json in `dir`. */
export function packageName(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`report card: package at ${dir} has no name`)
  }
  return { name: manifest.name, manifest }
}

/**
 * Create a measuring home and initialize a profile from a shipped template.
 * @returns {{ root: string, home: string, workspace: string, profileDir: string, profile: string }}
 */
export async function createMeasuredHome({ runtime, root, template = 'headless', profile = 'rc-measured' }) {
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const initialized = await runChild({
    runtime,
    args: ['--profile', profile, '--from-default-profile', template, '--dump-config'],
    cwd: workspace,
    env: childEnv(runtime, { home }),
    timeoutMs: 120_000,
  })
  const profileDir = path.join(home, 'profiles', profile)
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    throw new Error(
      `report card: could not initialize profile ${profile}\n${initialized.stderr.slice(-2000)}`,
    )
  }
  return { root, home, workspace, profileDir, profile }
}

/** The package name part of an npm spec (`@scope/pkg@1.2.3` → `@scope/pkg`). */
export function nameFromSpec(spec) {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/**
 * Install a package directory into the measured profile.
 *
 * A local directory is copied; an npm spec is installed by the dsh CLI itself
 * (`dsh plugin add`), which forwards to the profile's package manager. A
 * rejected install — most often a peer-compatibility gate — is returned as a
 * result, not thrown: on this runtime the refusal *is* the finding.
 */
export async function installIntoProfile({ runtime, measured, subject, log = () => {} }) {
  if (subject.kind === 'dir') {
    const { name } = packageName(subject.dir)
    const destination = packageDir(measured.profileDir, name)
    copyPackage(subject.dir, destination)
    log(`installed local package ${name} -> ${destination}`)
    return { name, dir: destination }
  }

  const before = new Set(Object.keys(readDependencies(measured.profileDir)))
  // A tarball must be passed by absolute path: the package manager runs in the
  // profile directory. Named specs stay exactly as the user wrote them.
  const installSpec = subject.installSpec ?? subject.spec
  const result = await runChild({
    runtime,
    args: ['plugin', '--profile', measured.profile, 'add', installSpec],
    cwd: measured.workspace,
    env: childEnv(runtime, { home: measured.home }),
    timeoutMs: 300_000,
  })
  if (result.code !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim()
    log(`install rejected: ${subject.spec}`)
    return {
      name: nameFromSpec(subject.spec),
      rejected: {
        spec: subject.spec,
        message: rejectionMessage(output),
        output: output.slice(-6000),
      },
    }
  }
  const dependencies = readDependencies(measured.profileDir)
  const added = Object.keys(dependencies).filter((name) => !before.has(name))
  const name = added[0]
  if (name === undefined) {
    throw new Error(`report card: installed ${subject.spec} but no new dependency appeared in the profile`)
  }
  const dir = packageDir(measured.profileDir, name)
  if (!fs.existsSync(dir)) {
    throw new Error(`report card: ${name} is not present at ${dir} after install`)
  }
  log(`installed ${subject.spec} as ${name}`)
  return { name, dir }
}

/** The human-readable refusal from an install's output, without stack noise. */
function rejectionMessage(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^\s+at\s/.test(line) && !line.startsWith('throw new Error'))
  const interesting = lines.find((line) => /incompatible|installation rejected|cannot resolve|not installed|ERR_[A-Z]+/i.test(line))
  return (interesting ?? lines.find((line) => line.startsWith('dsh:')) ?? lines.at(-1) ?? 'installation failed').slice(0, 500)
}

/** The version named by a package spec, when it names one. */
export function versionFromSpec(spec) {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return null
  const candidate = spec.slice(at + 1)
  return /^\d/.test(candidate) ? candidate : null
}

/** The profile's dependency map, normalized from the package.json forms pnpm writes. */
export function readDependencies(profileDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  return { ...(manifest.devDependencies ?? {}), ...(manifest.dependencies ?? {}) }
}

/** Install the probe package (shipped beside this harness) into the measured profile. */
export function installProbe(measured) {
  const source = path.join(import.meta.dirname, 'probe')
  const { name } = packageName(source)
  copyPackage(source, packageDir(measured.profileDir, name))
  return name
}

/**
 * Write a `--patch` overlay: the subject plugin, then the probe.
 *
 * Plain plugins are inserted by package name. A bundle (a package that ships
 * `dsh.bundle.patch`) is appended to the profile's bundle list instead, which is
 * how a shipped profile composes one.
 */
export function writeOverlay({ measured, name, subjectName, probeName, extraEntries = [] }) {
  const entries = extraEntries.map((entry) => renderInsert(entry))
  if (subjectName !== undefined) {
    entries.push(renderInsert({ id: 'report-card-subject', name: subjectName, config: {}, disabled: false }))
  }
  if (probeName !== undefined) {
    entries.push(renderInsert({ id: 'report-card-probe', name: probeName, config: {}, disabled: false }))
  }
  const overlay = path.join(measured.root, `overlay-${name}.yml`)
  const body = entries.length === 0 ? '# no entries\n' : `- insert:\n${entries.join('\n')}\n`
  fs.writeFileSync(overlay, `# report card measurement overlay (generated)\n${body}`)
  return overlay
}

/** Render one YAML insert row; values here are package names and empty configs. */
function renderInsert({ id, name, config, disabled }) {
  const lines = [`    - id: ${JSON.stringify(id)}`, `      name: ${JSON.stringify(name)}`]
  if (disabled) lines.push('      disabled: true')
  if (config !== undefined) lines.push(`      config: ${JSON.stringify(config)}`)
  return lines.join('\n')
}

/**
 * Append a bundle package to the profile's bundle list, the way app-boot
 * composes a shipped profile bundle.
 */
export function addProfileBundle(measured, bundleName) {
  const file = path.join(measured.profileDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = manifest.dsh.profile.bundles ?? []
  if (!bundles.includes(bundleName)) bundles.push(bundleName)
  manifest.dsh.profile.bundles = bundles
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Whether a package directory ships a bundle patch (so it composes like a bundle). */
export function isBundle(pkgDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    return typeof manifest.dsh?.bundle?.patch === 'string'
  } catch {
    return false
  }
}

/** Delete a measured tree; measurement never leaves state behind. */
export function removeTree(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // A leftover temp tree is harmless; the next run uses a new one.
  }
}
