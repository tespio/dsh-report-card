/**
 * SVG report card.
 *
 * A self-contained graphic with no runtime dependency: it opens in any browser,
 * embeds in Markdown, and stays sharp at any size. It shows the same numbers as
 * the Markdown card — the point is a shape a person can read in two seconds,
 * not a different measurement.
 */

const COLORS = {
  bg: '#0b111c',
  panel: '#131c2b',
  stroke: '#223047',
  text: '#e7edf5',
  muted: '#8fa0b5',
  faint: '#5b6b80',
  accent: '#2dd4bf',
  grade: { A: '#22c55e', B: '#14b8a6', C: '#f59e0b', D: '#f97316', F: '#ef4444' },
  level: { high: '#f87171', medium: '#fbbf24', info: '#7dd3fc' },
}

const WIDTH = 1200
const HEIGHT = 900

/** XML-escape text for SVG. */
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Signed number, sensible precision. */
function signed(value, unit = '') {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded}${unit}`
}

/** Unsigned number. */
function plain(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '—'
}

/** Cut one line at a character budget with an ellipsis. */
function clip(text, budget) {
  const value = String(text ?? '')
  return value.length > budget ? `${value.slice(0, budget - 1)}…` : value
}

/** Wrap text at a character budget, at most `maxLines`, with an ellipsis. */
function wrap(text, perLine, maxLines) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  let index = 0
  let truncated = false
  while (index < words.length) {
    const word = words[index]
    const candidate = current === '' ? word : `${current} ${word}`
    if (candidate.length <= perLine || current === '') {
      current = candidate
      index += 1
      continue
    }
    if (lines.length === maxLines - 1) {
      truncated = true
      break
    }
    lines.push(current)
    current = ''
  }
  if (lines.length < maxLines && current !== '') lines.push(current)
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1]
    lines[lines.length - 1] = last.length < perLine - 1 ? `${last}…` : `${last.slice(0, perLine - 1)}…`
  }
  return lines.slice(0, maxLines)
}

/** One metric tile: label, value, sub-line, grade chip, and a threshold ruler. */
function tile({ x, y, width, label, value, sub, grade, graded, ladder }) {
  const color = COLORS.grade[grade] ?? COLORS.muted
  const parts = []
  parts.push(`<rect x="${x}" y="${y}" width="${width}" height="144" rx="16" fill="${COLORS.panel}" stroke="${COLORS.stroke}"/>`)
  parts.push(`<text x="${x + 20}" y="${y + 30}" class="label">${esc(label)}</text>`)
  parts.push(`<text x="${x + 20}" y="${y + 76}" class="value">${esc(value)}</text>`)
  parts.push(`<text x="${x + 20}" y="${y + 100}" class="sub">${esc(sub)}</text>`)
  parts.push(`<rect x="${x + width - 58}" y="${y + 18}" width="38" height="38" rx="11" fill="${color}22" stroke="${color}"/>`)
  parts.push(`<text x="${x + width - 39}" y="${y + 44}" text-anchor="middle" class="chip" fill="${color}">${esc(grade)}</text>`)

  const left = x + 20
  const right = x + width - 20
  const track = right - left
  if (Array.isArray(ladder) && ladder.length > 0) {
    const max = Math.max(ladder[ladder.length - 1].max, Math.abs(graded) || 1) * 1.15
    let cursor = left
    let previous = 0
    for (const rung of [...ladder, { grade: 'F', max }]) {
      const span = ((Math.min(rung.max, max) - previous) / max) * track
      if (span > 0) {
        parts.push(`<rect x="${cursor}" y="${y + 124}" width="${Math.max(span - 2, 1)}" height="5" rx="2.5" fill="${COLORS.grade[rung.grade] ?? COLORS.faint}" opacity="${rung.grade === 'F' ? 0.3 : 0.5}"/>`)
        cursor += span
      }
      previous = Math.min(rung.max, max)
    }
    const markerX = left + Math.min(Math.max(Number.isFinite(graded) ? graded : 0, 0) / max, 1) * track
    parts.push(`<path d="M${markerX - 6} ${y + 116} h12 l-6 7 z" fill="${COLORS.text}"/>`)
  }
  return parts.join('')
}

/** The risk tile replaces the ruler with three counters. */
function riskTile({ x, y, width, flags, grade }) {
  const color = COLORS.grade[grade] ?? COLORS.muted
  const counts = { high: 0, medium: 0, info: 0 }
  for (const flag of flags) counts[flag.level] = (counts[flag.level] ?? 0) + 1
  const parts = []
  parts.push(`<rect x="${x}" y="${y}" width="${width}" height="144" rx="16" fill="${COLORS.panel}" stroke="${COLORS.stroke}"/>`)
  parts.push(`<text x="${x + 20}" y="${y + 30}" class="label">RISK</text>`)
  parts.push(`<text x="${x + 20}" y="${y + 76}" class="value">${flags.length}</text>`)
  parts.push(`<text x="${x + 20}" y="${y + 100}" class="sub">static flag${flags.length === 1 ? '' : 's'}</text>`)
  parts.push(`<rect x="${x + width - 58}" y="${y + 18}" width="38" height="38" rx="11" fill="${color}22" stroke="${color}"/>`)
  parts.push(`<text x="${x + width - 39}" y="${y + 44}" text-anchor="middle" class="chip" fill="${color}">${esc(grade)}</text>`)
  let cursor = x + 20
  for (const level of ['high', 'medium', 'info']) {
    const count = counts[level] ?? 0
    if (count === 0) continue
    const label = `${count} ${level}`
    const chipWidth = label.length * 7 + 26
    parts.push(`<rect x="${cursor}" y="${y + 112}" width="${chipWidth}" height="20" rx="10" fill="${COLORS.level[level]}1c" stroke="${COLORS.level[level]}55"/>`)
    parts.push(`<circle cx="${cursor + 11}" cy="${y + 122}" r="3.5" fill="${COLORS.level[level]}"/>`)
    parts.push(`<text x="${cursor + 19}" y="${y + 126}" class="sub" fill="${COLORS.level[level]}">${esc(label)}</text>`)
    cursor += chipWidth + 8
  }
  return parts.join('')
}

/** A label/value line. */
function stat(x, y, label, value, color = COLORS.text) {
  return `<text x="${x}" y="${y}" class="statLabel">${esc(label)}</text>`
    + `<text x="${x + 200}" y="${y}" class="statValue" fill="${color}">${esc(value)}</text>`
}

/** The stacked context bar for baseline and subject. */
function contextPanel(report, x, y, width) {
  const context = report.measurements.context ?? {}
  const segments = [
    ['system', 'systemChars', '#60a5fa'],
    ['tools', 'toolsChars', '#2dd4bf'],
    ['conversation', 'messagesChars', '#a78bfa'],
  ]
  const bars = [
    ['baseline', context.modelVisibleChars?.baseline],
    ['subject', context.modelVisibleChars?.subject],
  ]
  const max = Math.max(...bars.map(([, value]) => (Number.isFinite(value) ? value : 0)), 1)
  const parts = []
  parts.push(`<text x="${x}" y="${y}" class="panelTitle">Context breakdown</text>`)
  bars.forEach(([variant, total], index) => {
    const row = y + 36 + index * 44
    parts.push(`<text x="${x}" y="${row + 4}" class="statLabel">${variant}</text>`)
    let cursor = x + 82
    const usable = width - 82 - 64
    for (const [, key, color] of segments) {
      const value = context[key]?.[variant]
      const span = ((Number.isFinite(value) ? value : 0) / max) * usable
      parts.push(`<rect x="${cursor}" y="${row - 9}" width="${Math.max(span - 2, 0)}" height="18" rx="5" fill="${color}" opacity="0.9"/>`)
      cursor += span
    }
    parts.push(`<text x="${x + width}" y="${row + 4}" text-anchor="end" class="statValue">${plain(total)}</text>`)
  })
  parts.push(`<text x="${x}" y="${y + 126}" class="sub">model-visible chars · tokens ${plain(context.heuristicTokens?.baseline)} → ${plain(context.heuristicTokens?.subject)} (<tspan fill="${COLORS.accent}">${signed(context.heuristicTokens?.delta, ' tok')}</tspan>)</text>`)
  parts.push(`<rect x="${x}" y="${y + 142}" width="10" height="10" rx="2" fill="#60a5fa"/><text x="${x + 16}" y="${y + 151}" class="sub">system</text>`)
  parts.push(`<rect x="${x + 78}" y="${y + 142}" width="10" height="10" rx="2" fill="#2dd4bf"/><text x="${x + 94}" y="${y + 151}" class="sub">tools</text>`)
  parts.push(`<rect x="${x + 148}" y="${y + 142}" width="10" height="10" rx="2" fill="#a78bfa"/><text x="${x + 164}" y="${y + 151}" class="sub">conversation</text>`)
  return parts.join('')
}

/** The risk panel: counters and the flags themselves. */
function riskPanel(report, x, y, width, height) {
  const flags = report.measurements.risk?.flags ?? []
  const counts = { high: 0, medium: 0, info: 0 }
  for (const flag of flags) counts[flag.level] = (counts[flag.level] ?? 0) + 1
  const parts = []
  parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" fill="${COLORS.panel}" stroke="${COLORS.stroke}"/>`)
  parts.push(`<text x="${x + 24}" y="${y + 34}" class="panelTitle">Static risk</text>`)
  let cx = x + width - 24
  for (const level of ['info', 'medium', 'high']) {
    const text = `${counts[level] ?? 0} ${level}`
    parts.push(`<text x="${cx}" y="${y + 34}" text-anchor="end" class="sub" fill="${COLORS.level[level]}">${esc(text)}</text>`)
    cx -= text.length * 8 + 24
  }
  const shown = flags.slice(0, 4)
  shown.forEach((flag, index) => {
    const line = y + 66 + index * 26
    parts.push(`<circle cx="${x + 30}" cy="${line - 5}" r="4" fill="${COLORS.level[flag.level]}"/>`)
    parts.push(`<text x="${x + 44}" y="${line}" class="flag">${esc(flag.id)}</text>`)
    parts.push(`<text x="${x + 232}" y="${line}" class="sub">${esc(clip(flag.detail, 56))}</text>`)
  })
  return parts.join('')
}

