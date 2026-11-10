/**
 * Report storage: one JSON + one Markdown per run, plus an index that keeps the
 * last card's numbers so the next run can show drift.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Where cards live: `DSH_REPORT_CARD_DIR`, else `<cwd>/report-cards`. */
export function resolveReportsDir({ cwd = process.cwd(), env = process.env } = {}) {
  return env.DSH_REPORT_CARD_DIR ?? path.join(cwd, 'report-cards')
}

/** Filesystem-safe slug for one subject. */
export function slugOf(report) {
  const raw = `${report.subject.name ?? 'unknown'}@${report.subject.version ?? '0.0.0'}`
  return raw.replace(/[^a-zA-Z0-9._@-]+/g, '-').replace(/@+/g, '@').replace(/^-|-$/g, '')
}

/** Timestamp for a file name, safe on every platform. */
export function stampOf(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Read the index, tolerating absence and hand-edited damage. */
export function readIndex(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
    if (Array.isArray(parsed.reports)) return parsed
  } catch {
    // A missing or damaged index is rebuilt from this run onward.
  }
  return { schema: 'dsh-report-card/index/1', reports: [] }
}

/** The newest indexed card for one slug. */
export function previousFor(index, slug) {
  return index.reports.filter((entry) => entry.slug === slug).at(-1)
}

/** The index row for a finished card. */
export function indexEntry(report, slug, auto = false) {
  return {
    slug,
    subject: `${report.subject.name}@${report.subject.version ?? '?'}`,
    generatedAt: report.generatedAt,
    digest: report.digest,
    grade: report.grades.overall,
    bootDeltaMs: report.measurements.boot.deltaMs,
    bootMs: report.measurements.boot.subjectMs,
    stepDeltaMs: report.measurements.step.deltaMs,
    contextDelta: report.measurements.context.heuristicTokens.delta,
    machine: `${report.machine.platform}/${report.machine.cpuCount}cpu`,
    ...(auto ? { pendingPresentation: true } : {}),
  }
}

/** Write the JSON, the Markdown, the SVG graphic, and the updated index. */
export function saveReport({ dir, report, markdown, svg, auto = false }) {
  const slug = slugOf(report)
  const stamp = stampOf(new Date(report.generatedAt))
  const folder = path.join(dir, slug)
  fs.mkdirSync(folder, { recursive: true })
  const json = path.join(folder, `${stamp}.json`)
  const md = path.join(folder, `${stamp}.md`)
  const graphic = path.join(folder, `${stamp}.svg`)
  fs.writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(md, markdown)
  if (typeof svg === 'string' && svg !== '') fs.writeFileSync(graphic, svg)

  const index = readIndex(dir)
  index.reports.push({
    ...indexEntry(report, slug, auto),
    json,
    markdown: md,
    ...(typeof svg === 'string' && svg !== '' ? { svg: graphic } : {}),
  })
  if (index.reports.length > 200) index.reports = index.reports.slice(-200)
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
  return { json, markdown: md, ...(typeof svg === 'string' && svg !== '' ? { svg: graphic } : {}), slug }
}

/**
 * Take the cards waiting to be shown to the user, once.
 *
 * The flag is cleared as the cards are read, so a restart, a second session, or
 * a repeated assembly cannot announce the same install twice.
 */
export function takePending(dir, limit = 3) {
  const index = readIndex(dir)
  const pending = index.reports.filter((entry) => entry.pendingPresentation === true)
  if (pending.length === 0) return []
  for (const entry of pending) delete entry.pendingPresentation
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
  return pending.slice(-limit)
}
