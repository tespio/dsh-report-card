/**
 * Automatic measurement of newly installed plugins.
 *
 * The trigger is the plugin manager's own event stream plus the profile
 * manifest, so the card follows whatever path installed the bundle: the
 * Plugins page, the `plugin_manager` tool, or a terminal `dsh plugin add`.
 * Measurements run one at a time in the background; each is the same
 * throwaway-profile measurement `report_card` performs, so nothing about the
 * live profile is touched.
 */
import fs from 'node:fs'

/** Bundles worth measuring: third-party, installed, readable, not our own. */
export function eligibleBundles(bundles, { self = 'dsh-report-card' } = {}) {
  return (bundles ?? []).filter((bundle) => bundle !== null
    && typeof bundle === 'object'
    && bundle.installed === true
    && bundle.availability === 'profile'
    && bundle.official !== true
    && bundle.optional !== true
    && bundle.error === undefined
    && bundle.name !== self
    && typeof bundle.version === 'string'
    && bundle.version !== '')
}

/**
 * The spec to measure for one installed bundle.
 *
 * Registry dependencies are pinned to the installed version, not to whatever
 * range the profile saved. Local, link, and git sources are used verbatim,
 * because that is the exact code the user installed.
 */
export function measureSpecOf(bundle) {
  const source = typeof bundle?.source === 'string' ? bundle.source.trim() : ''
  const local = /^(file:|link:|git\+|github:|https?:|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(source)
  if (source !== '' && local) return source
  return `${bundle.name}@${bundle.version}`
}

/** Stable key for one measured package version. */
export function bundleKey(bundle) {
  return `${bundle?.name}@${bundle?.version}`
}

/**
 * A serial queue with deduplication.
 *
 * @param options `{ measure, log }` — `measure(candidate)` resolves to a
 *   generated report card; errors are contained and reported, never thrown
 *   into the harness that scheduled them.
 */
export function createAutoQueue({ measure, log = () => {}, concurrency = 1 }) {
  const pending = []
  const known = new Set()
  const results = []
  let running = 0
  let stopped = false

  const pump = () => {
    if (stopped) return
    while (running < concurrency && pending.length > 0) {
      const candidate = pending.shift()
      running += 1
      Promise.resolve()
        .then(() => measure(candidate))
        .then((card) => {
          const entry = {
            name: candidate.name,
            version: candidate.version,
            grade: card?.report?.grades?.overall ?? null,
            digest: card?.report?.digest ?? null,
            json: card?.paths?.json ?? null,
            markdown: card?.paths?.markdown ?? null,
          }
          results.push(entry)
          log(`measured ${bundleKey(candidate)} (grade ${entry.grade ?? '?'})`)
        }, (error) => {
          results.push({ name: candidate.name, version: candidate.version, error: String(error?.message ?? error) })
          log(`failed ${bundleKey(candidate)}: ${String(error?.message ?? error)}`)
        })
        .finally(() => {
          running -= 1
          pump()
        })
    }
  }

  return {
    /** Queue candidates not already queued or measured. Returns their keys. */
    enqueue(candidates) {
      const added = []
      for (const candidate of candidates ?? []) {
        const key = bundleKey(candidate)
        if (known.has(key)) continue
        known.add(key)
        pending.push(candidate)
        added.push(key)
      }
      if (added.length > 0) {
        log(`queued ${added.join(', ')}`)
        pump()
      }
      return added
    },
    /** Mark candidates as handled without measuring (startup baseline). */
    markKnown(candidates) {
      for (const candidate of candidates ?? []) known.add(bundleKey(candidate))
    },
    /** Whether this package version was queued or marked already. */
    knows(bundle) {
      return known.has(bundleKey(bundle))
    },
    stop() {
      stopped = true
      pending.length = 0
    },
    status() {
      return { pending: pending.length, running, known: [...known], results: [...results] }
    },
  }
}

/**
 * Start the automatic measurer.
 *
 * @param options `{ manager, reportsDir, samples, backfill, generate, log, initialDelayMs, debounceMs, profileDir }`
 * @returns a handle with `sweep()`, `status()`, and `stop()`
 */
export function startAutoMeasurer({
  manager,
  reportsDir,
  samples = 3,
  backfill = false,
  generate,
  log = () => {},
  initialDelayMs = 10_000,
  debounceMs = 2500,
  profileDir,
  watch = true,
}) {
  const queue = createAutoQueue({
    log,
    measure: async (candidate) => {
      const result = await generate({
        spec: measureSpecOf(candidate),
        samples,
        save: true,
        outDir: reportsDir,
        log: () => {},
      })
      log(`card saved for ${bundleKey(candidate)}: ${result?.paths?.json ?? reportsDir}`)
      return result
    },
  })

  let initialised = false
  let timer
  let disposed = false
  let watcher

  const schedule = (delayMs = debounceMs) => {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      sweep().catch((error) => log(`sweep failed: ${String(error?.message ?? error)}`))
    }, delayMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  const sweep = async () => {
    if (disposed) return
    const bundles = eligibleBundles(await manager.listBundles())
    if (!initialised) {
      initialised = true
      if (!backfill) {
        // The first scan is the baseline: plugins that were already installed
        // are not re-measured just because the harness restarted.
        queue.markKnown(bundles)
        log(`baseline: ${bundles.length} installed third-party bundle(s) known`)
        return
      }
    }
    const fresh = bundles.filter((bundle) => !queue.knows(bundle))
    if (fresh.length > 0) queue.enqueue(fresh)
  }

  // A profile manifest change is the one signal both the manager and
  // `dsh plugin add` produce; the manager's own events make it immediate.
  if (watch && typeof profileDir === 'string' && profileDir !== '') {
    try {
      watcher = fs.watch(profileDir, { persistent: false }, (_event, filename) => {
        if (filename !== null && filename !== 'package.json' && filename !== 'cordis.patch.yml') return
        schedule()
      })
      watcher.on?.('error', () => {})
    } catch (error) {
      log(`manifest watch unavailable: ${String(error?.message ?? error)}`)
    }
  }

  const initial = setTimeout(() => {
    sweep().catch((error) => log(`initial sweep failed: ${String(error?.message ?? error)}`))
  }, initialDelayMs)
  if (typeof initial?.unref === 'function') initial.unref()

  return {
    sweep,
    schedule,
    status: () => queue.status(),
    stop() {
      disposed = true
      clearTimeout(initial)
      if (timer !== undefined) clearTimeout(timer)
      watcher?.close?.()
      queue.stop()
    },
  }
}
