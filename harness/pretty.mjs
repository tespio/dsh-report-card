/**
 * Terminal report card.
 *
 * The desktop gets the SVG graphic; a terminal gets this: the same numbers in
 * box drawing, colour, and block bars. Colour is opt-out (`--no-color`) and
 * auto-off when the stream is redirected, so pipes and logs stay clean.
 */

const WIDTH = 100

const LEVEL = { high: '31', medium: '33', info: '36' }
const GRADE_COLOR = { A: '32', B: '36', C: '33', D: '38;5;208', F: '31' }
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  inverse: '\u001b[7m',
}

/** Wrap a string in one ANSI style when colour is on. */
function paint(text, code, color) {
  if (!color || !code) return text
  return `\u001b[${code}m${text}${ANSI.reset}`
}

/** Signed number with unit. */
function signed(value, unit = '') {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded}${unit}`
}

/** Unsigned integer. */
function plain(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '—'
}

/** Visible length, ignoring ANSI escapes. */
function visible(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*m/g, '').length
}

/** Pad to a visible width. */
function pad(text, width, align = 'left') {
  const gap = Math.max(0, width - visible(text))
  if (align === 'right') return `${' '.repeat(gap)}${text}`
  return `${text}${' '.repeat(gap)}`
}

/** A horizontal bar of `filled` cells inside `cells`, with a threshold marker. */
function bar(filled, cells, color, grade) {
  const safe = Math.max(0, Math.min(cells, Math.round(filled)))
  const glyph = '█'
  const empty = '░'
  if (!color) return `${glyph.repeat(safe)}${empty.repeat(cells - safe)}`
  return `${paint(glyph.repeat(safe), GRADE_COLOR[grade] ?? '37', true)}${paint(empty.repeat(cells - safe), '90', true)}`
}

/** One boxed body line. */
function line(text, color) {
  const inner = WIDTH - 4
  return `${paint('│', '90', color)} ${pad(text, inner)} ${paint('│', '90', color)}`
}

/** A separator line. */
function rule(color, left = '├', right = '┤') {
  return paint(`${left}${'─'.repeat(WIDTH - 2)}${right}`, '90', color)
}

/** A metric row: label, value, grade, bar, note. */
function metricRow(label, value, grade, percent, note, color) {
  const labelCell = pad(label, 12)
  const valueCell = pad(value, 10, 'right')
  const chip = paint(` ${grade} `, GRADE_COLOR[grade] ?? '37', color)
  const graph = bar(percent, 24, color, grade)
  return `${labelCell}${valueCell}  ${chip}  ${graph}  ${paint(note, '90', color)}`
}

/**
 * Render one report card for a terminal.
 * @param report a card produced by `buildReport`
 * @param options `{ color }`
 */
export function renderPretty(report, { color = false } = {}) {
  const measurements = report.measurements ?? {}
  const subject = report.subject ?? {}
  const machine = report.machine ?? {}
  const boot = measurements.bootCpu ?? {}
  const assembly = measurements.assembly ?? {}
  const context = measurements.context ?? {}
  const flags = measurements.risk?.flags ?? []
  const grades = report.grades ?? {}
  const grade = grades.overall ?? 'F'
  const capability = measurements.capability ?? {}
  const thresholds = report.method?.thresholds ?? {}
  const bootLadder = thresholds.bootCpu ?? [{ max: 250 }]
  const assemblyLadder = thresholds.turn ?? [{ max: 200 }]
  const contextLadder = thresholds.context ?? [{ max: 8000 }]
  const out = []
  const edge = `${paint('┌', '90', color)}${paint('─'.repeat(WIDTH - 2), '90', color)}${paint('┐', '90', color)}`
  const bottom = `${paint('└', '90', color)}${paint('─'.repeat(WIDTH - 2), '90', color)}${paint('┘', '90', color)}`
  const last = bootLadder[bootLadder.length - 1]?.max ?? 250
  const lastAssembly = assemblyLadder[assemblyLadder.length - 1]?.max ?? 200
  const lastContext = contextLadder[contextLadder.length - 1]?.max ?? 8000

  out.push(edge)
  const headerLeft = `${paint('DSH REPORT CARD', '1', color)}  ${paint(`${subject.name ?? '?'}@${subject.version ?? '?'}`, '1;97', color)}`
  const headerRight = paint(`sha256:${(report.digest ?? '').slice(0, 12)}…`, '90', color)
  out.push(line(`${headerLeft}${' '.repeat(Math.max(1, WIDTH - 4 - visible(headerLeft) - visible(headerRight)))}${headerRight}`, color))
  out.push(rule(color))

  const badge = [
    '┌─────┐',
    `│  ${grade}  │`,
    '└─────┘',
  ]
  const summary = [
    `${paint(`GRADE ${grade}`, GRADE_COLOR[grade] ?? '37', color)}  ${report.measurements?.risk?.flags?.length > 0 && grades.overall === grades.risk ? paint('performance is fine; risk drives the grade', '2', color) : paint(verdict(report), '2', color)}`,
    `boot ${paint(signed(boot.gradedDeltaMs, ' ms'), '1', color)}   turn ${paint(signed(assembly.gradedDeltaMs, ' ms'), '1', color)}   context ${paint(signed(context.heuristicTokens?.delta, ' tok'), '1', color)}   risk ${paint(String(flags.length), '1', color)} flag${flags.length === 1 ? '' : 's'}`,
    paint(`${machine.platform ?? '?'} · ${machine.cpuCount ?? '?'} CPUs · dsh ${machine.dshVersion ?? '?'} · ${report.method?.samples ?? '?'} samples`, '90', color),
  ]
  for (let index = 0; index < 3; index += 1) {
    const left = badge[index] ?? '       '
    const text = summary[index] ?? ''
    out.push(line(`${paint(left, GRADE_COLOR[grade] ?? '37', color)}  ${text}`, color))
  }

  out.push(line('', color))
  out.push(line(paint('WHAT IT COSTS', '1', color), color))
  out.push(line(metricRow('boot', signed(boot.gradedDeltaMs, ' ms'), grades.boot ?? 'F', (Math.max(0, boot.gradedDeltaMs ?? 0) / last) * 100, `raw ${signed(boot.deltaMs, ' ms')} · floor ${signed(boot.noiseFloorMs, ' ms')}`, color), color))
  out.push(line(metricRow('per-turn', signed(assembly.gradedDeltaMs, ' ms'), grades.turn ?? 'F', (Math.max(0, assembly.gradedDeltaMs ?? 0) / lastAssembly) * 100, `assembly · raw ${signed(assembly.deltaMs, ' ms')}`, color), color))
  out.push(line(metricRow('context', signed(context.heuristicTokens?.delta, ' tok'), grades.context ?? 'F', (Math.max(0, context.heuristicTokens?.delta ?? 0) / lastContext) * 100, `${plain(context.heuristicTokens?.baseline)} → ${plain(context.heuristicTokens?.subject)} tok`, color), color))
  out.push(line(metricRow('risk', String(flags.length), grades.risk ?? 'F', (flags.length / 8) * 100, flags.length === 0 ? 'no static flags' : `${flags.filter((flag) => flag.level === 'high').length} high · ${flags.filter((flag) => flag.level === 'medium').length} medium · ${flags.filter((flag) => flag.level === 'info').length} info`, color), color))

  out.push(rule(color))
  out.push(line(paint('CONTEXT', '1', color), color))
  const bars = [
    ['baseline', context.modelVisibleChars?.baseline],
    ['subject', context.modelVisibleChars?.subject],
  ]
  const maxChars = Math.max(...bars.map(([, value]) => (Number.isFinite(value) ? value : 0)), 1)
  for (const [variant, total] of bars) {
    const cells = Math.round(((Number.isFinite(total) ? total : 0) / maxChars) * 52)
    const graph = color
      ? `${paint('█'.repeat(cells), '36', true)}${paint('░'.repeat(Math.max(0, 52 - cells)), '90', true)}`
      : `${'█'.repeat(cells)}${'░'.repeat(Math.max(0, 52 - cells))}`
    out.push(line(`${pad(variant, 10)}${graph}  ${pad(plain(total), 8, 'right')} chars`, color))
  }
  out.push(line(paint(`tokens ${plain(context.heuristicTokens?.baseline)} → ${plain(context.heuristicTokens?.subject)} (${signed(context.heuristicTokens?.delta, ' tok')}) · system ${plain(context.systemChars?.subject)} · tools ${plain(context.toolsChars?.subject)} · conversation ${plain(context.messagesChars?.subject)}`, '90', color), color))

  out.push(rule(color))
  out.push(line(paint('CAPABILITY', '1', color), color))
  if (capability.available === true) {
    const tools = capability.tools?.added ?? []
    out.push(line(`tools ${tools.length === 0 ? 'none' : tools.map((name) => `+ ${name}`).join(', ')}`, color))
    const listeners = Object.values(capability.hooksAdded ?? {}).reduce((total, value) => total + value, 0)
    out.push(line(`sections ${capability.sectionsAdded?.length ?? 0} · listeners ${listeners} · entries ${capability.entriesAdded?.length ?? 0} · profile ${capability.baselineEntryCount ?? '?'} → ${capability.subjectEntryCount ?? '?'} entries`, color))
  } else {
    out.push(line(paint(capability.reason ?? 'surface unavailable', '90', color), color))
  }

  out.push(rule(color))
  out.push(line(paint('STATIC RISK', '1', color), color))
  if (flags.length === 0) out.push(line(paint('none: no install scripts, binaries, network hosts, subprocesses or writes in the package sources', '90', color), color))
  for (const flag of flags.slice(0, 6)) {
    const dot = paint('●', LEVEL[flag.level] ?? '37', color)
    out.push(line(`${dot} ${pad(flag.id, 20)} ${paint(flag.detail.slice(0, WIDTH - 32), '90', color)}`, color))
  }

  out.push(rule(color))
  const stamp = (report.generatedAt ?? '').replace('T', ' ').replace(/\..*/, ' UTC')
  out.push(line(paint(`${stamp} · ${report.schema ?? ''} · measured in a throwaway profile, no model calls`, '90', color), color))
  out.push(bottom)
  return `${out.join('\n')}\n`
}

/** One sentence explaining the overall grade. */
function verdict(report) {
  const grades = report.grades ?? {}
  const risk = report.measurements?.risk?.flags ?? []
  if (grades.overall === 'F') return 'the card could not settle a number'
  if (grades.overall === grades.risk && risk.length > 0) return `the grade follows ${risk.length} static risk flag${risk.length === 1 ? '' : 's'}`
  if (grades.overall === 'A') return 'cheap at boot and per turn, no static flags'
  return `worst of boot, turn, context and risk`
}
