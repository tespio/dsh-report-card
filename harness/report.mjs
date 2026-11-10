/**
 * Assemble one report card from a measurement.
 *
 * The report is data first and prose second: every headline number carries the
 * samples it came from, and the grade is derived from published thresholds, so
 * a reader can recompute it.
 */
import crypto from 'node:crypto'
import os from 'node:os'
import { diffSurface, lastDump } from './surface.mjs'
import { median, percent, spread } from './measure.mjs'
import { scanPackage, flagSummary } from './risk.mjs'

export const SCHEMA = 'dsh-report-card/1'

/** Published grade thresholds; the report carries a copy so it is self-describing. */
export const THRESHOLDS = {
  bootCpu: [
    { grade: 'A', max: 10 },
    { grade: 'B', max: 30 },
    { grade: 'C', max: 80 },
    { grade: 'D', max: 250 },
  ],
  boot: [
    { grade: 'A', max: 25 },
    { grade: 'B', max: 75 },
    { grade: 'C', max: 200 },
    { grade: 'D', max: 500 },
  ],
  turn: [
    { grade: 'A', max: 10 },
    { grade: 'B', max: 30 },
    { grade: 'C', max: 80 },
    { grade: 'D', max: 200 },
  ],
  context: [
    { grade: 'A', max: 100 },
    { grade: 'B', max: 500 },
    { grade: 'C', max: 2000 },
    { grade: 'D', max: 8000 },
  ],
}

/** Letter for one delta against its threshold ladder; F past the last rung. */
export function gradeFor(delta, ladder) {
  if (!Number.isFinite(delta)) return 'F'
  if (delta <= ladder[0].max) return ladder[0].grade
  for (const rung of ladder) if (delta <= rung.max) return rung.grade
  return 'F'
}

/** Grade a risk scan: clean, informational, medium, or high. */
export function gradeRisk(flags) {
  const summary = flagSummary(flags)
  if (summary.high > 0) return 'D'
  if (summary.medium > 0) return 'C'
  if (summary.info > 0) return 'B'
  return 'A'
}

/** The worse of two letter grades. */
function worst(left, right) {
  return left > right ? left : right
}

/** Stable stringify: sorted keys, so a digest does not depend on construction order. */
export function canonicalJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input !== null && typeof input === 'object') {
      const out = {}
      for (const key of Object.keys(input).sort()) out[key] = normalize(input[key])
      return out
    }
    return input
  }
  return JSON.stringify(normalize(value))
}

/** SHA-256 of the report without its own digest field. */
export function digestReport(report) {
  const { digest: _digest, ...rest } = report
  return crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

/** Median/spread summary of one sample family. */
function summary(values) {
  return { median: median(values), samples: values.map((value) => (Number.isFinite(value) ? value : null)), ...spread(values) }
}

/** Compare a metric across the two variants, pairing samples by round. */
function deltaOf(baselineValues, subjectValues) {
  const baselineMs = median(baselineValues)
  const subjectMs = median(subjectValues)
  const finiteBaseline = baselineValues.filter((value) => Number.isFinite(value))
  const finiteSubject = subjectValues.filter((value) => Number.isFinite(value))
  const bestBaseline = finiteBaseline.length > 0 ? Math.min(...finiteBaseline) : Number.NaN
  const bestSubject = finiteSubject.length > 0 ? Math.min(...finiteSubject) : Number.NaN
  const pairs = Math.min(baselineValues.length, subjectValues.length)
  const pairedDeltas = []
  for (let index = 0; index < pairs; index += 1) {
    const before = baselineValues[index]
    const after = subjectValues[index]
    if (Number.isFinite(before) && Number.isFinite(after)) pairedDeltas.push(after - before)
  }
  // Round-paired medians cancel slow machine drift that separate medians would
  // absorb into the delta; the unpaired medians stay in the report for display.
  const deltaMs = pairedDeltas.length > 0 ? median(pairedDeltas) : subjectMs - baselineMs
  // Best case pairs the fastest run of each variant. One-off stalls (a virus
  // scan, another build) inflate a median but never the minimum, so this is the
  // number a grade can trust when a machine is not quiet.
  const bestCaseDeltaMs = Number.isFinite(bestBaseline) && Number.isFinite(bestSubject)
    ? bestSubject - bestBaseline
    : Number.NaN
  // The grade charges only overhead that clears the machine's own noise: one
  // standard error of the paired differences. A plugin whose delta is inside
  // that uncertainty cannot earn a worse letter than a plugin that costs nothing.
  let noiseFloorMs = 0
  if (pairedDeltas.length >= 2) {
    const mean = pairedDeltas.reduce((total, value) => total + value, 0) / pairedDeltas.length
    const variance = pairedDeltas.reduce((total, value) => total + (value - mean) ** 2, 0) / (pairedDeltas.length - 1)
    noiseFloorMs = Math.sqrt(variance / pairedDeltas.length)
  }
  const gradedDeltaMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs - noiseFloorMs) : Number.NaN
  return {
    baselineMs,
    subjectMs,
    deltaMs,
    bestCaseDeltaMs,
    noiseFloorMs,
    gradedDeltaMs,
    optionalMedians: {
      subjectMinusBaseline: subjectMs - baselineMs,
    },
    deltaPct: percent(deltaMs, baselineMs),
    pairedDeltas,
    baseline: summary(baselineValues),
    subject: summary(subjectValues),
  }
}

