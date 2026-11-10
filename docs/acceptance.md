# Acceptance evidence

This file records what was actually measured when the v1 was built, on this
machine, so the claims in the README can be checked rather than trusted.

Machine: win32-x64, 8 logical CPUs, dsh 0.2.2-rc.1, Node v24.19.0 for the
harness and Electron 44.7.0's Node v24.21.0 for the measured children.

**The machine was not quiet.** A DeepSeek Harness Web session was running and
actively issuing commands throughout, and several other builds shared the
machine. That matters for the numbers below and is stated again where it
changes their meaning.

## 1. Same plugin, two runs

Command:

```powershell
node harness/repeat.mjs ./test/fixtures/fake-plugin --runs 2 --samples 3
```

Result (raw output, 2026-11-10, final code):

```
metric                        run 1    run 2    spread   % of baseline
boot CPU graded delta           0        0        0.0       0.00%
boot CPU raw delta            -62     -172      110.0       4.24%
boot wall graded delta        11.8      0       11.8       0.54%
boot paired median delta      50.6     31.8      18.8       0.86%
boot best-case delta          50.6    150.8     100.1       4.58%
assembly graded delta          0.6      0        0.6       1.90%
assembly paired median delta     5     -3        8.0      24.24%
assembly best-case delta         3     -5        8.0      24.24%
step best-case delta             7     -7       14.0      29.79%
context token delta             76     76        0.0       0.00%
baseline boot (median)       2186.1   2267.2     81.1       3.71%
baseline assembly (median)      33       41        8.0      24.24%

worst spread on a graded delta: 1.90% of its baseline (target: under 5%)
PASS
```

Reading:

* The **context delta is exact** (identical bytes, identical tokens) because the
  prompt is a function of the profile, not of the machine.
* The **graded deltas repeat inside 1.9% of their baseline**: boot CPU 0.00%,
  assembly 1.90%. Both grades are noise-adjusted, so the fixture plugin (which
  contributes one tool, one prompt section and two listeners) grades A in both
  runs.
* The **raw wall-clock deltas** also repeated well in this run — the round-paired
  boot median moved 0.86%, the boot best case 4.58% — but that is luck, not a
  guarantee: earlier in the same session, on a busier machine, baseline boot
  medians moved by 19% between cards. The card prints its jitter and noise floor
  so a reader can tell which situation they are in.
* `step` (the whole `step_start → step_end` window) is the noisiest figure at
  30% of a ~45 ms baseline; that is why it is reported but not graded. `assembly`
  — the phase plugin hooks actually run in — is five times steadier.

## 2. A measured plugin cannot touch the real profile

Every report runs in a fresh tree and points the child at it:

* `DSH_HOME` is a new `%TEMP%\dsh-report-card-*` directory, removed after the
  report unless `--keep` is passed.
* The profile is a fresh copy of the shipped `headless` template under that
  home; the subject is copied or installed into *that* profile's
  `node_modules`.
* The working directory is an empty `workspace` directory under the same temp
  tree.
* The probe records the state it actually saw. A real card contains:

```json
"measuredEnvironment": {
  "home": "C:\\Users\\conta\\AppData\\Local\\Temp\\dsh-report-card-XXXXXXXX\\home",
  "cwd":  "C:\\Users\\conta\\AppData\\Local\\Temp\\dsh-report-card-XXXXXXXX\\workspace"
}
```

so the isolation is part of the evidence, not a promise. `~/.dsh` is never
passed to the child; the parent harness process never imports the subject.

The one thing this does **not** do is sandbox the subject from the operating
system: it runs as your user inside that disposable process. The README says so
and the card lists the static risk flags before you install anything.

## 3. Every number is reproducible from a command

* The card prints its own command in the **Reproduce** section, e.g.
  `node harness/cli.mjs "./test/fixtures/fake-plugin" --samples 3`.
* `harness/cli.mjs --json` prints the same card as JSON, including every sample
  and the digest.
* `harness/repeat.mjs` runs a card N times and prints the spread (section 1).
* A card's `digest` is the SHA-256 of the canonical JSON with the digest field
  removed; `digestReport()` in `harness/report.mjs` recomputes it, and
  `test/unit.test.mjs` proves the round-trip.

## 4. `node test/*.mjs` covers the harness with fake plugins

```
$ node test/unit.test.mjs
12 passed, 0 failed

$ node test/harness.test.mjs
ok   a fake plugin gets a complete, measured card
ok   a plugin that fails to start is a failed card, not a crash
ok   a plugin that kills the host is a failed boot, bounded
ok   the second card compares with the first one for drift

4 passed, 0 failed
```

The end-to-end test asserts the fixture's exact capability surface
(`fixture_echo`, `tool:fixture_echo`, the `tools/pre-execute` listener, the
loader entry and its `active` phase), the risk flags (install script, network
host), the digest, the saved files, the failed-card path for a plugin that
throws in `apply()`, the failed-boot path for a plugin that calls
`process.exit()`, and drift on the second card.

## 5. What v1 does not claim

* Cross-machine comparability. Cards record the machine identity and are only
  comparable within it.
* Multi-turn, compaction, or client-side cost. One scripted turn, host side.
* Sandboxing the subject. See section 2.
* Billing-grade tokens. The estimate is the shipped token meter's documented
  4-characters-per-token heuristic; CJK and JSON schemas are underpriced.
