/**
 * The measurement probe.
 *
 * It is inserted last into a throwaway profile and never speaks to a model: it
 * snapshots what the composed plugin tree contributed — visible tools, prompt
 * sections, event listeners, loader entries — writes one JSON file, and (in
 * capture mode) exits so the boot costs nothing beyond the measurement.
 *
 * This package is copied into the throwaway profile by the harness; it is not
 * meant to be installed into a real profile.
 */
import fs from 'node:fs'

export const name = 'report-card-probe'

export const inject = ['tools', 'systemPrompt']

const FIBER_STATE = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']

/** Service lookup that never throws: probe fields are optional evidence. */
function service(ctx, name) {
  try {
    const reflect = ctx.reflect
    if (reflect && typeof reflect.get === 'function') {
      const value = reflect.get(name)
      if (value !== undefined) return value
    }
  } catch {
    // fall through to the injected accessor
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/** Entry id and package name for a hook's owning context, when it has one. */
function ownerOf(hook) {
  try {
    const entry = hook?.ctx?.fiber?.entry
    if (entry === undefined || entry === null) return { id: null, name: '(root)' }
    return { id: entry.id ?? null, name: entry.options?.name ?? '(unknown)' }
  } catch {
    return { id: null, name: '(root)' }
  }
}

/** Snapshot the visible tool schemas: what the model is actually offered. */
function captureTools(ctx) {
  const tools = []
  try {
    for (const schema of ctx.tools.schemas()) {
      tools.push({
        name: schema.name,
        descriptionChars: typeof schema.description === 'string' ? schema.description.length : 0,
        schemaChars: JSON.stringify(schema.parameters ?? {}).length,
      })
    }
  } catch (error) {
    return { tools, error: String(error?.message ?? error) }
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { tools }
}

/** Snapshot the assembled prompt composition: section names and sizes. */
async function capturePrompt(ctx) {
  try {
    const assembly = await ctx.systemPrompt.assemble({})
    const sections = (assembly.sections ?? []).map((section) => ({
      name: section.name,
      chars: typeof section.text === 'string' ? section.text.length : 0,
    }))
    const contexts = (assembly.contexts ?? []).map((entry) => ({
      name: entry.name,
      chars: typeof entry.text === 'string' ? entry.text.length : 0,
    }))
    return {
      sections,
      contexts,
      variableNames: Object.keys(assembly.variables ?? {}).sort(),
      toolDeclarations: Array.isArray(assembly.tools) ? assembly.tools.length : 0,
      sectionChars: sections.reduce((total, section) => total + section.chars, 0),
    }
  } catch (error) {
    return { sections: [], contexts: [], variableNames: [], toolDeclarations: 0, sectionChars: 0, error: String(error?.message ?? error) }
  }
}

/** Snapshot every registered event listener, grouped by event name. */
function captureHooks(ctx) {
  const events = service(ctx, 'events')
  const hooks = events?._hooks
  if (hooks === undefined || hooks === null) return { hooks: {}, error: 'event service does not expose listeners' }
  const counts = {}
  const owners = {}
  for (const [eventName, listeners] of Object.entries(hooks)) {
    if (!Array.isArray(listeners) || listeners.length === 0) continue
    if (eventName.startsWith('internal/')) continue
    counts[eventName] = listeners.length
    const names = new Set(listeners.map((hook) => ownerOf(hook).name))
    owners[eventName] = [...names].sort()
  }
  return { hooks: counts, owners }
}

/** Snapshot the loader entries: which plugins this profile composed. */
function captureEntries(ctx) {
  const loader = service(ctx, 'loader')
  const entries = []
  try {
    for (const entry of loader?.entries?.() ?? []) {
      entries.push({
        id: entry.id ?? null,
        name: entry.options?.name ?? null,
        disabled: entry.options?.disabled === true,
        phase: FIBER_STATE[entry.fiber?.state] ?? null,
      })
    }
  } catch (error) {
    return { entries, error: String(error?.message ?? error) }
  }
  return { entries }
}

/** Write the dump atomically, so the parent never reads a partial file. */
function writeDump(target, payload) {
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2))
  fs.renameSync(temporary, target)
}

export function apply(ctx) {
  const target = process.env.DSH_REPORT_CARD_PROBE
  if (typeof target !== 'string' || target === '') return
  const exitAfter = process.env.DSH_REPORT_CARD_PROBE_EXIT === '1'
  const startedAt = Date.now()
  const run = async () => {
    const tools = captureTools(ctx)
    const prompt = await capturePrompt(ctx)
    const hooks = captureHooks(ctx)
    const loader = captureEntries(ctx)
    const payload = {
      schema: 'dsh-report-card/probe/1',
      at: Date.now(),
      // Process-relative boot reference: excludes OS spawn overhead, so the
      // reading reflects plugin composition rather than DLL loading jitter.
      timeOrigin: typeof performance?.timeOrigin === 'number' ? performance.timeOrigin : null,
      sinceApplyMs: Date.now() - startedAt,
      pid: process.pid,
      cwd: process.cwd(),
      dshHome: process.env.DSH_HOME ?? null,
      node: process.version,
      execPath: process.execPath,
      versions: { electron: process.versions.electron ?? null, v8: process.versions.v8 },
      // CPU time, not wall time: what composing the plugin tree actually cost,
      // independent of whatever else the machine was doing.
      cpuMs: (() => {
        const usage = process.cpuUsage()
        return (usage.user + usage.system) / 1000
      })(),
      memoryRssBytes: process.memoryUsage().rss,
      tools: tools.tools,
      toolsError: tools.error ?? null,
      prompt,
      hooks: hooks.hooks,
      hookOwners: hooks.owners ?? {},
      hooksError: hooks.error ?? null,
      entries: loader.entries,
      entriesError: loader.error ?? null,
    }
    writeDump(target, payload)
    if (exitAfter) {
      // Leave the profile as soon as the measurement is on disk: no session,
      // no model call, no further work to time.
      process.exit(0)
    }
  }
  ctx.inject(['tools', 'systemPrompt'], () => {
    run().catch((error) => {
      try {
        writeDump(target, { schema: 'dsh-report-card/probe/1', at: Date.now(), error: String(error?.stack ?? error) })
      } finally {
        if (exitAfter) process.exit(1)
      }
    })
  })
}
