/**
 * Unit tests for automatic measurement: eligibility, spec selection, queue
 * deduplication/serialization, and the startup/backfill sweep. No harness boot
 * happens here — the live install test is `test/auto-live.test.mjs`.
 *
 *   node test/auto.test.mjs
 */
import assert from 'node:assert/strict'
import {
  bundleKey,
  createAutoQueue,
  eligibleBundles,
  measureSpecOf,
  startAutoMeasurer,
} from '../harness/auto.mjs'

let passed = 0
let failed = 0

async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${String(error?.stack ?? error).split('\n').slice(0, 5).join('\n     ')}`)
  }
}

/** A listBundles-shaped record for one installed bundle. */
function bundle(overrides = {}) {
  return {
    name: 'dsh-example',
    version: '1.2.3',
    installed: true,
    availability: 'profile',
    official: false,
    optional: false,
    source: '1.2.3',
    ...overrides,
  }
}

await test('eligibility excludes shipped, optional, broken, and self', () => {
  const rows = [
    bundle(),
    bundle({ name: 'dsh-report-card', version: '1.0.0' }),
    bundle({ name: 'shipped', availability: 'installation' }),
    bundle({ name: 'optional', optional: true }),
    bundle({ name: 'official', official: true }),
    bundle({ name: 'broken', error: { code: 'not-bundle' } }),
    bundle({ name: 'missing', availability: 'missing' }),
    bundle({ name: 'not-installed', installed: false }),
    bundle({ name: 'no-version', version: undefined }),
  ]
  assert.deepEqual(eligibleBundles(rows).map((row) => row.name), ['dsh-example'])
})

await test('spec selection pins registry versions and keeps local sources', () => {
  assert.equal(measureSpecOf(bundle()), 'dsh-example@1.2.3')
  assert.equal(measureSpecOf(bundle({ source: '^1.0.0' })), 'dsh-example@1.2.3')
  assert.equal(measureSpecOf(bundle({ source: 'file:C:/plugins/dsh-example' })), 'file:C:/plugins/dsh-example')
  assert.equal(measureSpecOf(bundle({ source: 'link:C:/plugins/dsh-example' })), 'link:C:/plugins/dsh-example')
  assert.equal(measureSpecOf(bundle({ source: 'github:tespio/dsh-example' })), 'github:tespio/dsh-example')
  assert.equal(measureSpecOf(bundle({ source: 'git+https://example.test/x.git' })), 'git+https://example.test/x.git')
  assert.equal(measureSpecOf(bundle({ source: './local-plugin' })), './local-plugin')
  assert.equal(measureSpecOf(bundle({ source: 'C:\\plugins\\dsh-example' })), 'C:\\plugins\\dsh-example')
})

await test('the queue deduplicates and measures one at a time', async () => {
  const seen = []
  let active = 0
  let peak = 0
  const queue = createAutoQueue({
    log: () => {},
    measure: async (candidate) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      seen.push(bundleKey(candidate))
      active -= 1
      return { report: { grades: { overall: 'A' }, digest: 'd' }, paths: { json: 'j', markdown: 'm' } }
    },
  })
  assert.deepEqual(queue.enqueue([bundle(), bundle()]), ['dsh-example@1.2.3'])
  queue.enqueue([bundle(), bundle({ name: 'other' })])
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(seen, ['dsh-example@1.2.3', 'other@1.2.3'])
  assert.equal(peak, 1)
  assert.equal(queue.status().pending, 0)
  assert.equal(queue.status().results.length, 2)
})

await test('a failed measurement does not stall the queue', async () => {
  const calls = []
  const queue = createAutoQueue({
    log: () => {},
    measure: async (candidate) => {
      calls.push(candidate.name)
      if (candidate.name === 'bad') throw new Error('boom')
      return { report: { grades: { overall: 'A' }, digest: 'd' }, paths: {} }
    },
  })
  queue.enqueue([bundle({ name: 'bad' }), bundle({ name: 'good' })])
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(calls, ['bad', 'good'])
  const results = queue.status().results
  assert.equal(results[0].error, 'boom')
  assert.equal(results[1].grade, 'A')
})

await test('markKnown prevents a baseline plugin from being measured', async () => {
  const calls = []
  const queue = createAutoQueue({ log: () => {}, measure: async (candidate) => { calls.push(candidate.name); return null } })
  queue.markKnown([bundle()])
  assert.equal(queue.knows(bundle()), true)
  queue.enqueue([bundle()])
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(calls, [])
})

await test('startup sweep baselines existing plugins, then catches a new install', async () => {
  let installed = [bundle({ name: 'old' })]
  const measured = []
  const instrument = startAutoMeasurer({
    manager: { listBundles: async () => installed },
    reportsDir: 'unused',
    samples: 3,
    backfill: false,
    watch: false,
    initialDelayMs: 0,
    debounceMs: 5,
    generate: async (options) => {
      measured.push(options.spec)
      return { report: { grades: { overall: 'A' }, digest: 'd' }, paths: {} }
    },
    log: () => {},
  })
  await instrument.sweep()
  assert.deepEqual(measured, [])
  installed = [...installed, bundle({ name: 'new', version: '2.0.0' })]
  await instrument.sweep()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(measured, ['new@2.0.0'])
  instrument.stop()
})

await test('backfill measures what is already installed', async () => {
  const measured = []
  const instrument = startAutoMeasurer({
    manager: { listBundles: async () => [bundle({ name: 'old', version: '0.9.0' })] },
    reportsDir: 'unused',
    samples: 3,
    backfill: true,
    watch: false,
    initialDelayMs: 0,
    debounceMs: 5,
    generate: async (options) => { measured.push(options.spec); return { report: { grades: { overall: 'A' }, digest: 'd' }, paths: {} } },
    log: () => {},
  })
  await instrument.sweep()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(measured, ['old@0.9.0'])
  instrument.stop()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
