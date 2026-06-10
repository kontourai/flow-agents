# Contributing

This file is intentionally short.

The main docs in this repo are written for people installing and using Flow
Agents. This file is the footnote for people developing the product itself.

## Development Rules

- keep the core product generic — no machine-specific paths, usernames, or
  private workspace assumptions in tracked source
- the public bundle ships the `core` and `development` packs; keep new work
  inside that scope
- prefer install/use clarity over maintainer cleverness
- update the relevant docs, `packaging/packs.json`, and `packaging/manifest.json`
  whenever you add or remove a skill, agent, or power
- keep `docs/context-map.md` current with `npm run context-map`
- run `npm run build && npm run validate:source && bash evals/ci/run-baseline.sh`
  before opening a PR

## Docs Site Preview

The GitHub Pages site is built from `docs/` by the `Publish Docs` workflow
using Jekyll. To preview locally, install Jekyll 3.9 with the github-pages
default plugins and build into the ignored `_site/` directory:

```bash
gem install --user-install jekyll -v 3.9.5 jekyll-optional-front-matter \
  jekyll-relative-links jekyll-readme-index jekyll-titles-from-headings \
  kramdown-parser-gfm
"$(ruby -e 'print Gem.user_dir')/bin/jekyll" build --source docs --destination _site
```

Set `FLOW_CLI_ROOT` to a Flow checkout or installed `@kontourai/flow` package
root to enable full Flow Definition validation in `npm run validate:source`.

## Validation

- `npm run validate:source` — source-tree integrity (paths, packs, manifests)
- `npm run context-map:check` — context map is current
- `bash evals/ci/run-baseline.sh` — deterministic CI baseline
- `npm run check:content-boundary` — no private/internal content leaks

All projects are Apache-2.0.
