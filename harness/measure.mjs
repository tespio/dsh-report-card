/**
 * The measurement engine: one throwaway profile, two variants, four runs.
 *
 *   surface baseline   probe only            -> boot time + composed surface
 *   surface subject    subject + probe       -> boot time + composed surface
 *   turn baseline      (no overlay)          -> scripted turn + exact request
 *   turn subject       subject overlay       -> scripted turn + exact request
 *
 * Every number is a wall-clock reading from a real harness process. The model
 * is a local fixture endpoint, so a turn costs no network and no tokens.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { childEnv, parseRunEvents, runChild } from './environment.mjs'
import { startMockLlm } from './mock-llm.mjs'
import { scanPackage } from './risk.mjs'
import {
  addProfileBundle,
  createMeasuredHome,
  installIntoProfile,
  installProbe,
  isBundle,
  packageName,
  removeTree,
  versionFromSpec,
  writeOverlay,
} from './profile.mjs'

/** The fixed task every measured turn asks; it never reaches a real model. */
export const FIXTURE_TASK = 'say OK'

/**
 * Fixture overlay rows shared by both variants: the profile is pinned to one
 * shape so the comparison is between plugins, not between background jobs.
 */
const FIXTURE_ROWS = `# report card fixture: pin background work out of the measurement
- id: session-title-llm
  disabled: true
`

/** Median of a numeric list; NaN for an empty list. */
export function median(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (finite.length === 0) return Number.NaN
  const middle = Math.floor(finite.length / 2)
  return finite.length % 2 === 1 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2
}

/** Smallest and largest finite reading, for jitter reporting. */
export function spread(values) {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return { min: Number.NaN, max: Number.NaN }
  return { min: Math.min(...finite), max: Math.max(...finite) }
}

/** Percentage of `delta` relative to `base`, or null when base is unusable. */
export function percent(delta, base) {
  if (!Number.isFinite(delta) || !Number.isFinite(base) || base === 0) return null
  return (delta / base) * 100
}

/** The system prompt text of one Messages request, flattened across block forms. */
function systemText(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system.map((block) => (typeof block === 'string' ? block : block?.text ?? '')).join('\n\n')
}

/** Model-visible prompt facts of one captured request. */
export function describeRequest(body) {
  if (body === null || typeof body !== 'object') return undefined
  const system = systemText(body.system)
  const tools = Array.isArray(body.tools) ? body.tools : []
  const messages = Array.isArray(body.messages) ? body.messages : []
  const toolsJson = JSON.stringify(tools)
  const messagesJson = JSON.stringify(messages)
  const extensions = {}
  for (const key of ['dsh_session_log', 'dsh_plugin_packages']) {
    if (body[key] !== undefined) extensions[key] = JSON.stringify(body[key]).length
  }
  const modelVisibleChars = system.length + toolsJson.length + messagesJson.length
  return {
    model: typeof body.model === 'string' ? body.model : null,
    stream: body.stream === true,
    systemChars: system.length,
    toolsChars: toolsJson.length,
    messagesChars: messagesJson.length,
    modelVisibleChars,
    heuristicTokens: Math.ceil(modelVisibleChars / 4),
    extensionChars: extensions,
    toolNames: tools.map((tool) => tool?.name).filter((name) => typeof name === 'string').sort(),
    toolSchemaChars: Object.fromEntries(
      tools
        .filter((tool) => typeof tool?.name === 'string')
        .map((tool) => [tool.name, JSON.stringify(tool).length]),
    ),
    messageCount: messages.length,
  }
}

/** Facts from one `--json` run: boot, turn, and step durations. */
export function describeRun(run, events) {  const at = (predicate) => events.find((entry) => predicate(entry.event))?.at
  const session = at((event) => event.type === 'session')
  const turnStart = at((event) => event.type === 'status' && event.phase === 'turn_start')
  const turnEnd = at((event) => event.type === 'status' && event.phase === 'turn_end')
  const stepStart = at((event) => event.type === 'status' && event.phase === 'step_start')
  const stepEnds = events.filter((entry) => entry.event.type === 'status' && entry.event.phase === 'step_end')
  const final = events.find((entry) => entry.event.type === 'final')
  return {
    exitCode: run.code,
    bootMs: session === undefined ? Number.NaN : session - run.startedAt,
    turnMs: turnStart === undefined || turnEnd === undefined ? Number.NaN : turnEnd - turnStart,
    stepMs: stepStart === undefined || stepEnds.length === 0 ? Number.NaN : stepEnds[0].at - stepStart,
    wallMs: run.endedAt - run.startedAt,
    steps: stepEnds.length,
    completed: final?.event?.reason?.kind === 'completed',
    reason: final?.event?.reason ?? null,
  }
}

