/**
 * DSH Report Card — an independent, dynamic quality benchmark for DSH plugins.
 *
 * The plugin contributes two tools and one background behavior:
 *
 *   report_card          measure a plugin in a throwaway profile, return a card
 *   report_cards_recent  list the cards on disk, including automatic ones
 *   auto-measure         after a plugin is installed, measure it in the
 *                        background and save its card (configurable)
 *
 * The measurement always happens in disposable child processes: a fresh
 * `DSH_HOME`, a fresh profile copied from the shipped `headless` template, and
 * a local fixture endpoint instead of a real model. The plugin under test never
 * runs in this process, and never touches the profile that is serving you.
 */
import os from 'node:os'
import path from 'node:path'
import { startAutoMeasurer } from './harness/auto.mjs'
import { generateReport } from './harness/generate.mjs'
import { readIndex, resolveReportsDir, takePending } from './harness/store.mjs'

export const name = 'dsh-report-card'

export const inject = ['tools']

/** Defaults for the automatic behavior; every field is overridable in config. */
const DEFAULTS = {
  autoMeasure: true,
  autoSamples: 3,
  autoBackfill: false,
  autoReportsDir: null,
}

/** The tool description is the model's only contract; keep the cost visible. */
const DESCRIPTION = [
  'Benchmark one DSH plugin or bundle and return a report card: boot-time delta,',
  'per-turn hook overhead, context tax (tokens the plugin adds to the assembled',
  'prompt), capability surface, and static risk flags. It installs the plugin into',
  'a throwaway profile with a fresh DSH_HOME and measures real harness processes,',
  'so it takes roughly 60-90 seconds for the default five samples (pass samples: 3',
  'for a quick look). Use it before installing an unknown plugin, or to compare a',
  'plugin version against its previous card. The card is saved under ./report-cards',
  'and is reproducible from the command it prints. Newly installed plugins are also',
  'measured automatically in the background; report_cards_recent lists those cards.',
].join(' ')

/**
 * Measurements are serialized: an automatic card and a requested card must not
 * compete for the machine, or both numbers become noise.
 */
let measurementChain = Promise.resolve()
function serialize(task) {
  const run = measurementChain.then(task, task)
  measurementChain = run.then(() => {}, () => {})
  return run
}

/**
 * The directory relative specs resolve against.
 *
 * The host process runs in the profile directory, not the user's workspace, so
 * ask the working-directory service for the calling Session's directory. When
 * the deployment has no such service (or the call has no Agent), fall back to
 * the process directory rather than failing the measurement.
 */
async function sessionCwd(ctx, exec) {
  try {
    if (exec?.agent !== undefined) {
      const service = typeof ctx.reflect?.get === 'function'
        ? ctx.reflect.get('workingDirectory')
        : undefined
      if (service !== undefined && typeof service.ensure === 'function') {
        return await service.ensure(exec.agent, exec.signal)
      }
    }
  } catch {
    // A missing or failing directory service must not block a measurement.
  }
  return process.cwd()
}

/** Register `report_card`. */
function registerReportCard(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'report_card',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        pluginSpec: {
          type: 'string',
          description: 'npm package spec (name or name@version) or an absolute/relative directory containing a plugin package',
        },
        samples: {
          type: 'integer',
          minimum: 3,
          maximum: 10,
          description: 'measurement rounds per variant (default 5, minimum 3); each round adds roughly ten seconds. Fewer than three samples cannot estimate machine noise, so the tool refuses them',
        },
        save: {
          type: 'boolean',
          description: 'write the JSON and Markdown card under ./report-cards (default true)',
        },
        task: {
          type: 'string',
          description: 'text of the scripted turn (default "say OK"); change it only to match a fixture you control',
        },
      },
      required: ['pluginSpec'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const cwd = await sessionCwd(ctx, exec)
      // Clamp here too: a schema minimum is advisory on some tool pipelines,
      // and fewer than three samples cannot estimate the machine's noise.
      const samples = Math.min(10, Math.max(3, Math.trunc(args.samples ?? 5)))
      const result = await serialize(() => generateReport({
        spec: args.pluginSpec,
        samples,
        task: args.task,
        save: args.save !== false,
        cwd,
        signal: exec?.signal,
        log: (line) => ctx.logger?.info?.(`report-card: ${line}`),
      }))
      // The card already carries its saved paths, reproducer, and digest.
      return result.markdown
    },
  }))
}