/** Median token/char figure of the requests captured for one variant. */
function requestMedian(turns, variant, pick) {
  return median(turns[variant].map((sample) => pick(sample.prompt)).filter((value) => Number.isFinite(value)))
}

/** Context comparison from the captured request bodies. */
function contextMeasurement(turns) {
  const fields = ['modelVisibleChars', 'systemChars', 'toolsChars', 'messagesChars', 'heuristicTokens', 'extensionChars']
  const context = {}
  for (const field of fields) {
    const pick = field === 'extensionChars'
      ? (prompt) => Object.values(prompt?.extensionChars ?? {}).reduce((total, value) => total + value, 0)
      : (prompt) => prompt?.[field]
    const baseline = requestMedian(turns, 'baseline', pick)
    const subject = requestMedian(turns, 'subject', pick)
    context[field] = {
      baseline,
      subject,
      delta: subject - baseline,
      deltaPct: percent(subject - baseline, baseline),
    }
  }
  return context
}

/** Tool names the subject added to the model-visible request. */
function toolDelta(turns) {
  const names = (variant) => new Set(turns[variant].at(-1)?.prompt?.toolNames ?? [])
  const baseline = names('baseline')
  const subject = names('subject')
  const added = [...subject].filter((name) => !baseline.has(name)).sort()
  const schema = turns.subject.at(-1)?.prompt?.toolSchemaChars ?? {}
  const baselineSchema = turns.baseline.at(-1)?.prompt?.toolSchemaChars ?? {}
  const schemaChars = Object.fromEntries(
    added.map((name) => [name, (schema[name] ?? 0) - (baselineSchema[name] ?? 0)]),
  )
  return {
    baselineCount: baseline.size,
    subjectCount: subject.size,
    added,
    removed: [...baseline].filter((name) => !subject.has(name)).sort(),
    addedSchemaChars: schemaChars,
  }
}

/** Machine identity; reports are comparable only within one identity. */
function machineIdentity(runtime) {
  const cpus = os.cpus()
  return {
    kind: runtime.kind,
    dshVersion: runtime.version ?? null,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    electron: process.versions.electron ?? null,
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    hostname: os.hostname(),
  }
}

/**
 * Build the report object.
 * @param args measured result plus the subject spec and runtime
 */
