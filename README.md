# DSH Report Card

An independent, **dynamic** benchmark for DeepSeek Harness plugins. It installs
one plugin into a throwaway profile, boots the real harness with it, runs one
scripted turn against a local fixture endpoint, and reports what the plugin
costs: boot time, per-turn hook overhead, the tokens it adds to the assembled
prompt, the capability surface it contributes, and the static risk flags its
package carries.

Every number is a reading from a real harness process — wall clock, process CPU,
or the exact bytes of the request it sent — none of it estimated from source
code. Every card stores its samples, its digest, and the command that reproduces
it.

## What already exists, and why this is not a duplicate

Searched 2026-11-10: the `dsh-plugin-catalog` 2026.1110.18259 (9,959 plugins)
and npm. The adjacent tools are all **static scores or in-profile meters**:

| Existing | What it actually does | Why it is a different thing |
|---|---|---|
| `dsh-plugin-scorecard` 0.3.2 | Static quality/security score, rankings, history across the whole catalog | Scores package *files*; never boots the plugin |
| `dsh-quality-score` 0.1.4 | Static 0-100 from manifest, peers, dist-tags, docs | Same: a metadata rubric, no runtime |
| `dsh-trust-check` 0.2.6 | Static capability disclosure with `file:line` evidence | Facts about source, not behaviour under load |
| `dsh-xray` 0.11.0 | Per-plugin context-tax attribution, per-request token ledger | Prices what is **already loaded in your profile**; cannot evaluate a candidate |
| `dsh-context-doctor` | Token costs of instruction chains, skill catalogs, tool schemas | Static accounting of the current context |
| `dsh-agent-bench` 0.1.1 | Replays fixed agent cases and diffs scorecards | Measures *model behaviour*; the plugin is not the subject |
| `dsh-workspace-switch-cost` | Cold-start cost of switching workspaces | Per-workspace, not per candidate plugin |

**One line:** existing scorecards read a plugin's files, and the closest dynamic
instruments price what is already in your profile — nothing installs a candidate
into a disposable profile and times its boot, a scripted turn, and the exact
request it produces; that is what this does, so it complements them.

## What a card contains

| Dimension | How it is measured |
|---|---|
| **Boot wall** | Process start (`performance.timeOrigin`) → the measurement probe reporting the plugin tree composed, with and without the plugin |
| **Boot CPU** | The child's own CPU time (user + system) at that same dump: what composing the tree cost, independent of what else the machine was doing. This is the graded boot figure |
| **Launch** | The same point measured from process spawn, including OS process startup |
| **Turn / step** | `turn_start → turn_end` and `step_start → step_end` on one fixed scripted turn |
| **Assembly** | `step/start` (from the child's own session log inside the captured request) to the request reaching the fixture endpoint: prompt assembly and request serialization — the phase plugin hooks run in. This is the graded per-turn figure |
| **Context tax** | Model-visible bytes of the request the harness actually sent (`system` + `tools` + `messages`), in tokens at the documented 4-chars/token heuristic; harness extension fields are counted separately |
| **Capability surface** | Tools and schemas the model is offered, prompt sections and their sizes, event listeners per event, loader entries, prompt variables — all as a diff against the same profile without the plugin |
| **Static risk flags** | Install scripts, shipped binaries, network hosts, subprocess use, dynamic code, filesystem writes, `process.exit` — with file and line evidence. Nothing is executed to produce them |
| **Health** | `ok`, `install-rejected`, `install-failed`, `boot-failed`, `turn-failed`, `entry-failed`, `entry-absent`. A plugin that fails to activate is a failed card, never a passing one |

See [`docs/example-card.md`](docs/example-card.md) for a complete card of the
test fixture.

## How it measures

```
                    ┌──────────────── throwaway DSH_HOME ────────────────┐
  subject package ► │ profile "rc-measured" ← shipped "headless" template │
                    │   subject plugin: an insert row, or the bundle list │
                    │   probe: inserted last, dumps the surface, exits    │
                    └────────────┬───────────────────────────┬────────────┘
                                 │ surface runs              │ turn runs
                                 ▼                           ▼
                    spawn → probe dump → exit     spawn → session → turn → exit
                    boot wall/CPU + surface       assembly/step + exact request
                                                 DEEPSEEK_BASE_URL → local fixture
```

* **Fresh state.** Each report gets a new `DSH_HOME`, a new profile copied from
  the shipped `headless` template, and an empty working directory. Your real
  profile is never opened, so a measured plugin cannot disturb it.
* **No model calls.** `DEEPSEEK_BASE_URL` points at a loopback endpoint that
  speaks the Anthropic-style Messages SSE stream the shipped adapter parses. The
  reply is a fixed one-line text block, so the turn is deterministic — and the
  *request* is captured verbatim, which is the context-tax measurement.
* **No background noise.** The fixture overlay disables session-title generation
  and telemetry, and a discarded warm-up pair primes the file cache before any
  sample is recorded.
* **Round-paired deltas.** Each subject run is paired with the baseline run
  immediately before it; the delta is the median of those paired differences,
  which cancels slow machine drift. Grades charge only the part of a delta that
  clears the machine's measured noise (one standard error of the paired
  differences), so a loaded machine cannot turn a free plugin into a bad grade —
  and cannot hide real overhead either, because the raw numbers stay on the
  card next to their floor.
