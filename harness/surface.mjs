/**
 * Capability-surface diff: what the subject added to the composed profile.
 *
 * The evidence is two probe dumps of the same throwaway profile — one without
 * the subject, one with it — so every row is a difference the subject caused,
 * not a guess from its source code.
 */

/** The last dump of one variant that actually captured a surface. */
export function lastDump(dumps, variant) {
  const matching = dumps.filter((entry) => entry.variant === variant && entry.dump?.error === undefined)
  return matching.at(-1)?.dump
}

/** Index a probe dump's sections by name. */
function sectionMap(dump) {
  return new Map((dump?.prompt?.sections ?? []).map((section) => [section.name, section.chars]))
}

/** Index a probe dump's hooks by event name. */
function hookMap(dump) {
  return new Map(Object.entries(dump?.hooks ?? {}))
}

/** Names present in `right` but not `left`. */
function added(left, right) {
  const before = new Set(left)
  return [...right].filter((name) => !before.has(name)).sort()
}

/**
 * Compare two probe dumps.
 * @returns the added tools, prompt sections, listeners, and loader entries.
 */
export function diffSurface(baseline, subject) {
  if (baseline === undefined || subject === undefined) {
    return {
      available: false,
      reason: baseline === undefined ? 'baseline surface missing' : 'subject surface missing',
    }
  }

  const baseTools = (baseline.tools ?? []).map((tool) => tool.name)
  const subjectTools = (subject.tools ?? []).map((tool) => tool.name)

  const baseSections = sectionMap(baseline)
  const subjectSections = sectionMap(subject)
  const sectionsAdded = added(baseSections.keys(), subjectSections.keys()).map((name) => ({
    name,
    chars: subjectSections.get(name) ?? 0,
  }))
  const sectionsChanged = [...subjectSections.keys()]
    .filter((name) => baseSections.has(name) && baseSections.get(name) !== subjectSections.get(name))
    .map((name) => ({
      name,
      before: baseSections.get(name),
      after: subjectSections.get(name),
      delta: (subjectSections.get(name) ?? 0) - (baseSections.get(name) ?? 0),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const baseHooks = hookMap(baseline)
  const subjectHooks = hookMap(subject)
  const hooksAdded = {}
  for (const [event, count] of subjectHooks) {
    const delta = count - (baseHooks.get(event) ?? 0)
    if (delta > 0) hooksAdded[event] = delta
  }
  const hookOwners = {}
  for (const event of Object.keys(hooksAdded)) {
    const before = new Set(baseline.hookOwners?.[event] ?? [])
    hookOwners[event] = (subject.hookOwners?.[event] ?? []).filter((owner) => !before.has(owner)).sort()
  }

  const baseEntries = (baseline.entries ?? []).map((entry) => entry.name)
  const subjectEntries = (subject.entries ?? []).map((entry) => entry.name)
  const entriesAdded = added(baseEntries, subjectEntries)
  const addedRows = (subject.entries ?? []).filter((entry) => !baseEntries.includes(entry.name))
  const failedEntries = (subject.entries ?? []).filter((entry) => entry.phase === 'failed').map((entry) => entry.name)

  const basePromptChars = baseline.prompt?.sectionChars ?? 0
  const subjectPromptChars = subject.prompt?.sectionChars ?? 0

  return {
    available: true,
    entriesAdded,
    addedEntryRows: addedRows.map((entry) => ({ id: entry.id, name: entry.name, phase: entry.phase })),
    failedEntries,
    toolsAdded: added(baseTools, subjectTools),
    toolsRemoved: added(subjectTools, baseTools),
    sectionsAdded,
    sectionsChanged,
    promptChars: {
      baseline: basePromptChars,
      subject: subjectPromptChars,
      delta: subjectPromptChars - basePromptChars,
    },
    hooksAdded,
    hookOwners,
    variablesAdded: added(baseline.prompt?.variableNames ?? [], subject.prompt?.variableNames ?? []),
    baselineEntryCount: baseEntries.length,
    subjectEntryCount: subjectEntries.length,
    baselineHookEvents: baseHooks.size,
    subjectHookEvents: subjectHooks.size,
  }
}
