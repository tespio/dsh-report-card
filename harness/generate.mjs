/**
 * One call that turns a plugin spec into a report card: measure, diff, grade,
 * render, store.
 *
 * Both entry points use it — the command line and the `report_card` tool — so a
 * number quoted in chat and a number quoted in the README come from the same
 * code path.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { childEnv, detectRuntime, runChild } from './environment.mjs'
import { measure, FIXTURE_TASK } from './measure.mjs'
import { buildReport, SCHEMA } from './report.mjs'
import { renderMarkdown } from './render.mjs'
import { previousFor, readIndex, resolveReportsDir, saveReport, slugOf } from './store.mjs'

/**
 * Decide whether a spec names an existing directory or a package to install.
 * @param spec the positional argument
 * @param cwd directory relative paths resolve against (the Session workspace)
 */
export function classifySubject(spec, cwd = process.cwd()) {
  const absolute = path.resolve(cwd, spec)
  let stats
  try {
    stats = fs.statSync(absolute)
  } catch {
    stats = undefined
  }
  if (stats?.isDirectory() === true) {
    return { kind: 'dir', dir: absolute, spec }
  }
  if (stats?.isFile() === true) {
    // A packed tarball: install it by absolute path, because the package
    // manager runs in the profile directory, not in the caller's.
    return { kind: 'npm', spec, installSpec: absolute }
  }
  return { kind: 'npm', spec }
}

/** The exact command that reproduces one card. */
export function reproduceCommand({ spec, samples, task, outDir }) {
  const parts = ['node harness/cli.mjs', JSON.stringify(spec)]
  if (samples !== undefined) parts.push(`--samples ${samples}`)
  if (task !== undefined && task !== FIXTURE_TASK) parts.push(`--task ${JSON.stringify(task)}`)
  if (outDir !== undefined) parts.push(`--out ${JSON.stringify(outDir)}`)
  return parts.join(' ')
}

/**
 * Measure one subject and return its card.
 *
 * @param options `{spec, samples, task, template, save, cwd, outDir, runtime, log, keep}`
 */
export async function generateReport(options) {
  const {
    spec,
    samples = 5,
    task = FIXTURE_TASK,
    template = 'headless',
    save = true,
    cwd = process.cwd(),
    outDir,
    runtime: suppliedRuntime,
    log = () => {},
    keep = false,
    now = () => new Date(),
    signal,
  } = options

  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new Error('report card: pass a plugin package spec or a directory path')
  }
  const subject = classifySubject(spec.trim(), cwd)
  const runtime = suppliedRuntime ?? detectRuntime()
  if (runtime.version === undefined) runtime.version = await runtimeVersion(runtime)
  log(`runtime: ${runtime.kind} ${runtime.exe}`)

  const measured = await measure({ subject, runtime, samples, task, template, log, keep, signal })
  const name = measured.installed.name
  const version = measured.installed.manifest.version ?? null
  const dir = outDir ?? resolveReportsDir({ cwd })
  const slug = slugOf({ subject: { name, version } })
  const previous = save ? previousFor(readIndex(dir), slug) : undefined

  const report = buildReport({ measured, subject, runtime, samples, task, template, previous })
  const command = reproduceCommand({ spec: subject.spec, samples, task, outDir })
  let paths
  let markdown = renderMarkdown(report, { command, savedPaths: undefined })
  if (save) {
    paths = saveReport({ dir, report, markdown })
    markdown = renderMarkdown(report, { command, savedPaths: paths })
    // Persist the final Markdown (it carries the saved paths) after the index write.
    fs.writeFileSync(paths.markdown, markdown)
  }
  return { report, markdown, paths, slug, runtime, schema: SCHEMA, now: now().toISOString() }
}

/** Run `<cli> --version` once so the report can name the harness version. */
export async function runtimeVersion(runtime) {
  try {
    const result = await runChild({
      runtime,
      args: ['--version'],
      cwd: os.tmpdir(),
      env: childEnv(runtime, { home: path.join(os.tmpdir(), `dsh-report-card-version-${process.pid}`) }),
      timeoutMs: 60_000,
    })
    const version = result.stdout.trim().split(/\r?\n/).at(-1)
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