export function buildReport({ measured, subject, runtime, samples, task, template, previous }) {
  const surfaceDiff = measured.failure?.kind === 'install'
    ? { available: false, reason: 'the runtime refused to install the package' }
    : diffSurface(lastDump(measured.dumps, 'baseline'), lastDump(measured.dumps, 'subject'))
  const risk = measured.risk ?? scanPackage(measured.installed.dir)
  const bootBaseline = measured.surface.baseline.map((sample) => sample.bootMs)
  const bootSubject = measured.surface.subject.map((sample) => sample.bootMs)
  const bootCpuBaseline = measured.surface.baseline.map((sample) => sample.bootCpuMs)
  const bootCpuSubject = measured.surface.subject.map((sample) => sample.bootCpuMs)
  const launchBaseline = measured.surface.baseline.map((sample) => sample.launchMs)
  const launchSubject = measured.surface.subject.map((sample) => sample.launchMs)
  const turnBaseline = measured.turns.baseline.map((sample) => sample.turnMs)
  const turnSubject = measured.turns.subject.map((sample) => sample.turnMs)
  const stepBaseline = measured.turns.baseline.map((sample) => sample.stepMs)
  const stepSubject = measured.turns.subject.map((sample) => sample.stepMs)
  const assemblyBaseline = measured.turns.baseline.map((sample) => sample.assemblyMs)
  const assemblySubject = measured.turns.subject.map((sample) => sample.assemblyMs)

  const boot = deltaOf(bootBaseline, bootSubject)
  const bootCpu = deltaOf(bootCpuBaseline, bootCpuSubject)
  const launch = deltaOf(launchBaseline, launchSubject)
  const turn = deltaOf(turnBaseline, turnSubject)
  const step = deltaOf(stepBaseline, stepSubject)
  const assembly = deltaOf(assemblyBaseline, assemblySubject)
  const context = contextMeasurement(measured.turns)
  const tools = toolDelta(measured.turns)

  const grades = {
    boot: gradeFor(bootCpu.gradedDeltaMs, THRESHOLDS.bootCpu),
    turn: gradeFor(assembly.gradedDeltaMs, THRESHOLDS.turn),
    context: gradeFor(context.heuristicTokens.delta, THRESHOLDS.context),
    risk: gradeRisk(risk.flags ?? []),
  }
  grades.overall = [grades.boot, grades.turn, grades.context, grades.risk].reduce(worst)

  // A plugin that failed while activating is not running, so its deltas describe
  // a profile without it: that is a failed card, never a passing one.
  const failedEntries = surfaceDiff.available === true ? (surfaceDiff.failedEntries ?? []) : []
  const subjectFailed = failedEntries.includes(measured.installed.name)
  const subjectAbsent = surfaceDiff.available === true
    && measured.installed.bundle !== true
    && (surfaceDiff.entriesAdded ?? []).length === 0
  const installMessage = measured.installed.rejected?.message ?? ''
  const installStatus = /incompatible|installation rejected|exemption/i.test(installMessage) ? 'install-rejected' : 'install-failed'
  const health = {
    status: measured.failure !== undefined
      ? ({
          install: installStatus,
          boot: 'boot-failed',
          turn: 'turn-failed',
        }[measured.failure.kind] ?? 'failed')
      : subjectFailed
        ? 'entry-failed'
        : subjectAbsent
          ? 'entry-absent'
          : 'ok',
    failedEntries,
    rejection: measured.installed.rejected ?? null,
    subjectEntryPhase: surfaceDiff.available === true
      ? (surfaceDiff.addedEntryRows ?? []).find((row) => row.name === measured.installed.name)?.phase ?? null
      : null,
  }
  if (health.status !== 'ok') grades.overall = 'F'

  const pairedNoise = (metric) => {
    const deltas = metric.pairedDeltas
    if (deltas.length < 2 || !Number.isFinite(metric.baselineMs) || metric.baselineMs === 0) return null
    return ((Math.max(...deltas) - Math.min(...deltas)) / metric.baselineMs) * 100
  }
  const noise = {
    bootPct: pairedNoise(boot),
    turnPct: pairedNoise(step),
  }

  const notes = []
  if (measured.failure?.kind === 'install') {
    const rejection = measured.installed.rejected
    notes.push(`The runtime could not install the package: ${rejection?.message ?? 'installation failed'}. Nothing was bypassed: no exemption was granted and no plugin code ran.`)
  }
  if (measured.failure?.kind === 'boot') notes.push('The subject did not reach the probe: the profile failed to boot with it installed.')
  if (measured.failure?.kind === 'turn') notes.push('The subject booted but the scripted turn did not complete.')
  if (health.status === 'entry-failed') {
    notes.push(`The subject's loader entry failed while activating (${failedEntries.join(', ')}): the plugin is not running, so every measured number describes the profile as if it were not installed.`)
  }
  if (health.status === 'entry-absent') {
    notes.push('No loader entry for the subject appeared in the composed profile; it may have been rejected before activation.')
  }
  if (noise.bootPct !== null && noise.bootPct > 5) notes.push(`Boot samples vary by ${noise.bootPct.toFixed(1)}% on this machine; treat deltas below that as noise.`)
  if (noise.turnPct !== null && noise.turnPct > 5) notes.push(`Step samples vary by ${noise.turnPct.toFixed(1)}%; treat deltas below that as noise.`)
  if (samples < 3) notes.push('Fewer than three samples were taken, so the noise floor cannot be estimated and the grades should be read as raw deltas.')
  if (measured.installed.bundle) notes.push('The subject is a bundle: it was composed through the profile bundle list, not an insert row.')
  if (risk.error) notes.push(`Static scan unavailable: ${risk.error}`)

  const subjectDump = lastDump(measured.dumps, 'subject')
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    measuredEnvironment: {
      home: subjectDump?.dshHome ?? null,
      cwd: subjectDump?.cwd ?? null,
    },
    subject: {
      spec: subject.spec,
      source: subject.kind === 'dir' ? 'local-directory' : 'npm',
      name: measured.installed.name,
      version: measured.installed.manifest.version ?? null,
      kind: measured.installed.bundle ? 'bundle' : 'plugin',
      license: measured.installed.manifest.license ?? null,
      description: measured.installed.manifest.description ?? null,
      dependencies: Object.keys(measured.installed.manifest.dependencies ?? {}).length,
    },
    method: {
      template,
      task,
      samples,
      timing: {
        boot: 'process start (performance.timeOrigin) to the probe writing its dump (plugin tree composed)',
        bootCpu: 'process CPU time (user + system) at the same dump — the composition cost itself, independent of what else the machine was doing',
        launch: 'process spawn to the same dump (includes OS process startup)',
        turn: 'turn_start to turn_end on one scripted turn',
        step: 'step_start to the first step_end on that turn',
        assembly: 'step/start (from the child session log) to the request reaching the fixture endpoint: prompt assembly and request serialization',
        context: 'model-visible bytes of the request the harness sent (system + tools + messages), tokens at 4 chars/token',
      },
      isolation: {
        home: 'fresh DSH_HOME per report',
        profile: 'fresh profile copied from a shipped template',
        cwd: 'empty workspace directory',
        model: 'local fixture endpoint, no network call',
        permissionMode: 'read-only',
      },
      thresholds: THRESHOLDS,
      gradeBasis: 'the boot grade uses the noise-adjusted CPU-cost delta (boot wall time is reported but not graded, because it is hostage to machine load); the turn grade uses the noise-adjusted assembly delta; context uses the exact request delta; risk uses the static flags. Noise adjustment is the round-paired median delta minus one standard error of the paired differences, floored at zero',
    },
    machine: machineIdentity(runtime),
    measurements: {
      boot,
      bootCpu,
      launch,
      turn,
      step,
      assembly,
      context,
      capability: { ...surfaceDiff, tools },
      risk,
    },
    grades,
    health,
    noise,
    notes,
    evidence: {
      surfaceFailures: measured.surface.subject.filter((sample) => !sample.ok).map((sample) => ({ index: sample.index, stderr: sample.stderr })),
      turnFailures: measured.turns.subject.filter((sample) => sample.exitCode !== 0 || !sample.completed).map((sample) => ({
        index: sample.index,
        exitCode: sample.exitCode,
        reason: sample.reason,
        stderr: sample.stderr,
      })),
      sampleCounts: {
        surface: { baseline: measured.surface.baseline.length, subject: measured.surface.subject.length },
        turn: { baseline: measured.turns.baseline.length, subject: measured.turns.subject.length },
      },
    },
  }
  report.digest = digestReport(report)
  if (previous !== undefined && previous !== null) {
    report.drift = driftFrom(previous, report)
    report.digest = digestReport(report)
  }
  return report
}

/** Compare this card with the previous card for the same subject. */
export function driftFrom(previous, report) {
  const change = (now, then) => (Number.isFinite(now) && Number.isFinite(then) ? now - then : Number.NaN)
  return {
    comparedTo: previous.generatedAt,
    previousDigest: previous.digest,
    bootDeltaMs: change(report.measurements.boot.deltaMs, previous.bootDeltaMs),
    previousBootDeltaMs: previous.bootDeltaMs,
    stepDeltaMs: change(report.measurements.step.deltaMs, previous.stepDeltaMs),
    previousStepDeltaMs: previous.stepDeltaMs,
    contextDelta: change(report.measurements.context.heuristicTokens.delta, previous.contextDelta),
    previousContextDelta: previous.contextDelta,
    gradeChange: `${previous.grade} → ${report.grades.overall}`,
  }
}