/** Format the last cards for the model, newest first. */
export function formatRecent(index, limit) {
  const rows = [...(index?.reports ?? [])].slice(-limit).reverse()
  if (rows.length === 0) {
    return 'No report cards yet. Cards are written to ./report-cards (or the configured directory) and appear here after a measurement.'
  }
  const lines = [`${rows.length} most recent report card${rows.length === 1 ? '' : 's'}:`]
  for (const row of rows) {
    const boot = Number.isFinite(row.bootDeltaMs) ? `${Math.round(row.bootDeltaMs)} ms boot CPU` : 'no boot reading'
    const context = Number.isFinite(row.contextDelta) ? `${Math.round(row.contextDelta)} tok context` : 'no context reading'
    lines.push(`- ${row.subject} — grade ${row.grade}, ${boot}, ${context}, ${row.generatedAt}${row.json ? ` (${row.json})` : ''}`)
  }
  return lines.join('\n')
}

/** Register `report_cards_recent`. */
function registerRecentTool(ctx, reportsDirFor) {
  ctx.effect(() => ctx.tools.register({
    name: 'report_cards_recent',
    description: 'List the most recent DSH report cards on disk, including cards produced automatically after a plugin was installed. Returns one line per card: subject, grade, boot and context deltas, time, and the JSON path.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'how many cards to list, newest first (default 10)',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      const limit = Math.min(50, Math.max(1, Math.trunc(args.limit ?? 10)))
      return formatRecent(readIndex(reportsDirFor()), limit)
    },
  }))
}

/** Start automatic measurement of newly installed plugins. */
function startAuto(ctx, settings, configuredDir) {
  const log = (line) => ctx.logger?.info?.(`report-card auto: ${line}`)
  ctx.inject(['pluginManager', 'systemPrompt'], (sub) => {
    const samples = Math.min(10, Math.max(3, Math.trunc(Number(settings.autoSamples) || 3)))
    const manager = sub.pluginManager
    const profileDir = typeof manager?.profile?.dir === 'string' ? manager.profile.dir : process.env.DSH_PROFILE_DIR
    const reportsDir = configuredDir ?? dirFromProfile(profileDir)
    const instrument = startAutoMeasurer({
      manager,
      reportsDir,
      samples,
      backfill: settings.autoBackfill === true,
      profileDir,
      generate: (options) => serialize(() => generateReport({ ...options, auto: true })),
      log,
    })
    sub.effect(() => () => instrument.stop())
    sub.on('plugin-manager/operation', (operation) => {
      if (operation?.reason !== 'install' || operation?.phase !== 'settled') return
      if (operation.application === 'failed' || operation.application === 'cancelled') return
      instrument.schedule()
    })
    sub.on('plugin-manager/changed', () => instrument.schedule())

    // Announce a finished card exactly once: the first prompt assembled after
    // the measurement carries the note, and reading it clears the flag.
    sub.systemPrompt.context({
      name: 'report-card:pending',
      order: 240,
      text: () => {
        const cards = takePending(reportsDir, 3)
        if (cards.length === 0) return ''
        const lines = cards.map((card) => {
          const graphic = card.svg ?? card.markdown ?? card.json ?? ''
          return `- ${card.subject}: grade ${card.grade}, boot ${Number.isFinite(card.bootDeltaMs) ? `${Math.round(card.bootDeltaMs)} ms CPU` : 'unmeasured'}, context ${Number.isFinite(card.contextDelta) ? `${Math.round(card.contextDelta)} tok` : 'unmeasured'}${graphic ? ` — graphic: ${graphic}` : ''}`
        })
        return [
          `A plugin was just installed and measured automatically (${cards.length} new card${cards.length === 1 ? '' : 's'}).`,
          'Show it to the user once — attach the graphic when the client can render it, otherwise give the numbers and the saved path — then continue with what you were doing.',
          ...lines,
        ].join('\n')
      },
    })
  })
}

/** Where automatic cards live: the harness home, never the profile directory. */
function dirFromProfile(profileDir) {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
    return path.join(process.env.DSH_HOME, 'report-cards')
  }
  if (typeof profileDir === 'string' && profileDir !== '') {
    // <home>/profiles/<name> -> <home>
    return path.resolve(profileDir, '..', '..', 'report-cards')
  }
  return path.join(os.homedir(), 'report-cards')
}

/** Resolve the reports directory for the session tools, preferring the manager's profile. */
function reportsDirFor(ctx, configured) {
  if (configured !== undefined && configured !== null) return configured
  try {
    const manager = typeof ctx.reflect?.get === 'function' ? ctx.reflect.get('pluginManager') : undefined
    if (typeof manager?.profile?.dir === 'string') return dirFromProfile(manager.profile.dir)
  } catch {
    // fall through to the environment
  }
  return dirFromProfile(process.env.DSH_PROFILE_DIR)
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  const configuredDir = settings.autoReportsDir ?? undefined
  registerReportCard(ctx)
  registerRecentTool(ctx, () => reportsDirFor(ctx, configuredDir))
  const disabled = settings.autoMeasure === false || process.env.DSH_REPORT_CARD_AUTO === '0'
  if (!disabled) startAuto(ctx, settings, configuredDir)
}

export { resolveReportsDir }
