# Publishing DSH Report Card

There are three publication surfaces, and they depend on each other in order:

1. **npm** — `npm publish`. Everything else needs it: the plugin manager
   installs by npm spec, and the plugin market only lists a version that exists
   on a registry with a publish time.
2. **The community catalog** — [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
   One YAML file per entry; its CI generates the list, the site, and the market
   index (`https://awesome-dsh-plugin.com/index.json`).
3. **Your own index (optional)** — a format-1 JSON document you host; users add
   it as an index source in Plugins → Discover.

The rest of this file is the exact sequence for this package. Release state
(2026-11-10):

| Surface | State |
|---|---|
| npm | `dsh-report-card@1.0.0` published (publisher `init3`), 25 files, 139 kB unpacked |
| GitHub | <https://github.com/tespio/dsh-report-card>, tag `v1.0.0` |
| Registry acceptance | `node harness/cli.mjs dsh-report-card@1.0.0 --samples 3` installs from npm, registers `report_card`, entry `active` |
| Live profile | installed from the registry (`"dsh-report-card": "1.0.0"`), entry active |
| Catalog | **pending** — add `data/plugins/tespio__dsh-report-card.yml` from [`catalog-entry.yml`](catalog-entry.yml) |

## 0. Create the repository

Already done for 1.0.0; kept as the initial-setup reference. The catalog entry
points at a `https://github.com/owner/repo` URL, and the catalog's npm probe only
maps a package whose own `repository` field points back at that repo. So the repo
is not optional bookkeeping — it is the link between the catalog entry and the
npm package.

```powershell
cd dsh-report-card
git init
git add .
git commit -m "dsh-report-card 1.0.0"
git branch -M main
git remote add origin https://github.com/tespio/dsh-report-card.git
git push -u origin main
```

Then keep the repository fields in `package.json` pointing at it (they are
already set for `tespio/dsh-report-card`; update them if the repository moves):

```json
"repository": { "type": "git", "url": "git+https://github.com/tespio/dsh-report-card.git" },
"homepage": "https://github.com/tespio/dsh-report-card#readme",
"bugs": { "url": "https://github.com/tespio/dsh-report-card/issues" }
```

`assets/icon-96.png` is already generated and kept with the source for the
catalog; the bundle keeps using the vector `icon.svg` for its in-app tile.

## 1. Publish to npm

```powershell
npm login                 # once per machine
npm whoami                # must print your npm user name
npm view dsh-report-card  # 404 before the very first publish; already published as 1.0.0
npm test                  # unit + end-to-end; prepublishOnly also runs the units
npm publish --access public
```

`npm publish` runs `prepublishOnly` (unit tests), packs the `files` list, and
uploads. What ships is exactly what the tarball test above measured:

* `index.js`, `cordis.patch.yml`, `harness/**`, `harness/probe/**`,
  `locale/*.json`, `icon.svg`, `docs/*.md`, README, LICENSE;
* **not** `test/`, `report-cards/`, `.ref/`, or any tarball.

Verify the published artifact, not just the local directory:

```powershell
npm view dsh-report-card@1.0.0 version dist.tarball dist.integrity
node harness/cli.mjs dsh-report-card@1.0.0 --samples 3   # installs from the registry into a throwaway profile
```

That last command is the full acceptance test of the publication: it resolves
the package from npm, installs it into a fresh profile, boots it, and reports
its surface. A passing card here means a user can install what you published.

Future releases:

```powershell
npm version patch        # or minor / major; never reuse a version
git push --follow-tags
npm publish --access public
```

**Provenance (recommended).** Publishing from GitHub Actions with
`npm publish --provenance` attaches a signed build attestation. Add a workflow
with `permissions: id-token: write`, `actions/setup-node@v4` configured with
`registry-url: https://registry.npmjs.org`, and `NODE_AUTH_TOKEN:
${{ secrets.NPM_TOKEN }}` (or npm Trusted Publishing, no token), triggered on
`v*` tags. The local `npm publish` above needs no workflow; provenance is a
supply-chain nicety, not a requirement.

## 2. Add the catalog entry

Fork [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
add **one file** at `data/plugins/tespio__dsh-report-card.yml`, and open a PR.
The filename is `slugFor(url)` — `owner__repo` with the dots/slashes as shown;
the build fails if it does not match the `url`. [`docs/catalog-entry.yml`](catalog-entry.yml)
in this repository is exactly that file, ready to copy.

```yaml
url: https://github.com/tespio/dsh-report-card
name: DSH Report Card
category: dev
description:
  en: Measures what a DSH plugin costs — boot delta, per-turn overhead, context tax, capability surface and risk flags — in a throwaway profile.
  zh: 在一次性 profile 中实测插件的启动增量、单轮开销、上下文税、能力面与风险标记，并生成可复现的体检报告。
icon: https://raw.githubusercontent.com/tespio/dsh-report-card/main/assets/icon-96.png
```

Rules the PR check enforces (from `scripts/lib/entries.mjs`):

* `url` is the GitHub repository; `name` is the link text and must not claim a
  different `owner/repo` (a bare display name is fine).
* `category` is one of `agi, ui, usage, theme, model, identity, session, memory,
  tools, wsl, browser, vision, voice, docs, skill, workflow, git, notify, dev,
  security, remote, market, fun` — `dev` is the right shelf for this.
* `description.en` is one line; `zh` is optional, and a locale the site does not
  render is rejected.
* `icon` is optional and must be a **raster** image on GitHub hosting
  (`raw.githubusercontent.com` / `user-images.githubusercontent.com` /
  `camo.githubusercontent.com` / `github.com`, `.png/.jpg/.jpeg/.webp`) — that is
  why `assets/icon-96.png` exists next to the SVG; the SVG is not eligible here.
* Only `url`, `name`, `category`, `description`, `icon`, `tarball` are read;
  any other key is rejected.

Publish on npm **before** opening the PR: the market index includes an entry
only when the npm registry has the package, an exact version, and a publish
time, and the npm probe only records the mapping when the package's
`repository` points back at the listed repo. `engines.dsh` from
`package.json` becomes the version's compatibility range in the index — this
package declares `>=0.2.2-rc.1 <0.3.0`; widen it only after testing a newer
runtime.

What the merge gives you: a row and page on awesome-dsh-plugin.com, an entry in
`plugins.json`, and a version in `https://awesome-dsh-plugin.com/index.json`
that DSH's Discover tab reads (once the user adds that index URL — no index is
configured by default). The install command the catalog publishes is
`dsh plugin --profile web add dsh-report-card`.

## 3. Your own market index (optional)

If you would rather not wait for a catalog PR — or you want a private index —
ship a format-1 document and serve it. The cheapest host is jsDelivr over the
npm package itself: add an `index.json` to the package's `files`, bump, publish,
and the URL is
`https://cdn.jsdelivr.net/npm/dsh-report-card/index.json`.

Minimal format 1 document (validated by `@deepseek-ai/dsh-plugin-market-index`,
the same parser DSH uses):

```json
{
  "format": 1,
  "title": { "en": "DSH Report Card" },
  "description": { "en": "Independent dynamic plugin benchmarks." },
  "plugins": [{
    "name": "dsh-report-card",
    "title": "DSH Report Card",
    "description": { "en": "Measures what a DSH plugin costs in a throwaway profile." },
    "metadata": { "category": "dev" },
    "versions": [{
      "version": "1.0.0",
      "publishTimestamp": 1762790000000,
      "source": { "type": "npm" },
      "engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" }
    }]
  }]
}
```

Users add that URL under Plugins → Discover → index sources (or Settings), and
`plugin_market` can then search it; installs go through
`plugin_manager.install_bundle` with `target: "dsh-report-card@1.0.0"`.

## 4. Release checklist

- [ ] `npm test` passes (unit + real harness boots)
- [ ] version bumped, `git tag v<version>` pushed
- [ ] `npm pack --dry-run` lists the probe and `harness/**`, and nothing from
      `test/` or `report-cards/`
- [ ] packed tarball installs and measures: `node harness/cli.mjs <tgz> --samples 3`
- [ ] `npm publish --access public`
- [ ] `npm view` shows the version; `node harness/cli.mjs dsh-report-card@<version> --samples 3` passes
- [ ] catalog PR updated only when the listed name, category, icon, or repo moves

Rollback:

* npm: `npm deprecate dsh-report-card@<version> "reason"` (unpublish is only
  allowed within 72 hours and breaks lockfiles — prefer deprecate plus a fixed
  release).
* Profile: `plugin_manager remove_bundle target: "dsh-report-card"` removes the
  dependency and the bundle row.
* Catalog: open a PR removing `data/plugins/tespio__dsh-report-card.yml`; the
  next build delists the page, `plugins.json`, and the index entry together.

## Notes specific to this plugin

* The package intentionally has **no `peerDependencies`** on `@deepseek-ai/*`:
  it imports no harness package at runtime (the tool talks to the harness only
  through `ctx.tools`, and the measuring child is spawned from the shipped CLI).
  The plugin-manager install gate therefore never rejects it for peer reasons;
  `engines.dsh` is the declarative compatibility range the market displays.
* `prepublishOnly` runs the unit suite because the end-to-end suite takes ~80 s
  and boots the local harness — too expensive for every publish, and the npm
  tarball test above covers the installed artifact.
* Its own report card grades it **D** on risk: it legitimately spawns
  subprocesses, writes reports, reads the environment, and starts a loopback
  HTTP server. That is the tool working, not a defect — which is also a good
  reason to publish the card next to the version notes.
