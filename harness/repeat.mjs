#!/usr/bin/env node
/**
 * Repeatability check: run one card N times and show how far the reported
 * numbers move between runs.
 *
 * This is the acceptance test for the harness itself, not for a plugin. A
 * quiet machine should repeat the graded deltas within a few percent of the
 * baseline; a busy one will not, and the spread below says so.
 *
 *   node harness/repeat.mjs ./test/fixtures/fake-plugin --runs 2 --samples 3
 */
import { detectRuntime } from './environment.mjs'
import { classifySubject, generateReport } from './generate.mjs'
import { FIXTURE_TASK } from './measure.mjs'

/** One row of the comparison table: label, value path, baseline path, graded. */
const ROWS = [
  ['boot CPU graded delta', 'bootCpu.gradedDeltaMs', 'bootCpu.baselineMs', true],
  ['boot CPU raw delta', 'bootCpu.deltaMs', 'bootCpu.baselineMs', false],
  ['boot wall graded delta', 'boot.gradedDeltaMs', 'boot.baselineMs', false],
  ['boot paired median delta', 'boot.deltaMs', 'boot.baselineMs', false],
  ['boot best-case delta', 'boot.bestCaseDeltaMs', 'boot.baselineMs', false],
  ['assembly graded delta', 'assembly.gradedDeltaMs', 'assembly.baselineMs', true],
  ['assembly paired median delta', 'assembly.deltaMs', 'assembly.baselineMs', false],
  ['assembly best-case delta', 'assembly.bestCaseDeltaMs', 'assembly.baselineMs', false],
  ['step best-case delta', 'step.bestCaseDeltaMs', 'step.baselineMs', false],
  ['context token delta', 'context.heuristicTokens.delta', 'context.heuristicTokens.baseline', true],
  ['baseline boot (median)', 'boot.baselineMs', 'boot.baselineMs', false],
  ['baseline assembly (median)', 'assembly.baselineMs', 'assembly.baselineMs', false],
]

/** Read one nested measurement field from a card. */
function metric(report, path) {
  return path.split('.').reduce((value, key) => value?.[key], report.measurements)
}

/**
 * Run the repeatability check.
 * @param argv process arguments after the script
 * @returns the process exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : fallback
  }
  const spec = argv.find((arg) => !arg.startsWith('--') && arg !== flag('runs') && arg !== flag('samples'))
  const runs = Number(flag('runs', 2))
  const samples = Number(flag('samples', 3))
  if (spec === undefined) {
    console.error('usage: node harness/repeat.mjs <plugin-spec|directory> [--runs 2] [--samples 3]')
    return 2
  }

  const runtime = detectRuntime()
  const cards = []
  for (let index = 0; index < runs; index += 1) {
    process.stderr.write(`run ${index + 1}/${runs}…\n`)
    const result = await generateReport({ spec, samples, save: false, runtime, log: () => {}, task: FIXTURE_TASK })
    cards.push(result.report)
  }

  console.log(`subject: ${cards[0].subject.name}@${cards[0].subject.version} · ${runs} runs × ${samples} samples`)
  console.log('')
  console.log(['metric', ...cards.map((_card, index) => `run ${index + 1}`), 'spread', '% of baseline'].join('\t'))
  let worst = 0
  for (const [label, valuePath, baselinePath, graded] of ROWS) {
    const values = cards.map((card) => metric(card, valuePath))
    const spread = Math.max(...values) - Math.min(...values)
    const baseline = Math.abs(metric(cards[0], baselinePath))
    const ratio = baseline > 0 ? (spread / baseline) * 100 : 0
    if (graded) worst = Math.max(worst, ratio)
    const cells = values.map((value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : '—'))
    console.log([label, ...cells, spread.toFixed(1), `${ratio.toFixed(2)}%`].join('\t'))
  }
  console.log('')
  console.log(`worst spread on a graded delta: ${worst.toFixed(2)}% of its baseline (target: under 5%)`)
  console.log(worst < 5 ? 'PASS' : 'FAIL — this machine was not quiet enough for a 5% claim')
  console.log('')
  console.log(`subject profile template: ${classifySubject(spec).kind === 'dir' ? 'local directory' : 'npm package'} · measured on ${cards[0].machine.platform}`)
  return worst < 5 ? 0 : 1
}

if (import.meta.main) process.exit(await main())
