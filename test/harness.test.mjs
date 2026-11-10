/**
 * End-to-end harness tests against a fake plugin.
 *
 * Each run boots real harness processes in a throwaway profile against the
 * local fixture endpoint. That is the point of the tool, so the test pays the
 * same cost a user does — with one sample per variant.
 *
 *   node test/harness.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectRuntime } from '../harness/environment.mjs'
import { generateReport, runtimeVersion } from '../harness/generate.mjs'
import { digestReport, gradeFor, THRESHOLDS } from '../harness/report.mjs'

const here = import.meta.dirname
const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'))
let passed = 0
let failed = 0
let firstCard

async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${String(error?.stack ?? error).split('\n').slice(0, 6).join('\n     ')}`)
  }
}

let runtime
try {
  runtime = detectRuntime()
} catch (error) {
  console.log(`SKIP: no dsh runtime on this machine (${error.message})`)
  process.exit(0)
}
if (runtime.version === undefined) runtime.version = await runtimeVersion(runtime)

await test('a fake plugin gets a complete, measured card', async () => {
  const result = await generateReport({
    spec: path.join(here, 'fixtures', 'fake-plugin'),
    samples: 1,
    save: true,
    outDir: reportsDir,
    runtime,
    log: () => {},
  })
  firstCard = result.report
  const report = result.report
  assert.equal(report.schema, 'dsh-report-card/1')
  assert.equal(report.subject.name, '@local/rc-fake-plugin')
  assert.equal(report.health.status, 'ok')
  assert.equal(report.subject.kind, 'plugin')

  // Boot: two finite readings and a paired delta.
  assert.ok(Number.isFinite(report.measurements.boot.baselineMs), 'baseline boot must be a number')
  assert.ok(Number.isFinite(report.measurements.boot.subjectMs), 'subject boot must be a number')
  assert.ok(report.measurements.boot.subjectMs > 500, 'a real boot takes hundreds of ms')
  assert.equal(report.measurements.boot.pairedDeltas.length, 1)

  // The scripted turn completed against the fixture endpoint.
  assert.equal(report.evidence.turnFailures.length, 0)
  assert.ok(report.measurements.turn.subjectMs > 0)

  // Context tax came from the captured request.
  assert.ok(report.measurements.context.modelVisibleChars.baseline > 1000)
  assert.ok(report.measurements.context.toolsChars.baseline > 1000)

  // Capability surface: exactly what the fake plugin contributes.
  assert.deepEqual(report.measurements.capability.tools.added, ['fixture_echo'])
  assert.equal(report.measurements.capability.sectionsAdded.length, 1)
  assert.equal(report.measurements.capability.sectionsAdded[0].name, 'tool:fixture_echo')
  assert.ok(report.measurements.capability.hooksAdded['tools/pre-execute'] >= 1)
  assert.deepEqual(report.measurements.capability.entriesAdded, ['@local/rc-fake-plugin'])
  assert.equal(report.health.subjectEntryPhase, 'active')

  // Risk scan ran before the disposable tree was deleted.
  const flags = report.measurements.risk.flags.map((flag) => flag.id)
  assert.ok(flags.includes('install-scripts'))
  assert.ok(flags.includes('network-hosts'))

  // The card rendered, saved, and its digest verifies.
  assert.match(result.markdown, /## Capability surface/)
  assert.match(result.markdown, /fixture_echo/)
  assert.equal(report.digest, digestReport(report))
  // The fixture deliberately ships an install script and a network host, so the
  // risk dimension is D and the overall grade cannot beat it.
  assert.equal(report.grades.risk, 'D')
  assert.equal(report.grades.overall, 'D', `unexpected grade ${report.grades.overall}`)
  assert.ok(fs.existsSync(result.paths.json))
  assert.ok(fs.existsSync(result.paths.markdown))
})

await test('a plugin that fails to start is a failed card, not a crash', async () => {
  const result = await generateReport({
    spec: path.join(here, 'fixtures', 'hostile-plugin'),
    samples: 1,
    save: false,
    runtime,
    log: () => {},
  })
  const report = result.report
  assert.equal(report.health.status, 'entry-failed')
  assert.deepEqual(report.health.failedEntries, ['@local/rc-hostile-plugin'])
  assert.equal(report.grades.overall, 'F')
  assert.ok(report.notes.some((note) => note.includes('not running')))
  assert.match(result.markdown, /⚠/)
  // Its measurements still exist (they describe the profile without the plugin),
  // but the card is explicitly failed.
  assert.equal(gradeFor(report.measurements.step.deltaMs, THRESHOLDS.turn) !== 'F', true)
})

await test('a plugin that kills the host is a failed boot, bounded', async () => {
  const result = await generateReport({
    spec: path.join(here, 'fixtures', 'exit-plugin'),
    samples: 1,
    save: false,
    runtime,
    log: () => {},
  })
  assert.equal(result.report.health.status, 'boot-failed')
  assert.equal(result.report.grades.overall, 'F')
  assert.match(result.markdown, /never reached the probe/)
})

await test('the second card compares with the first one for drift', async () => {
  const second = await generateReport({
    spec: path.join(here, 'fixtures', 'fake-plugin'),
    samples: 1,
    save: true,
    outDir: reportsDir,
    runtime,
    log: () => {},
  })
  assert.ok(second.report.drift !== undefined, 'second card must carry drift')
  assert.equal(second.report.drift.comparedTo, firstCard.generatedAt)
  assert.notEqual(second.report.digest, firstCard.digest)
  assert.match(second.markdown, /Drift since the previous card/)
})

fs.rmSync(reportsDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
