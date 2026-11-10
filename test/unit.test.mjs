/**
 * Unit tests for the report-card harness: pure measurement math, the request
 * describer, the surface diff, the risk scanner, the fixture endpoint, and
 * report storage. No harness boot happens here — `harness.test.mjs` does that.
 *
 *   node test/unit.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { heuristicTokens, startMockLlm } from '../harness/mock-llm.mjs'
import { describeRequest, describeRun, median, percent, spread } from '../harness/measure.mjs'
import { diffSurface } from '../harness/surface.mjs'
import { scanPackage, flagSummary } from '../harness/risk.mjs'
import { canonicalJson, digestReport, gradeFor, gradeRisk, THRESHOLDS } from '../harness/report.mjs'
import { renderMarkdown } from '../harness/render.mjs'
import { previousFor, readIndex, saveReport, slugOf } from '../harness/store.mjs'

const root = path.join(import.meta.dirname, 'fixtures')
let passed = 0
let failed = 0

/** Run one named test, print its result, and keep going after a failure. */
async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n     ')}`)
  }
}

await test('heuristic tokens use four characters per token', () => {
  assert.equal(heuristicTokens(''), 0)
  assert.equal(heuristicTokens('abcd'), 1)
  assert.equal(heuristicTokens('abcde'), 2)
})

await test('median, spread and percent tolerate missing samples', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.ok(Number.isNaN(median([Number.NaN])))
  assert.deepEqual(spread([5, 1, 9]), { min: 1, max: 9 })
  assert.equal(percent(5, 100), 5)
  assert.equal(percent(1, 0), null)
})

