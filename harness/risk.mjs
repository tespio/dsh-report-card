/**
 * Static risk scan of an installed plugin package.
 *
 * This is disclosure, not a verdict: it reports what the package *declares and
 * contains* — install scripts, native binaries, network hosts, process and
 * filesystem reach — so a reader can judge it. Nothing here executes the code.
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_FILES = 4000
const MAX_BYTES = 1_500_000
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yml', '.yaml', '.md', '.txt',
  '.sh', '.ps1', '.cmd', '.bat', '.py', '.toml', '.html', '.css', '.svg', '.vue', '.svelte',
])
const BINARY_EXTENSIONS = new Set(['.node', '.exe', '.dll', '.so', '.dylib', '.wasm', '.bin', '.pdb', '.lib', '.a'])
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']

const PATTERNS = [
  { id: 'child-process', level: 'medium', detail: 'starts subprocesses', re: /\b(child_process|execSync|execFileSync|spawnSync|execFile|spawn)\s*\(/ },
  { id: 'dynamic-code', level: 'medium', detail: 'evaluates code at runtime', re: /\b(eval|new Function)\s*\(/ },
  { id: 'file-write', level: 'medium', detail: 'writes to the filesystem', re: /\b(writeFileSync|writeFile|appendFile|createWriteStream|rmSync|unlinkSync|renameSync|mkdirSync)\s*\(/ },
  { id: 'process-exit', level: 'medium', detail: 'can terminate the host process', re: /\bprocess\.exit\s*\(/ },
  { id: 'host-modification', level: 'high', detail: 'modifies the running harness', re: /\b(prototype\s*\.\s*[A-Za-z_$][\w$]*\s*=|Object\.defineProperty\s*\(\s*(prototype|Object\.getPrototypeOf))/ },
  { id: 'env-read', level: 'info', detail: 'reads process environment', re: /\bprocess\.env\b/ },
  { id: 'network-fetch', level: 'info', detail: 'performs network requests', re: /\b(fetch|https?\.request|https?\.get|axios|undici)\s*\(/ },
]
const HOST_RE = /\bhttps?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi

/** Whether a byte buffer looks like text. */
function looksText(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096))
  return !probe.includes(0)
}

/** Walk a package directory, bounded, yielding files. */
function* walk(dir, state) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (state.files >= MAX_FILES) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue
      yield* walk(full, state)
    } else if (entry.isFile()) {
      state.files += 1
      yield full
    }
  }
}

/** One line of context around a match, trimmed for the report. */
function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 160)
}

/**
 * Scan one installed package directory.
 * @param packageDir absolute path of the installed package
 * @returns `{ flags, packageJson, filesScanned, hosts, installScripts, binaries, dependencies }`
 */
export function scanPackage(packageDir) {
  const flags = []
  const evidence = new Map()
  const hosts = new Map()
  const binaries = []
  const installScripts = []
  const files = []
  let manifest = {}
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return { error: `no readable package.json in ${packageDir}`, flags: [], filesScanned: 0 }
  }

  for (const script of INSTALL_SCRIPTS) {
    const command = manifest.scripts?.[script]
    if (typeof command === 'string') installScripts.push({ script, command: command.slice(0, 200) })
  }
  if (installScripts.length > 0) {
    flags.push({
      id: 'install-scripts',
      level: 'high',
      detail: `runs code during install: ${installScripts.map((entry) => entry.script).join(', ')}`,
    })
  }

  const state = { files: 0 }
  for (const file of walk(packageDir, state)) {
    files.push(path.relative(packageDir, file))
    const extension = path.extname(file).toLowerCase()
    if (BINARY_EXTENSIONS.has(extension)) binaries.push(path.relative(packageDir, file))
    if (!TEXT_EXTENSIONS.has(extension)) continue
    let buffer
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_BYTES) continue
      buffer = fs.readFileSync(file)
    } catch {
      continue
    }
    if (!looksText(buffer)) continue
    const text = buffer.toString('utf8')
    const relative = path.relative(packageDir, file)

    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(text)
      if (match === null) continue
      if (!evidence.has(pattern.id)) {
        evidence.set(pattern.id, [])
        flags.push({ id: pattern.id, level: pattern.level, detail: pattern.detail })
      }
      const list = evidence.get(pattern.id)
      if (list.length < 5) list.push({ file: relative, line: lineAt(text, match.index) })
    }

    for (const match of text.matchAll(HOST_RE)) {
      const host = match[1].toLowerCase()
      if (!hosts.has(host)) hosts.set(host, [])
      const list = hosts.get(host)
      if (list.length < 3) list.push(relative)
    }
  }

  if (binaries.length > 0) {
    flags.push({
      id: 'native-binaries',
      level: 'high',
      detail: `ships platform binaries: ${binaries.slice(0, 5).join(', ')}`,
    })
  }
  if (hosts.size > 0) {
    flags.push({
      id: 'network-hosts',
      level: hosts.size > 3 ? 'medium' : 'info',
      detail: `${hosts.size} host${hosts.size === 1 ? '' : 's'} referenced: ${[...hosts.keys()].slice(0, 8).join(', ')}`,
    })
  }

  const order = { high: 0, medium: 1, info: 2 }
  flags.sort((a, b) => order[a.level] - order[b.level] || a.id.localeCompare(b.id))

  return {
    flags: flags.map((flag) => ({ ...flag, evidence: evidence.get(flag.id) ?? [] })),
    packageJson: {
      name: manifest.name ?? null,
      version: manifest.version ?? null,
      dependencies: Object.keys(manifest.dependencies ?? {}).length,
      peerDependencies: Object.keys(manifest.peerDependencies ?? {}).length,
      license: manifest.license ?? null,
      engines: manifest.engines ?? null,
    },
    dependencies: manifest.dependencies ?? {},
    installScripts,
    binaries,
    hosts: [...hosts.keys()].sort(),
    filesScanned: files.length,
    bytesScanned: undefined,
  }
}

/** Count of each flag level, for the report header. */
export function flagSummary(flags) {
  const summary = { high: 0, medium: 0, info: 0 }
  for (const flag of flags) summary[flag.level] = (summary[flag.level] ?? 0) + 1
  return summary
}
