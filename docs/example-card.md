# Report card — @local/rc-fake-plugin@0.1.0

**Grade D** · graded boot +6.3 ms CPU · graded turn 0 ms · context +76 tok · risk D

> Fake plugin used by the report-card harness tests: one tool, one prompt section, one listener.

## At a glance

| Dimension | Baseline | Subject | Delta | Grade |
| --- | --- | --- | --- | --- |
| Boot wall (process → plugin tree) | 2397 / 2619 / 2734 ms | 2465 / 2625 / 2805 ms | +67.9 ms | — |
| Boot CPU (process at ready) | 2780 / 2952 / 2953 ms | 2827 / 2921 / 2983 ms | +30 ms | A |
| Turn (turn_start → turn_end) | 142 / 101 / 154 ms | 114 / 111 / 114 ms | -28 ms | — |
| Assembly (step/start → request) | 88 / 38 / 60 ms | 48 / 46 / 45 ms | -15 ms | A |
| Step (prompt → model answered) | 105 / 52 / 79 ms | 65 / 65 / 61 ms | -18 ms | — |
| Context (model-visible tokens) | 6237 | 6313 | +76 tok | A |
| Static risk flags | — | 3 | — | D |

Samples: 3 per variant, medians shown. Boot jitter +2.5%; step jitter +67.1%.

Grades charge only overhead above this machine's noise floor: boot CPU +6.3 ms graded from +30 ms raw (floor +23.7 ms), turn assembly 0 ms graded from -15 ms raw (floor +13.9 ms). Wall time is reported but never graded: it is hostage to whatever else the machine is doing.

## Boot

| Sample | Baseline | Subject |
| --- | --- | --- |
| 1 | 2397 ms | 2465 ms |
| 2 | 2619 ms | 2625 ms |
| 3 | 2734 ms | 2805 ms |

Measured as process start (performance.timeOrigin) to the probe writing its dump (plugin tree composed). Deltas are round-paired medians (each subject run is paired with the baseline run before it), which cancels slow machine drift; the unpaired median difference was +6.3 ms. A negative delta means the subject booted sooner.

Launch (spawn → the same dump, including process startup): baseline 2724 ms, subject 2734 ms, delta +36 ms.

Boot CPU (the graded figure, total process CPU when the plugin tree is ready): baseline 2952 ms, subject 2921 ms, delta +30 ms raw, +6.3 ms after the noise floor. CPU time moves only when the plugin actually does work, so it stays stable on a loaded machine.

## One scripted turn

| Metric | Baseline | Subject | Delta |
| --- | --- | --- | --- |
| Turn | 142 / 101 / 154 ms | 114 / 111 / 114 ms | -28 ms |
| Assembly (hook phase) | 88 / 38 / 60 ms | 48 / 46 / 45 ms | -15 ms |
| Step (whole) | 105 / 52 / 79 ms | 65 / 65 / 61 ms | -18 ms |

Best-case assembly delta +7 ms; graded assembly delta 0 ms — the per-turn figure that sets the turn grade.

Measured as step_start to the first step_end on that turn, against local fixture endpoint, no network call.

## Context tax

| Field | Baseline | Subject | Delta |
| --- | --- | --- | --- |
| Model-visible chars | 24945 | 25249 | +304 |
| · system prompt | 2758 | 2826 | +68 |
| · tool schemas | 20369 | 20605 | +236 |
| · conversation | 1818 | 1818 | 0 |
| Estimated tokens | 6237 | 6313 | +76 |
| Harness extension fields | 34142 | 34497 | +355 |

Measured as model-visible bytes of the request the harness sent (system + tools + messages), tokens at 4 chars/token. Extension fields are request metadata the harness sends beside the model-visible prompt; they are listed separately and excluded from the token estimate.

## Capability surface

| Added | Detail |
| --- | --- |
| Tools | `fixture_echo` (235 schema chars) |
| Prompt sections | `tool:fixture_echo` (66 chars) |
| Event listeners | `tools/pre-execute` +1, `session/start` +1 |
| Loader entries | `@local/rc-fake-plugin` |
| Subject entry phase | active |
| Prompt variables | none |
| Profile size | 101 → 102 entries |

## Static risk flags

| Level | Flag | Detail |
| --- | --- | --- |
| high | `install-scripts` | runs code during install: postinstall |
| medium | `file-write` | writes to the filesystem |
| info | `network-hosts` | 1 host referenced: collector.example.test |

Evidence:
- `file-write` — index.js: `const writeReport = (file) => fs.writeFileSync(file, uploadUrl)`

## Notes

- Step samples vary by 67.1%; treat deltas below that as noise.

## Method and limits

Measured on win32-x64, 8 CPUs, dsh 0.2.2-rc.1, Node v24.19.0.

- Profile: `headless` template, fresh profile copied from a shipped template, fresh DSH_HOME per report.
- Isolation: empty workspace directory, read-only file policy; the subject never touches your real profile.
- The subject still runs with your user privileges inside that disposable process. Read the risk flags before installing anything you did not write.
- Numbers are comparable only on the same machine identity; the digest changes whenever any number does.

## Reproduce

```
node harness/cli.mjs "./test/fixtures/fake-plugin" --samples 3
```

Digest: `sha256:55ffdbf5e230a5fbc258445d58a126290e97e0e2c47fe8cfbaae36bd122918c3`

Generated 2026-11-10T16:27:44.348Z by `dsh-report-card` (dsh-report-card/1).
