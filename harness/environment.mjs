/**
 * Locate the dsh runtime this machine actually runs, and prove it works.
 *
 * The harness never imports harness code into the measuring process: every
 * number comes from a separate `dsh --profile ...` child. Two runtimes are
 * possible: the Desktop application (Electron binary run as Node, reading the
 * harness out of `app.asar`) and a plain `dsh` CLI on PATH.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Candidates for the Desktop install, most specific first. */
function desktopCandidates() {
  const out = []
  const override = process.env.DSH_REPORT_CARD_INSTALL
  if (override) out.push(override)
  if (process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'))
  }
  if (process.env.ProgramFiles) {
    out.push(path.join(process.env.ProgramFiles, 'DeepSeek Harness'))
  }
  out.push('/Applications/DeepSeek Harness.app/Contents/MacOS')
  out.push('/opt/DeepSeek Harness')
  return out
}

/** Resolve the Electron executable and the CLI script for one Desktop install. */
function desktopRuntime(installDir) {
  const names = ['DeepSeek Harness.exe', 'DeepSeek Harness', 'deepseek-harness']
  for (const name of names) {
    const exe = path.join(installDir, name)
    const resources = path.join(installDir, 'resources')
    // A plain Node build ships the same tree unpacked instead of inside app.asar.
    for (const root of [path.join(resources, 'app.asar'), path.join(resources, 'app')]) {
      const cli = path.join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (fs.existsSync(exe)) return { kind: 'electron', exe, cli, dshRoot: path.join(root, 'dsh'), installDir }
    }
  }
  return undefined
}

/**
 * Detect the runtime, or accept an explicit one.
 *
 * `overrides` may carry `exe`, `cli`, and `dshRoot` — the tests pass a plain
 * Node executable and an unpacked harness tree.
 */
export function detectRuntime(overrides = {}) {
  if (overrides.exe && overrides.cli) {
    return {
      kind: overrides.kind ?? 'explicit',
      exe: overrides.exe,
      cli: overrides.cli,
      dshRoot: overrides.dshRoot,
      version: undefined,
    }
  }
  if (process.versions.electron !== undefined && process.resourcesPath) {
    const resources = process.resourcesPath
    const root = fs.existsSync(path.join(resources, 'app.asar'))
      ? path.join(resources, 'app.asar')
      : path.join(resources, 'app')
    return {
      kind: 'desktop-host',
      exe: process.execPath,
      cli: path.join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      dshRoot: path.join(root, 'dsh'),
      version: undefined,
    }
  }
  const fromEnv = process.env.DSH_REPORT_CARD_CLI
  if (fromEnv) {
    return { kind: 'env', exe: process.execPath, cli: fromEnv, dshRoot: undefined, version: undefined }
  }
  for (const dir of desktopCandidates()) {
    const found = desktopRuntime(dir)
    if (found) return { ...found, version: undefined }
  }
  throw new Error(
    'report card: no dsh runtime found. Set DSH_REPORT_CARD_INSTALL to the Desktop install directory, '
    + 'or DSH_REPORT_CARD_CLI to a dsh bin.js, or pass --exe/--cli.',
  )
}

/** Environment for a measuring child: isolated home, no inherited session, no telemetry. */
export function childEnv(runtime, { home, baseUrl, extra = {} } = {}) {
  const env = { ...process.env }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL', 'DSH_WS']) {
    delete env[key]
  }
  env.DSH_HOME = home
  env.DSH_TELEMETRY_DISABLED = '1'
  env.DSH_PERMISSION_MODE = 'read-only'
  env.DEEPSEEK_API_KEY = 'report-card-fixture-key'
  if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl
  if (runtime.kind === 'electron' || runtime.kind === 'desktop-host') env.ELECTRON_RUN_AS_NODE = '1'
  return { ...env, ...extra }
}

/** Run one child to completion, capturing stdout/stderr and line timings. */
export function runChild({ runtime, args, cwd, env, timeoutMs = 120_000, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('report card: cancelled'))
      return
    }
    const startedAt = Date.now()
    const child = spawn(runtime.exe, [runtime.cli, ...args], { cwd, env, windowsHide: true })
    const lines = []
    let buffer = ''
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(Object.assign(new Error(`report card: child exceeded ${timeoutMs}ms`), { stdout, stderr, lines })))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        lines.push({ at: Date.now(), line: buffer.slice(0, index) })
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish(() => reject(error))
    })
    child.on('close', (code, exitSignal) => {
      finish(() => {
        if (buffer.length > 0) lines.push({ at: Date.now(), line: buffer })
        resolve({ code, signal: exitSignal, startedAt, endedAt: Date.now(), stdout, stderr, lines })
      })
    })
  })
}

/** Parse the newline-delimited run events a headless `--json` run emits. */
export function parseRunEvents(lines) {
  const events = []
  for (const entry of lines) {
    const text = entry.line.trim()
    if (text === '' || !text.startsWith('{')) continue
    try {
      events.push({ at: entry.at, event: JSON.parse(text) })
    } catch {
      // A truncated line is not a run event; the caller reports the raw tail.
    }
  }
  return events
}
