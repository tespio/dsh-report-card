/**
 * Markdown rendering. The Markdown is the report a person reads; the JSON is
 * the report a machine diffs. Both carry the same numbers.
 */

/** Compact signed number for tables. */
function signed(value, unit = '') {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded}${unit}`
}

/** Percentage with one decimal, or a dash. */
function pct(value) {
  return Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(1)}%` : '—'
}

/** A rounded count, or a dash when the number is unusable. */
function count(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '—'
}

/** One Markdown table from a header and rows. */
function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

/** A compact reading of one sample family. */
function sampleText(summary) {
  if (summary === undefined) return '—'
  const values = summary.samples.filter((value) => Number.isFinite(value))
  return values.length === 0 ? '—' : `${values.map((value) => Math.round(value)).join(' / ')} ms`
}

/** Render one report card as Markdown. */
export function renderMarkdown(report, { savedPaths, command } = {}) {
  const { measurements, grades, subject, machine, method } = report
  const lines = []
  const add = (line = '') => lines.push(line)

  add(`# Report card — ${subject.name}@${subject.version ?? '?'}`)
  add()
  add(
    `**Grade ${grades.overall}** · graded boot ${signed(measurements.bootCpu.gradedDeltaMs, ' ms CPU')}`
    + ` · graded turn ${signed(measurements.assembly.gradedDeltaMs, ' ms')}`
    + ` · context ${signed(measurements.context.heuristicTokens.delta, ' tok')}`
    + ` · risk ${grades.risk}`,
  )
  add()
  if (report.health?.status !== undefined && report.health.status !== 'ok') {
    const label = {
      'install-rejected': 'The runtime refused to install this package, so nothing was measured. See the note below for the exact gate.',
      'install-failed': 'The package could not be installed, so nothing was measured. See the note below for the error.',
      'boot-failed': 'The profile never reached the probe with this plugin installed.',
      'turn-failed': 'The plugin booted but the scripted turn did not complete.',
      'entry-failed': 'The plugin failed while activating and is not running: the numbers below describe the profile without it.',
      'entry-absent': 'No loader entry for the plugin appeared in the composed profile.',
    }[report.health.status] ?? report.health.status
    add(`**⚠ ${label}**`)
    add()
  }
  if (typeof subject.description === 'string' && subject.description !== '') {
    add(`> ${subject.description}`)
    add()
  }

  add('## At a glance')
  add()
  add(table(['Dimension', 'Baseline', 'Subject', 'Delta', 'Grade'], [
    ['Boot wall (process → plugin tree)', sampleText(measurements.boot.baseline), sampleText(measurements.boot.subject), signed(measurements.boot.deltaMs, ' ms'), '—'],
    ['Boot CPU (process at ready)', sampleText(measurements.bootCpu.baseline), sampleText(measurements.bootCpu.subject), signed(measurements.bootCpu.deltaMs, ' ms'), grades.boot],
    ['Turn (turn_start → turn_end)', sampleText(measurements.turn.baseline), sampleText(measurements.turn.subject), signed(measurements.turn.deltaMs, ' ms'), '—'],
    ['Assembly (step/start → request)', sampleText(measurements.assembly.baseline), sampleText(measurements.assembly.subject), signed(measurements.assembly.deltaMs, ' ms'), grades.turn],
    ['Step (prompt → model answered)', sampleText(measurements.step.baseline), sampleText(measurements.step.subject), signed(measurements.step.deltaMs, ' ms'), '—'],
    ['Context (model-visible tokens)', count(measurements.context.heuristicTokens.baseline), count(measurements.context.heuristicTokens.subject), signed(measurements.context.heuristicTokens.delta, ' tok'), grades.context],
    ['Static risk flags', '—', `${(measurements.risk.flags ?? []).length}`, '—', grades.risk],
  ]))
  add()
  add(`Samples: ${report.method.samples} per variant, medians shown. Boot jitter ${pct(report.noise.bootPct)}; step jitter ${pct(report.noise.turnPct)}.`)
  add()
  add(`Grades charge only overhead above this machine's noise floor: boot CPU ${signed(measurements.bootCpu.gradedDeltaMs, ' ms')} graded from ${signed(measurements.bootCpu.deltaMs, ' ms')} raw (floor ${signed(measurements.bootCpu.noiseFloorMs, ' ms')}), turn assembly ${signed(measurements.assembly.gradedDeltaMs, ' ms')} graded from ${signed(measurements.assembly.deltaMs, ' ms')} raw (floor ${signed(measurements.assembly.noiseFloorMs, ' ms')}). Wall time is reported but never graded: it is hostage to whatever else the machine is doing.`)
  add()

  add('## Boot')
  add()
  add(table(['Sample', 'Baseline', 'Subject'], measurements.boot.baseline.samples.map((value, index) => [
    String(index + 1),
    Number.isFinite(value) ? `${Math.round(value)} ms` : 'failed',
    Number.isFinite(measurements.boot.subject.samples[index]) ? `${Math.round(measurements.boot.subject.samples[index])} ms` : 'failed',
  ])))
  add()
  add(`Measured as ${method.timing.boot}. Deltas are round-paired medians (each subject run is paired with the baseline run before it), which cancels slow machine drift; the unpaired median difference was ${signed(measurements.boot.optionalMedians?.subjectMinusBaseline, ' ms')}. A negative delta means the subject booted sooner.`)
  add()
  add(`Launch (spawn → the same dump, including process startup): baseline ${count(measurements.launch.baselineMs)} ms, subject ${count(measurements.launch.subjectMs)} ms, delta ${signed(measurements.launch.deltaMs, ' ms')}.`)
  add()
  add(`Boot CPU (the graded figure, total process CPU when the plugin tree is ready): baseline ${count(measurements.bootCpu.baselineMs)} ms, subject ${count(measurements.bootCpu.subjectMs)} ms, delta ${signed(measurements.bootCpu.deltaMs, ' ms')} raw, ${signed(measurements.bootCpu.gradedDeltaMs, ' ms')} after the noise floor. CPU time moves only when the plugin actually does work, so it stays stable on a loaded machine.`)
  add()

  add('## One scripted turn')
  add()
  add(table(['Metric', 'Baseline', 'Subject', 'Delta'], [
    ['Turn', sampleText(measurements.turn.baseline), sampleText(measurements.turn.subject), signed(measurements.turn.deltaMs, ' ms')],
    ['Assembly (hook phase)', sampleText(measurements.assembly.baseline), sampleText(measurements.assembly.subject), signed(measurements.assembly.deltaMs, ' ms')],
    ['Step (whole)', sampleText(measurements.step.baseline), sampleText(measurements.step.subject), signed(measurements.step.deltaMs, ' ms')],
  ]))
  add()
  add(`Best-case assembly delta ${signed(measurements.assembly.bestCaseDeltaMs, ' ms')}; graded assembly delta ${signed(measurements.assembly.gradedDeltaMs, ' ms')} — the per-turn figure that sets the turn grade.`)
  add()
  add(`Measured as ${method.timing.step}, against ${method.isolation.model}.`)
  add()

  add('## Context tax')
  add()
  add(table(['Field', 'Baseline', 'Subject', 'Delta'], [
    ['Model-visible chars', count(measurements.context.modelVisibleChars.baseline), count(measurements.context.modelVisibleChars.subject), signed(measurements.context.modelVisibleChars.delta)],
    ['· system prompt', count(measurements.context.systemChars.baseline), count(measurements.context.systemChars.subject), signed(measurements.context.systemChars.delta)],
    ['· tool schemas', count(measurements.context.toolsChars.baseline), count(measurements.context.toolsChars.subject), signed(measurements.context.toolsChars.delta)],
    ['· conversation', count(measurements.context.messagesChars.baseline), count(measurements.context.messagesChars.subject), signed(measurements.context.messagesChars.delta)],
    ['Estimated tokens', count(measurements.context.heuristicTokens.baseline), count(measurements.context.heuristicTokens.subject), signed(measurements.context.heuristicTokens.delta)],
    ['Harness extension fields', count(measurements.context.extensionChars.baseline), count(measurements.context.extensionChars.subject), signed(measurements.context.extensionChars.delta)],
  ]))
  add()
  add(`Measured as ${method.timing.context}. Extension fields are request metadata the harness sends beside the model-visible prompt; they are listed separately and excluded from the token estimate.`)
  add()

  add('## Capability surface')
  add()
  const capability = measurements.capability
  if (capability.available !== true) {
    add(`Surface diff unavailable: ${capability.reason}.`)
  } else {
    add(table(['Added', 'Detail'], [
      ['Tools', capability.tools.added.length === 0 ? 'none' : capability.tools.added.map((name) => `\`${name}\` (${capability.tools.addedSchemaChars[name] ?? 0} schema chars)`).join(', ')],
      ['Prompt sections', capability.sectionsAdded.length === 0 ? 'none' : capability.sectionsAdded.map((section) => `\`${section.name}\` (${section.chars} chars)`).join(', ')],
      ['Event listeners', Object.keys(capability.hooksAdded).length === 0 ? 'none' : Object.entries(capability.hooksAdded).map(([event, count]) => `\`${event}\` +${count}`).join(', ')],
      ['Loader entries', capability.entriesAdded.length === 0 ? 'none' : capability.entriesAdded.map((name) => `\`${name}\``).join(', ')],
      ['Subject entry phase', report.health?.subjectEntryPhase ?? '—'],
      ['Prompt variables', capability.variablesAdded.length === 0 ? 'none' : capability.variablesAdded.map((name) => `\`${name}\``).join(', ')],
      ['Profile size', `${capability.baselineEntryCount} → ${capability.subjectEntryCount} entries`],
    ]))
    if (capability.sectionsChanged.length > 0) {
      add()
      add(`Changed existing sections: ${capability.sectionsChanged.map((section) => `\`${section.name}\` ${signed(section.delta)} chars`).join(', ')}.`)
    }
  }
  add()

  add('## Static risk flags')
  add()
  const flags = measurements.risk.flags ?? []
  if (flags.length === 0) {
    add('No flags: the package declares no install scripts, ships no binaries, and its sources reference no network host, subprocess, or file write.')
  } else {
    add(table(['Level', 'Flag', 'Detail'], flags.map((flag) => [
      flag.level,
      `\`${flag.id}\``,
      flag.detail,
    ])))
    const evidence = flags.filter((flag) => (flag.evidence ?? []).length > 0)
    if (evidence.length > 0) {
      add()
      add('Evidence:')
      for (const flag of evidence) {
        for (const item of flag.evidence) add(`- \`${flag.id}\` — ${item.file}: \`${item.line}\``)
      }
    }
  }
  add()

  if (report.notes.length > 0) {
    add('## Notes')
    add()
    for (const note of report.notes) add(`- ${note}`)
    add()
  }

  add('## Method and limits')
  add()
  add(`Measured on ${machine.platform}, ${machine.cpuCount} CPUs, dsh ${machine.dshVersion ?? '(unknown)'}, Node ${machine.node}.`)
  add()
  add(`- Profile: \`${method.template}\` template, ${method.isolation.profile}, ${method.isolation.home}.`)
  add(`- Isolation: ${method.isolation.cwd}, ${method.isolation.permissionMode} file policy; the subject never touches your real profile.`)
  add('- The subject still runs with your user privileges inside that disposable process. Read the risk flags before installing anything you did not write.')
  add('- Numbers are comparable only on the same machine identity; the digest changes whenever any number does.')
  add()
  if (typeof report.drift === 'object' && report.drift !== null) {
    add('## Drift since the previous card')
    add()
    add(`Previous card: ${report.drift.comparedTo}.`)
    add(table(['Metric', 'Previous', 'Now', 'Change'], [
      ['Boot delta', signed(report.drift.previousBootDeltaMs, ' ms'), signed(measurements.boot.deltaMs, ' ms'), signed(report.drift.bootDeltaMs, ' ms')],
      ['Step delta', signed(report.drift.previousStepDeltaMs, ' ms'), signed(measurements.step.deltaMs, ' ms'), signed(report.drift.stepDeltaMs, ' ms')],
      ['Context delta', signed(report.drift.previousContextDelta, ' tok'), signed(measurements.context.heuristicTokens.delta, ' tok'), signed(report.drift.contextDelta, ' tok')],
    ]))
    add()
  }

  add('## Reproduce')
  add()
  add('```')
  add(command ?? 'node harness/cli.mjs <plugin-spec>')
  add('```')
  add()
  if (savedPaths) {
    add(`Saved: \`${savedPaths.json}\` · \`${savedPaths.markdown}\``)
    add()
  }
  add(`Digest: \`sha256:${report.digest}\``)
  add()
  add(`Generated ${report.generatedAt} by \`dsh-report-card\` (${report.schema}).`)

  return `${lines.join('\n')}\n`
}