* **Integrity.** The card is hashed (`sha256` over canonical JSON, digest
  excluded). Re-running the same subject compares against the previous card in
  the same directory and prints drift.

## Install

Published on npm as **`dsh-report-card@1.0.0`**. It ships as a bundle with
metadata, `locale/en.json`, `locale/zh.json` and an icon. The plugin manager adds
the dependency *and* enables the bundle in one step; removing it undoes both:

```
plugin_manager install_bundle  target: "dsh-report-card@1.0.0"
plugin_manager remove_bundle   target: "dsh-report-card"
```

or from a terminal:

```powershell
dsh plugin --profile web add dsh-report-card
```

For development from a checkout, pass a directory spec instead
(`file:C:/path/to/dsh-report-card`). `install_bundle` is the sanctioned path
because a bundle is composed through the profile's bundle list, not just
`node_modules`; the bundle inserts one entry, `dsh-report-card`, which
contributes one tool.

## Use

From a session (the tool is model-facing):

```
report_card(pluginSpec: "dsh-trust-check@0.2.6", samples: 3)
```

From a terminal — the same code path, printable output:

```powershell
node harness/cli.mjs ./test/fixtures/fake-plugin              # local directory
node harness/cli.mjs dsh-trust-check@0.2.6 --samples 3        # npm package
node harness/cli.mjs dsh-quality-score --json                 # raw card
```

Cards are written to `./report-cards/<name>@<version>/<timestamp>.{json,md}` and
indexed in `./report-cards/index.json`; set `DSH_REPORT_CARD_DIR` to move that.

The tool takes **~60–90 s** for the default five samples: four harness boots per
sample round (surface × 2, turn × 2) plus one discarded warm-up round. Pass
`samples: 3` for a quick look and `samples: 8..10` when you need to resolve a
few milliseconds.

## Reading a card

```
**Grade D** · graded boot +6.3 ms CPU · graded turn 0 ms · context +76 tok · risk D
```

* The headline shows the two **graded** deltas plus the exact context delta and
  the risk grade. Every raw number — wall boot, process CPU, turn, assembly,
  step, launch — is in the tables below with its samples and noise floor.
* Wall time is presented but never graded: it is hostage to whatever else the
  machine is doing. The boot grade uses noise-adjusted **process CPU** at the
  moment the plugin tree is ready; the turn grade uses the noise-adjusted
  **assembly** time, the phase plugin hooks run in.
* `context` is the median of the captured requests; it is exactly reproducible,
  since the prompt is a function of the profile.
* `risk` is disclosure, not a verdict: `A` none, `B` informational only,
  `C` medium flags, `D` high flags. A postinstall script is a high flag.
* The overall grade is the worst dimension. `F` means the card could not measure
  a running plugin.