await test('describeRequest prices the model-visible prompt only', () => {
  const body = {
    model: 'deepseek-flash',
    stream: true,
    system: 'abc',
    tools: [{ name: 'b', description: 'x' }, { name: 'a', description: 'y' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    dsh_session_log: '{"events":[]}',
    dsh_plugin_packages: '{"packages":[]}',
  }
  const described = describeRequest(body)
  assert.equal(described.model, 'deepseek-flash')
  assert.equal(described.systemChars, 3)
  assert.deepEqual(described.toolNames, ['a', 'b'])
  assert.equal(described.messageCount, 1)
  assert.equal(described.extensionChars.dsh_session_log, JSON.stringify(body.dsh_session_log).length)
  assert.equal(described.modelVisibleChars, 3 + JSON.stringify(body.tools).length + JSON.stringify(body.messages).length)
  assert.equal(described.heuristicTokens, Math.ceil(described.modelVisibleChars / 4))
})

await test('describeRequest accepts a block-form system prompt', () => {
  const described = describeRequest({ system: [{ type: 'text', text: 'hello' }], tools: [], messages: [] })
  assert.equal(described.systemChars, 5)
})

await test('describeRun reads boot, turn and step from the event stream', () => {
  const startedAt = 1000
  const line = (at, event) => ({ at, line: JSON.stringify(event) })
  const run = {
    startedAt,
    endedAt: 3000,
    code: 0,
    stdout: '',
    stderr: '',
    lines: [
      line(2400, { type: 'session', sessionId: 's' }),
      line(2500, { type: 'status', phase: 'turn_start', turn: 1 }),
      line(2600, { type: 'status', phase: 'step_start', turn: 1, step: 1 }),
      line(2650, { type: 'status', phase: 'step_end', turn: 1, step: 1 }),
      line(2700, { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }),
      line(2710, { type: 'final', sessionId: 's', reason: { kind: 'completed' }, text: 'OK' }),
    ],
  }
  const parsed = run.lines.map((entry) => ({ at: entry.at, event: JSON.parse(entry.line) }))
  const described = describeRun(run, parsed)
  assert.equal(described.bootMs, 1400)
  assert.equal(described.turnMs, 200)
  assert.equal(described.stepMs, 50)
  assert.equal(described.completed, true)
})

await test('diffSurface reports what the subject added', () => {
  const baseline = {
    tools: [{ name: 'read' }],
    prompt: { sections: [{ name: 'harness:identity', chars: 10 }], sectionChars: 10, variableNames: [] },
    hooks: { 'tools/pre-execute': 1 },
    hookOwners: { 'tools/pre-execute': ['core'] },
    entries: [{ id: 'a', name: 'core', phase: 'active' }],
  }
  const subject = {
    tools: [{ name: 'read' }, { name: 'fixture_echo' }],
    prompt: {
      sections: [{ name: 'harness:identity', chars: 10 }, { name: 'tool:fixture_echo', chars: 66 }],
      sectionChars: 76,
      variableNames: [],
    },
    hooks: { 'tools/pre-execute': 2 },
    hookOwners: { 'tools/pre-execute': ['core', 'fixture'] },
    entries: [{ id: 'a', name: 'core', phase: 'active' }, { id: 'b', name: 'fixture', phase: 'failed' }],
  }
  const diff = diffSurface(baseline, subject)
  assert.equal(diff.available, true)
  assert.deepEqual(diff.toolsAdded, ['fixture_echo'])
  assert.deepEqual(diff.sectionsAdded, [{ name: 'tool:fixture_echo', chars: 66 }])
  assert.deepEqual(diff.hooksAdded, { 'tools/pre-execute': 1 })
  assert.deepEqual(diff.hookOwners['tools/pre-execute'], ['fixture'])
  assert.deepEqual(diff.entriesAdded, ['fixture'])
  assert.deepEqual(diff.failedEntries, ['fixture'])
  assert.equal(diff.promptChars.delta, 66)
})

await test('diffSurface fails closed when a dump is missing', () => {
  const diff = diffSurface(undefined, { tools: [] })
  assert.equal(diff.available, false)
  assert.match(diff.reason, /baseline/)
})

await test('the static scan flags a package without running it', () => {
  const scan = scanPackage(path.join(root, 'fake-plugin'))
  const ids = scan.flags.map((flag) => flag.id)
  assert.ok(ids.includes('install-scripts'), `expected install-scripts in ${ids}`)
  assert.ok(ids.includes('network-hosts'), `expected network-hosts in ${ids}`)
  assert.ok(ids.includes('file-write'), `expected file-write in ${ids}`)
  assert.ok(scan.hosts.includes('collector.example.test'))
  assert.equal(scan.installScripts[0].script, 'postinstall')
  assert.equal(flagSummary(scan.flags).high >= 1, true)
})

await test('grades follow the published ladders', () => {
  assert.equal(gradeFor(10, THRESHOLDS.boot), 'A')
  assert.equal(gradeFor(50, THRESHOLDS.boot), 'B')
  assert.equal(gradeFor(900, THRESHOLDS.boot), 'F')
  assert.equal(gradeFor(Number.NaN, THRESHOLDS.boot), 'F')
  assert.equal(gradeRisk([]), 'A')
  assert.equal(gradeRisk([{ level: 'info' }]), 'B')
  assert.equal(gradeRisk([{ level: 'medium' }]), 'C')
  assert.equal(gradeRisk([{ level: 'high' }]), 'D')
})

await test('canonical JSON and the digest are stable and sensitive', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  const report = { schema: 'x', measurements: { boot: { deltaMs: 1 } } }
  const first = digestReport(report)
  assert.equal(first, digestReport({ ...report }))
  assert.notEqual(first, digestReport({ ...report, measurements: { boot: { deltaMs: 2 } } }))
})

await test('the fixture endpoint answers a Messages request with a valid stream', async () => {
  const mock = await startMockLlm({ reply: 'OK' })
  try {
    const response = await fetch(`${mock.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [], tools: [] }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    const types = text.split('\n\n').filter((frame) => frame.trim() !== '').map((frame) => {
      const data = frame.split('\n').find((line) => line.startsWith('data: '))
      return JSON.parse(data.slice(6)).type
    })
    assert.deepEqual(types, [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    assert.equal(mock.requests.length, 1)
    assert.equal(mock.requests[0].body.model, 'deepseek-flash')
  } finally {
    await mock.close()
  }
})

await test('Markdown rendering and storage round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-unit-'))
  try {
    const report = fakeReport()
    const markdown = renderMarkdown(report, { command: 'node harness/cli.mjs x' })
    assert.match(markdown, /# Report card/)
    assert.match(markdown, /## Context tax/)
    assert.match(markdown, /## Static risk flags/)
    assert.match(markdown, new RegExp(report.digest))
    const saved = saveReport({ dir, report, markdown })
    assert.ok(fs.existsSync(saved.json))
    assert.ok(fs.existsSync(saved.markdown))
    const index = readIndex(dir)
    assert.equal(index.reports.length, 1)
    assert.equal(previousFor(index, slugOf(report)).digest, report.digest)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

/** A minimal report object with every field the renderer reads. */
function fakeReport() {
  const metric = (value) => ({
    baselineMs: value,
    subjectMs: value + 10,
    deltaMs: 10,
    deltaPct: 1,
    optionalMedians: { subjectMinusBaseline: 10 },
    pairedDeltas: [10],
    baseline: { median: value, samples: [value], min: value, max: value },
    subject: { median: value + 10, samples: [value + 10], min: value + 10, max: value + 10 },
  })
  const context = (value) => ({ baseline: value, subject: value + 1, delta: 1, deltaPct: 1 })
  const report = {
    schema: 'dsh-report-card/1',
    generatedAt: '2026-11-10T00:00:00.000Z',
    subject: { spec: 'x', name: 'dsh-x', version: '1.0.0', kind: 'plugin', description: 'fixture' },
    method: {
      template: 'headless',
      task: 'say OK',
      samples: 1,
      timing: { boot: 'b', launch: 'l', turn: 't', step: 's', context: 'c' },
      isolation: { home: 'h', profile: 'p', cwd: 'c', model: 'm', permissionMode: 'read-only' },
      thresholds: THRESHOLDS,
    },
    machine: { platform: 'win32-x64', cpuCount: 8, dshVersion: '0.2.2', node: 'v24' },
    measurements: {
      boot: metric(100),
      bootCpu: metric(40),
      launch: metric(110),
      turn: metric(20),
      step: metric(10),
      assembly: metric(8),
      context: {
        modelVisibleChars: context(1000),
        systemChars: context(100),
        toolsChars: context(200),
        messagesChars: context(50),
        heuristicTokens: context(250),
        extensionChars: context(10),
      },
      capability: {
        available: true,
        tools: { added: ['fixture_echo'], addedSchemaChars: { fixture_echo: 100 } },
        sectionsAdded: [{ name: 'tool:fixture_echo', chars: 66 }],
        sectionsChanged: [],
        hooksAdded: { 'tools/pre-execute': 1 },
        hookOwners: {},
        entriesAdded: ['dsh-x'],
        variablesAdded: [],
        baselineEntryCount: 10,
        subjectEntryCount: 11,
      },
      risk: { flags: [] },
    },
    grades: { boot: 'A', turn: 'A', context: 'A', risk: 'A', overall: 'A' },
    health: { status: 'ok', failedEntries: [], subjectEntryPhase: 'active' },
    noise: { bootPct: 1, turnPct: 1 },
    notes: [],
    evidence: { surfaceFailures: [], turnFailures: [], sampleCounts: { surface: { baseline: 1, subject: 1 }, turn: { baseline: 1, subject: 1 } } },
  }
  report.digest = digestReport(report)
  return report
}