/** Capability chips: what the model is offered. */
function capabilityPanel(report, x, y, width) {
  const capability = report.measurements.capability ?? {}
  const parts = []
  parts.push(`<text x="${x}" y="${y}" class="panelTitle">Capability surface</text>`)
  const lines = []
  if (capability.available === true) {
    const tools = capability.tools?.added ?? []
    lines.push(`tools ${tools.length === 0 ? 'none' : tools.map((name) => `+ ${name}`).join(', ')}`)
    const listeners = Object.values(capability.hooksAdded ?? {}).reduce((total, value) => total + value, 0)
    lines.push(`sections ${capability.sectionsAdded?.length ?? 0} · listeners ${listeners} · entries ${capability.entriesAdded?.length ?? 0}`)
    lines.push(`profile ${capability.baselineEntryCount ?? '?'} → ${capability.subjectEntryCount ?? '?'}`)
  } else {
    lines.push(capability.reason ?? 'surface unavailable')
  }
  lines.slice(0, 3).forEach((line, index) => {
    parts.push(`<text x="${x}" y="${y + 26 + index * 22}" class="sub" fill="${COLORS.text}">${esc(clip(line, Math.floor(width / 7.2)))}</text>`)
  })
  return parts.join('')
}

/**
 * Render one report card as an SVG document.
 * @param report a card produced by `buildReport`
 */