| Dimension | A | B | C | D | F |
|---|---|---|---|---|---|
| Boot CPU (noise-adjusted) | ≤ 10 ms | ≤ 30 ms | ≤ 80 ms | ≤ 250 ms | > 250 ms |
| Assembly (noise-adjusted) | ≤ 10 ms | ≤ 30 ms | ≤ 80 ms | ≤ 200 ms | > 200 ms |
| Context token delta | ≤ 100 | ≤ 500 | ≤ 2000 | ≤ 8000 | > 8000 |
| Risk | clean | info | medium | high | — |

Numbers are comparable **only on the same machine identity** (platform, CPU
count, dsh version) — the card prints it. A delta inside the printed noise floor
is noise; the card says so in its notes.

## Reproduce and verify

Every card prints its own reproduce command. The harness's own repeatability
check runs one subject several times and reports the spread:

```powershell
node harness/repeat.mjs ./test/fixtures/fake-plugin --runs 2 --samples 3
```

Measured while a harness session was actively running on the same machine (full
output in [`docs/acceptance.md`](docs/acceptance.md)): the **context delta
repeated at 0.00%**, the **graded boot CPU and assembly deltas at 0.00%**, and
the raw round-paired wall deltas within 1.9% (boot) and 2.4% (assembly). Earlier
in the same session, with a busier machine, raw wall deltas moved by up to 19%.
The card publishes its own jitter and noise floor for exactly this reason.

Tests:

```powershell
node test/unit.test.mjs      # units, ~1 s
node test/harness.test.mjs   # real boots against fixtures, ~80 s
```

`test/harness.test.mjs` covers the whole harness with fake plugins: a healthy
plugin (surface, context tax, risk flags, digest), a plugin that throws during
activation (must be a failed card), a plugin that calls `process.exit` (must be
a failed boot that still returns), and a second card that must show drift
against the first.

## Publishing

The package is publish-ready: `npm publish` and the catalog PR are documented in
[`docs/publishing.md`](docs/publishing.md), including the exact
`data/plugins/<owner>__<repo>.yml` entry the awesome-dsh-plugin list expects, the
`repository` field the catalog's npm mapping depends on, and the tarball-install
check that was run against the packed artifact.
## Safety and limits

* **The subject executes.** It runs in a disposable profile with a read-only
  file policy and a fresh `DSH_HOME`, as your user — that is enough to keep it
  away from your real profile, but it is **not** a security sandbox. Read the
  risk flags before measuring something you do not trust.
* **No `app.asar` edits.** The harness only spawns the shipped CLI and writes
  into a temp directory.
* **Fail closed.** A package the runtime refuses to install (for example a peer
  version gate) is reported as `install-rejected` or `install-failed`; the harness never grants a
  version exemption and never bypasses the gate. A plugin that crashes the host
  or hangs is bounded by a per-child timeout.
* **The heuristic is not billing.** Context tokens use four characters per
  token, the same heuristic the shipped token meter documents; CJK and JSON
  schemas are underpriced by it. Extension fields (`dsh_session_log`,
  `dsh_plugin_packages`) are measured separately and excluded.
* **One turn, one profile shape.** The card does not measure multi-turn
  behaviour, compaction, or client-side (browser) cost. Client slot
  contributions are not observable host-side; only host-side surface is
  reported.

## Layout

| Path | Role |
|---|---|
| `index.js` | The bundle entry: registers the `report_card` tool |
| `harness/cli.mjs` | Command line entry |
| `harness/generate.mjs` | measure → diff → grade → render → store |
| `harness/measure.mjs` | The four-run loop, event parsing, request pricing |
| `harness/mock-llm.mjs` | The local Messages endpoint and its SSE fixture |
| `harness/probe/` | The fixture plugin that dumps a profile's surface |
| `harness/risk.mjs` | Static disclosure scan |
| `harness/report.mjs` | Grades, digest, drift, card assembly |
| `harness/render.mjs` | Markdown card |
| `harness/repeat.mjs` | Repeatability check for the harness itself |
| `docs/` | An example card and the acceptance evidence |
| `locale/`, `icon.svg`, `cordis.patch.yml` | Bundle metadata and its one insert row |
| `test/` | Unit tests, end-to-end tests, fake plugins |

## License

MIT.
