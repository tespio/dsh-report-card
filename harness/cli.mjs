#!/usr/bin/env node
/**
 * `report-card` command line: measure one plugin, print its card.
 *
 *   node harness/cli.mjs <plugin-spec|directory> [--samples 3] [--json]
 *   node harness/cli.mjs --from report-cards/x/y.json [--pretty]
 *
 * A terminal gets the boxed, coloured card; a redirected stream gets Markdown
 * (or `--markdown` explicitly). Nothing about the measurement changes.
 */
import fs from 'node:fs'
import { detectRuntime } from './environment.mjs'
import { classifySubject, generateReport, reproduceCommand } from './generate.mjs'
import { FIXTURE_TASK } from './measure.mjs'
import { renderPretty } from './pretty.mjs'
import { renderMarkdown } from './render.mjs'
import { renderSvg } from './svg.mjs'

/** Print usage. */
function help() {
  return `Usage: node harness/cli.mjs <plugin-spec|directory> [options]
       node harness/cli.mjs --from <card.json> [--pretty|--markdown|--svg|--json]

Measures a plugin in a throwaway profile and prints a report card.
  <plugin-spec>      npm package spec (name, name@version) or a directory path
  --from <card.json> render an existing card instead of measuring
  --samples <n>      measurement rounds per variant (default 5, minimum 3)
  --task <text>      the scripted turn's text (default: "${FIXTURE_TASK}")
  --template <name>  shipped profile template to measure on (default: headless)
  --out <dir>        where to store cards (default: ./report-cards)
  --pretty           print the terminal card even when stdout is redirected
  --markdown         print Markdown instead of the terminal card
  --svg <path>       also write the SVG graphic here
  --json             print the report as JSON
  --no-color         disable ANSI colour (also off automatically when redirected)
  --no-save          do not write the card to disk
  --keep             keep the throwaway profile (debugging a failed boot)
  --quiet            suppress progress lines
  --exe <path>       runtime executable override (default: detected Desktop app)
  --cli <path>       dsh bin.js override
  --help             print this help

Examples:
  node harness/cli.mjs ./test/fixtures/fake-plugin --samples 3
  node harness/cli.mjs dsh-trust-check@0.2.6
  node harness/cli.mjs --from report-cards/@local-rc-fake-bundle@0.1.0/latest.json --pretty --no-color
  DSH_REPORT_CARD_DIR=./cards node harness/cli.mjs @local/dsh-turbo
`
}

/** Parse argv into an options object; unknown options are usage errors. */
export function parseArgs(argv) {
  const options = { samples: 5, save: true, json: false, quiet: false, keep: false, color: undefined, format: undefined }
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
      case '--from': options.from = value(); break
      case '--svg': options.svg = value(); break
      case '--json': options.json = true; break
      case '--pretty': options.format = 'pretty'; break
      case '--markdown': options.format = 'markdown'; break
      case '--no-color': options.color = false; break
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
  if (options.from !== undefined) {
    if (positional.length > 0) throw new Error('--from takes no plugin spec')
    return options
  }
  if (positional.length !== 1) throw new Error('exactly one plugin spec or directory is required')
  if (!Number.isInteger(options.samples) || options.samples < 3 || options.samples > 10) {
    throw new Error('--samples must be an integer from 3 to 10: fewer than three samples cannot estimate machine noise')
  }
  options.spec = positional[0]
  return options
}

/** Whether the terminal should receive the coloured card. */
function usePretty(options) {
  if (options.format === 'pretty') return true
  if (options.format === 'markdown') return false
  return process.stdout.isTTY === true
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
  const color = options.color === true
    || (options.color !== false && process.stdout.isTTY === true && process.env.NO_COLOR === undefined)

  if (options.from !== undefined) {
    try {
      const report = JSON.parse(fs.readFileSync(options.from, 'utf8'))
      if (options.svg !== undefined) fs.writeFileSync(options.svg, renderSvg(report))
      const output = options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : usePretty(options)
          ? renderPretty(report, { color })
          : renderMarkdown(report, { command: `node harness/cli.mjs --from ${JSON.stringify(options.from)}` })
      process.stdout.write(output)
      return 0
    } catch (error) {
      process.stderr.write(`report card: ${error?.message ?? error}\n`)
      return 1
    }
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
    if (options.svg !== undefined) fs.writeFileSync(options.svg, result.svg)
    const output = options.json
      ? `${JSON.stringify(result.report, null, 2)}\n`
      : usePretty(options)
        ? renderPretty(result.report, { color })
        : result.markdown
    process.stdout.write(output)
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