export function renderSvg(report) {
  const grade = report.grades?.overall ?? 'F'
  const gradeColor = COLORS.grade[grade] ?? COLORS.muted
  const subject = report.subject ?? {}
  const measurements = report.measurements ?? {}
  const boot = measurements.bootCpu ?? {}
  const assembly = measurements.assembly ?? {}
  const context = measurements.context ?? {}
  const bootValue = Number.isFinite(boot.gradedDeltaMs) ? signed(boot.gradedDeltaMs, ' ms') : '—'
  const assemblyValue = Number.isFinite(assembly.gradedDeltaMs) ? signed(assembly.gradedDeltaMs, ' ms') : '—'
  const contextValue = Number.isFinite(context.heuristicTokens?.delta) ? signed(context.heuristicTokens.delta, ' tok') : '—'
  const riskFlags = measurements.risk?.flags ?? []
  const description = wrap(subject.description ?? '', 76, 3)
  const name = subject.name ?? 'unknown'
  const version = subject.version ?? '?'
  const digest = (report.digest ?? '').slice(0, 16)
  const stamp = (report.generatedAt ?? '').replace('T', ' ').replace(/\..*/, ' UTC')
  const machine = report.machine ?? {}
  const thresholds = report.method?.thresholds ?? {}

  const tiles = [
    {
      label: 'BOOT', value: bootValue, sub: `raw ${signed(boot.deltaMs, ' ms')} · floor ${signed(boot.noiseFloorMs, ' ms')}`,
      grade: report.grades?.boot ?? 'F', graded: boot.gradedDeltaMs, ladder: thresholds.bootCpu,
    },
    {
      label: 'PER-TURN', value: assemblyValue, sub: `assembly · raw ${signed(assembly.deltaMs, ' ms')}`,
      grade: report.grades?.turn ?? 'F', graded: assembly.gradedDeltaMs, ladder: thresholds.turn,
    },
    {
      label: 'CONTEXT', value: contextValue, sub: `${plain(context.heuristicTokens?.baseline)} → ${plain(context.heuristicTokens?.subject)} tok`,
      grade: report.grades?.context ?? 'F', graded: context.heuristicTokens?.delta, ladder: thresholds.context,
    },
  ]

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title desc">
  <title id="title">DSH report card: ${esc(name)}@${esc(version)} — grade ${esc(grade)}</title>
  <desc id="desc">Boot ${esc(bootValue)}, per-turn ${esc(assemblyValue)}, context ${esc(contextValue)}, ${riskFlags.length} static risk flags.</desc>
  <defs>
    <radialGradient id="glow" cx="18%" cy="0%" r="70%">
      <stop offset="0%" stop-color="${COLORS.accent}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="${COLORS.bg}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="100%" cy="100%" r="60%">
      <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${COLORS.bg}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0 H0 V40" fill="none" stroke="#ffffff" stroke-opacity="0.025"/>
    </pattern>
    <style>
      text { font-family: 'Segoe UI', 'Inter', system-ui, -apple-system, sans-serif; }
      .label { fill: ${COLORS.faint}; font-size: 12px; font-weight: 600; letter-spacing: 1.4px; }
      .value { fill: ${COLORS.text}; font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .sub { fill: ${COLORS.muted}; font-size: 12.5px; }
      .statLabel { fill: ${COLORS.muted}; font-size: 13px; }
      .statValue { fill: ${COLORS.text}; font-size: 13.5px; font-variant-numeric: tabular-nums; }
      .chip { font-size: 17px; font-weight: 700; }
      .panelTitle { fill: ${COLORS.text}; font-size: 15px; font-weight: 650; }
      .flag { fill: ${COLORS.text}; font-size: 13px; font-variant-numeric: tabular-nums; }
      .mono { font-family: 'Cascadia Code', 'JetBrains Mono', ui-monospace, monospace; }
    </style>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.bg}"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow2)"/>

  <text x="48" y="52" class="label">DSH REPORT CARD</text>
  <text x="${WIDTH - 48}" y="52" text-anchor="end" class="mono" fill="${COLORS.faint}" font-size="12">sha256:${esc(digest)}…</text>
  <line x1="48" y1="68" x2="${WIDTH - 48}" y2="68" stroke="${COLORS.stroke}"/>

  <rect x="48" y="94" width="150" height="150" rx="28" fill="${gradeColor}1a" stroke="${gradeColor}" stroke-width="2"/>
  <text x="123" y="204" text-anchor="middle" font-size="96" font-weight="800" fill="${gradeColor}">${esc(grade)}</text>
  <text x="123" y="230" text-anchor="middle" class="sub">overall</text>

  <text x="228" y="128" font-size="38" font-weight="750" fill="${COLORS.text}">${esc(name)}</text>
  <text x="${228 + Math.min(name.length * 21 + 14, 620)}" y="128" class="mono" fill="${COLORS.muted}" font-size="16">@${esc(version)}</text>
  ${description.map((line, index) => `<text x="228" y="${158 + index * 20}" class="sub" font-size="14">${esc(line)}</text>`).join('\n  ')}
  <text x="228" y="232" class="sub">${esc(machine.platform ?? '')} · ${esc(String(machine.cpuCount ?? '?'))} CPUs · dsh ${esc(machine.dshVersion ?? '?')} · ${esc(String(report.method?.samples ?? '?'))} samples</text>

  ${tiles.map((tileSpec, index) => tile({ ...tileSpec, x: 48 + index * 282, y: 262, width: 258 })).join('\n  ')}
  ${riskTile({ x: 48 + 3 * 282, y: 262, width: 258, flags: riskFlags, grade: report.grades?.risk ?? 'F' })}

  <text x="48" y="462" class="panelTitle">What it costs</text>
  <line x1="48" y1="478" x2="590" y2="478" stroke="${COLORS.stroke}"/>
  ${stat(48, 510, 'Boot CPU (median)', `${plain(boot.baselineMs)} → ${plain(boot.subjectMs)} ms`)}
  ${stat(48, 538, 'Launch (median)', `${plain(measurements.launch?.baselineMs)} → ${plain(measurements.launch?.subjectMs)} ms`)}
  ${stat(48, 566, 'Turn (median)', `${plain(measurements.turn?.baselineMs)} → ${plain(measurements.turn?.subjectMs)} ms`)}
  ${stat(48, 594, 'Assembly (median)', `${plain(assembly.baselineMs)} → ${plain(assembly.subjectMs)} ms`)}
  ${stat(48, 622, 'Context tokens', `${plain(context.heuristicTokens?.baseline)} → ${plain(context.heuristicTokens?.subject)} tok`, COLORS.accent)}
  ${stat(48, 650, 'Extension fields', `${plain(Object.values(context.extensionChars ?? {}).reduce((total, value) => total + value, 0))} chars (excluded)`)}
  <text x="48" y="690" class="sub">Boot and turn grades are noise-adjusted; wall time is reported, never graded.</text>
  <text x="48" y="712" class="sub">Measured in a throwaway profile · local fixture endpoint · no model calls.</text>

  ${capabilityPanel(report, 620, 462, 532)}
  ${contextPanel(report, 620, 566, 532)}

  ${riskPanel(report, 48, 744, 570, 150)}
  <rect x="640" y="744" width="512" height="150" rx="18" fill="${COLORS.panel}" stroke="${COLORS.stroke}"/>
  <text x="664" y="778" class="panelTitle">Verdict</text>
  <text x="664" y="808" class="sub" font-size="13.5">${esc(verdictLine(report))}</text>
  <text x="664" y="838" class="sub">${esc(stamp)} · ${esc(report.schema ?? '')}</text>
</svg>
`
}

/** One sentence that explains the overall grade. */
export function verdictLine(report) {
  const grades = report.grades ?? {}
  const risk = report.measurements?.risk?.flags ?? []
  if (grades.overall === 'F') {
    return report.health?.status === 'ok'
      ? 'A dimension graded F: the card could not settle a number.'
      : `Failed: ${report.health?.status ?? 'measurement failed'} — no running plugin to grade.`
  }
  if (grades.overall === grades.risk && risk.length > 0) {
    return `Performance is fine; the grade follows ${risk.length} static risk flag${risk.length === 1 ? '' : 's'}.`
  }
  if (grades.overall === 'A') return 'Cheap at boot and per turn, and no static flags.'
  return `Overall ${grades.overall}: the worst of boot, turn, context, and risk.`
}

/** `node harness/svg.mjs <card.json> [out.svg]` renders an existing card. */
if (import.meta.main) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const input = process.argv[2]
  if (input === undefined) {
    console.error('usage: node harness/svg.mjs <card.json> [out.svg]')
    process.exit(2)
  }
  const report = JSON.parse(fs.readFileSync(input, 'utf8'))
  const svg = renderSvg(report)
  const output = process.argv[3]
  if (output === undefined) process.stdout.write(svg)
  else {
    fs.writeFileSync(path.resolve(output), svg)
    console.log(`wrote ${path.resolve(output)} (${svg.length} bytes)`)
  }
}