/**
 * Pre-request timing from the request itself.
 *
 * The captured Messages body embeds the durable session log, whose events carry
 * the child's own `Date.now()` timestamps. Pairing `step/start` with the moment
 * the request reached the fixture endpoint measures prompt assembly and request
 * serialization without any stdout-pipe latency — the phase where plugin hooks
 * actually run.
 */
export function describeAssembly(request) {
  const log = request?.body?.dsh_session_log
  if (log === undefined || !Array.isArray(log.events) || typeof request.at !== 'number') {
    return { assemblyMs: Number.NaN, turnToRequestMs: Number.NaN, stepStartAt: null }
  }
  let stepStart
  let turnStart
  for (const event of log.events) {
    if (event?.type === 'step/start' && Number.isFinite(event.time)) stepStart = event.time
    if (event?.type === 'turn/start' && Number.isFinite(event.time)) turnStart = event.time
  }
  return {
    assemblyMs: stepStart === undefined ? Number.NaN : request.at - stepStart,
    turnToRequestMs: turnStart === undefined ? Number.NaN : request.at - turnStart,
    stepStartAt: stepStart ?? null,
  }
}

/** The tail of a failed child's stderr, bounded for the report. */function errorTail(run, limit = 4000) {
  const text = `${run.stderr}\n${run.stdout}`.trim()
  return text.length > limit ? text.slice(-limit) : text
}

/** Write the shared fixture overlay file once. */
function writeFixture(measured, name, headers) {
  const file = path.join(measured.root, `${name}.yml`)
  fs.writeFileSync(file, `${FIXTURE_ROWS}${headers}`)
  return file
}

/**
 * Measure one subject.
 *
 * @param subject `{kind: 'dir', dir}` or `{kind: 'npm', spec}`
 * @param options `{runtime, samples, task, template, log, keep}`
 */
