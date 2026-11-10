#!/usr/bin/env node
/**
 * `report-card` command line: measure one plugin, print its card.
 *
 *   node harness/cli.mjs <plugin-spec|directory> [--samples 3] [--json]
 *
 * Every number in a saved card is reproducible with the command the card
 * prints in its Reproduce section.
 */
import { detectRuntime } from './environment.mjs'
import { classifySubject, generateReport, reproduceCommand } from './generate.mjs'
import { FIXTURE_TASK } from './measure.mjs'

/** Print usage. */
function help() {
  return `Usage: node harness/cli.mjs <plugin-spec|directory> [options]

Measures a plugin in a throwaway profile and prints a report card.
  <plugin-spec>      npm package spec (name, name@version) or a directory path
  --samples <n>      measurement rounds per variant (default 5, minimum 3)
  --task <text>      the scripted turn's text (default: "${FIXTURE_TASK}")
  --template <name>  shipped profile template to measure on (default: headless)
  --out <dir>        where to store cards (default: ./report-cards)
  --json             print the report as JSON instead of Markdown
  --no-save          do not write the card to disk
  --keep             keep the throwaway profile (debugging a failed boot)
  --quiet            suppress progress lines
  --exe <path>       runtime executable override (default: detected Desktop app)
  --cli <path>       dsh bin.js override
  --help             print this help

Examples:
  node harness/cli.mjs ./test/fixtures/fake-plugin --samples 2
  node harness/cli.mjs dsh-trust-check@0.2.6
  DSH_REPORT_CARD_DIR=./cards node harness/cli.mjs @local/dsh-turbo
`
}

/** Parse argv into an options object; unknown options are usage errors. */
export function parseArgs(argv) {
  const options = { samples: 5, save: true, json: false, quiet: false, keep: false }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    switch (arg) {
      case '--help': case '-h': options.help = true; break
      case '--samples': options.samples = Number(value()); break
      case '--task': options.task = value(); break
      case '--template': options.template = value(); break
      case '--out': options.outDir = value(); break
      case '--json': options.json = true; break
      case '--no-save': options.save = false; break
      case '--keep': options.keep = true; break
      case '--quiet': options.quiet = true; break
      case '--exe': options.exe = value(); break
      case '--cli': options.cli = value(); break
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
        positional.push(arg)
    }
  }
  if (options.help) return options
  if (positional.length !== 1) throw new Error('exactly one plugin spec or directory is required')
  if (!Number.isInteger(options.samples) || options.samples < 3 || options.samples > 10) {
    throw new Error('--samples must be an integer from 3 to 10: fewer than three samples cannot estimate machine noise')
  }
  options.spec = positional[0]
  return options
}

/** Run the CLI. */
export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`report card: ${error.message}\n\n${help()}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(help())
    return 0
  }
  const runtime = options.exe !== undefined || options.cli !== undefined
    ? { kind: 'explicit', exe: options.exe ?? process.execPath, cli: options.cli, version: undefined }
    : detectRuntime()
  const log = options.quiet ? () => {} : (line) => process.stderr.write(`${line}\n`)
  log(`subject: ${options.spec} (${classifySubject(options.spec).kind})`)
  try {
    const result = await generateReport({
      spec: options.spec,
      samples: options.samples,
      task: options.task,
      template: options.template,
      save: options.save,
      outDir: options.outDir,
      runtime,
      log,
      keep: options.keep,
    })
    process.stdout.write(options.json ? `${JSON.stringify(result.report, null, 2)}\n` : result.markdown)
    return result.report.grades.overall === 'F' ? 1 : 0
  } catch (error) {
    process.stderr.write(`report card failed: ${error?.stack ?? error}\n`)
    if (reproduceCommand({ spec: options.spec, samples: options.samples, task: options.task }) !== '') {
      process.stderr.write(`reproduce: ${reproduceCommand({ spec: options.spec, samples: options.samples, task: options.task })}\n`)
    }
    return 1
  }
}

if (import.meta.main) process.exit(await main())

