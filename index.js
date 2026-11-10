/**
 * DSH Report Card — an independent, dynamic quality benchmark for DSH plugins.
 *
 * The plugin contributes exactly one model-facing tool, `report_card`. The
 * measurement happens in disposable child processes: a fresh `DSH_HOME`, a
 * fresh profile copied from the shipped `headless` template, and a local
 * fixture endpoint instead of a real model. The plugin under test never runs
 * in this process, and never touches the profile that is serving you.
 *
 * Every number the tool reports is wall-clock measured, not estimated from
 * source code, and every card stores its samples so a re-run can show drift.
 */
import { generateReport } from './harness/generate.mjs'

export const name = 'dsh-report-card'

export const inject = ['tools']

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

/** The tool description is the model's only contract; keep the cost visible. */
const DESCRIPTION = [
  'Benchmark one DSH plugin or bundle and return a report card: boot-time delta,',
  'per-turn hook overhead, context tax (tokens the plugin adds to the assembled',
  'prompt), capability surface, and static risk flags. It installs the plugin into',
  'a throwaway profile with a fresh DSH_HOME and measures real harness processes,',
  'so it takes roughly 60-90 seconds for the default five samples (pass samples: 3',
  'for a quick look). Use it before installing an unknown plugin, or to compare a',
  'plugin version against its previous card. The card is saved under ./report-cards',
  'and is reproducible from the command it prints.',
].join(' ')

export function apply(ctx) {
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
      const result = await generateReport({
        spec: args.pluginSpec,
        samples,
        task: args.task,
        save: args.save !== false,
        cwd,
        signal: exec?.signal,
        log: (line) => ctx.logger?.info?.(`report-card: ${line}`),
      })
      // The card already carries its saved paths, reproducer, and digest.
      return result.markdown
    },
  }))
}