export async function measure({ subject, runtime, samples = 5, task = FIXTURE_TASK, template = 'headless', log = () => {}, keep = false, signal }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-card-'))
  const measured = await createMeasuredHome({ runtime, root, template })
  log(`profile: ${measured.profileDir}`)

  const installed = await installIntoProfile({ runtime, measured, subject, log })
  if (installed.rejected !== undefined) {
    // The runtime refused the package before any code ran. That refusal is the
    // finding: we report it and never bypass the gate.
    if (!keep) removeTree(root)
    return {
      root: keep ? root : null,
      measured: keep ? measured : undefined,
      installed: {
        name: installed.name,
        dir: null,
        manifest: { version: versionFromSpec(subject.kind === 'npm' ? subject.spec : '') },
        bundle: false,
        rejected: installed.rejected,
      },
      risk: { flags: [], error: 'the package was not installed, so nothing was scanned' },
      surface: { baseline: [], subject: [] },
      turns: { baseline: [], subject: [] },
      dumps: [],
      failure: { kind: 'install', sample: { stderr: installed.rejected.output, message: installed.rejected.message } },
      samples,
      task,
      template,
    }
  }
  const manifest = packageName(installed.dir).manifest
  // The static scan runs while the package is still on disk; the tree is
  // disposable and is deleted before the report is assembled.
  const risk = scanPackage(installed.dir)
  const bundle = isBundle(installed.dir)
  const probeName = installProbe(measured)
  log(`subject: ${installed.name}${bundle ? ' (bundle)' : ''}`)

  // A bundle composes through the profile's bundle list, which belongs to the
  // profile rather than to one run — so a bundle needs its own baseline
  // profile. A plain plugin is an insert row and both variants share one
  // profile, which keeps the comparison tighter.
  let baselineHome = measured
  let baselineRoot
  if (bundle) {
    addProfileBundle(measured, installed.name)
    baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-card-base-'))
    baselineHome = await createMeasuredHome({ runtime, root: baselineRoot, template })
    installProbe(baselineHome)
  }
  const subjectRow = bundle ? undefined : installed.name
  const homes = { baseline: baselineHome, subject: measured }

  const surfaceBaseline = writeOverlay({ measured: homes.baseline, name: 'surface-baseline', probeName })
  const surfaceSubject = writeOverlay({ measured: homes.subject, name: 'surface-subject', subjectName: subjectRow, probeName })
  const turnSubject = writeOverlay({ measured: homes.subject, name: 'turn-subject', subjectName: subjectRow })

  // The fixture rows apply to every variant, so pin them into all overlays.
  for (const file of [surfaceBaseline, surfaceSubject, turnSubject]) {
    const text = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, `${FIXTURE_ROWS}${text}`)
  }
  const fixtureOnly = writeFixture(homes.baseline, 'fixture-only', '')

  const mock = await startMockLlm({ log })
  const surface = { baseline: [], subject: [] }
  const turns = { baseline: [], subject: [] }
  let failure
  const probeEnv = (dump) => ({ DSH_REPORT_CARD_PROBE: dump, DSH_REPORT_CARD_PROBE_EXIT: '1' })

  /** One surface run: boot the profile until the probe dumps, then exit. */
  const runSurface = async (variant, index, record) => {
    const home = homes[variant]
    const dumpPath = path.join(home.root, `surface-${variant}-${record ? index : `warm-${index}`}.json`)
    const run = await runChild({
      runtime,
      args: [
        '--profile', home.profile,
        '--patch', variant === 'baseline' ? surfaceBaseline : surfaceSubject,
        '--json', task,
      ],
      cwd: home.workspace,
      env: { ...childEnv(runtime, { home: home.home }), ...probeEnv(dumpPath) },
      timeoutMs: 180_000,
      signal,
    })
    const dump = fs.existsSync(dumpPath) ? JSON.parse(fs.readFileSync(dumpPath, 'utf8')) : undefined
    const launchMs = dump?.at === undefined ? Number.NaN : dump.at - run.startedAt
    const bootMs = Number.isFinite(dump?.timeOrigin) ? dump.at - dump.timeOrigin : launchMs
    return {
      index,
      variant,
      exitCode: run.code,
      bootMs,
      bootCpuMs: Number.isFinite(dump?.cpuMs) ? dump.cpuMs : Number.NaN,
      launchMs,
      wallMs: run.endedAt - run.startedAt,
      ok: dump !== undefined && dump.error === undefined,
      error: dump?.error ?? null,
      stderr: dump === undefined ? errorTail(run) : undefined,
      stderrTail: run.stderr.slice(-2000),
    }
  }

  /** One turn run: the scripted turn against the local fixture endpoint. */
  const runTurn = async (variant, index) => {
    const home = homes[variant]
    const before = mock.requests.length
    const run = await runChild({
      runtime,
      args: [
        '--profile', home.profile,
        '--patch', variant === 'baseline' ? fixtureOnly : turnSubject,
        '--json', task,
      ],
      cwd: home.workspace,
      env: childEnv(runtime, { home: home.home, baseUrl: mock.url }),
      timeoutMs: 180_000,
      signal,
    })
    const events = parseRunEvents(run.lines)
    const request = mock.requests.slice(before).filter((entry) => entry.path.endsWith('/messages')).at(-1)
    return {
      index,
      variant,
      ...describeRun(run, events),
      ...describeAssembly(request),
      prompt: describeRequest(request?.body),
      requests: mock.requests.length - before,
      stderr: run.code === 0 ? undefined : errorTail(run),
    }
  }

  try {
    // One discarded pair warms the OS file cache, the module loader, and this
    // machine's antivirus; without it the first sample of either variant is
    // systematically slower and the paired delta inherits that.
    for (const variant of ['baseline', 'subject']) await runSurface(variant, -1, false)
    for (const variant of ['baseline', 'subject']) await runTurn(variant, -1)

    for (let index = 0; index < samples; index += 1) {
      if (signal?.aborted === true) break
      for (const variant of ['baseline', 'subject']) {
        const sample = await runSurface(variant, index, true)
        surface[variant].push(sample)
        if (sample.ok !== true && variant === 'subject') {
          // The subject did not even reach the probe: stop after the first
          // failed sample instead of burning the remaining runs on it.
          failure = { kind: 'boot', sample }
          break
        }
      }
      if (failure) break

      for (const variant of ['baseline', 'subject']) {
        const sample = await runTurn(variant, index)
        turns[variant].push(sample)
        if (sample.exitCode !== 0 && variant === 'subject' && turns.subject.length === 1) {
          failure = { kind: 'turn', sample }
          break
        }
      }
      if (failure) break
    }
  } finally {
    await mock.close()
  }

  const surfaceDumps = []
  for (const variant of ['subject', 'baseline']) {
    for (let index = 0; index < samples; index += 1) {
      const file = path.join(homes[variant].root, `surface-${variant}-${index}.json`)
      if (!fs.existsSync(file)) continue
      surfaceDumps.push({ variant, dump: JSON.parse(fs.readFileSync(file, 'utf8')) })
    }
  }

  const result = {
    root,
    measured,
    installed: { name: installed.name, dir: installed.dir, manifest, bundle },
    risk,
    surface,
    turns,
    failure,
    dumps: surfaceDumps,
    samples,
    task,
    template,
  }
  if (!keep) {
    // Keep the evidence dumps' parsed content in the result; the trees are gone.
    removeTree(root)
    if (baselineRoot !== undefined) removeTree(baselineRoot)
    result.root = null
    result.measured = undefined
  }
  return result
}


