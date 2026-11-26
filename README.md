<p align="center">
  <img src="assets/mustard-social-preview.png" alt="Mustard: code coverage for GitHub Actions" width="640">
</p>

# Mustard

[![CI](https://github.com/hotdog-werx/mustard/actions/workflows/ci-checks.yaml/badge.svg?branch=master)](https://github.com/hotdog-werx/mustard/actions/workflows/ci-checks.yaml)
[![GitHub Release](https://img.shields.io/github/v/release/hotdog-werx/mustard)](https://github.com/hotdog-werx/mustard/releases/latest)
[![GitHub Actions runtime: Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](action.yml)
[![Coverage](https://raw.githubusercontent.com/hotdog-werx/mustard/mustard-badges/badge.svg)](https://github.com/hotdog-werx/mustard/actions/workflows/ci-checks.yaml?query=branch%3Amaster)

**Every line covered.** Mustard is a GitHub Action for project and patch
coverage gates. It keeps coverage in Actions artifacts and reports through
checks, annotations, a step summary, and a sticky PR comment, using only the
workflow's `GITHUB_TOKEN`.

## Documentation

Full documentation lives at
**[hotdog-werx.github.io/mustard](https://hotdog-werx.github.io/mustard/)**.

- [Quick start](https://hotdog-werx.github.io/mustard/quick-start/): add Mustard
  to a workflow and require its checks.
- [Configuration](https://hotdog-werx.github.io/mustard/configuration/):
  `.github/mustard.yml`, the supported Codecov subset, flags, and components.
- [Action reference](https://hotdog-werx.github.io/mustard/github-actions/action/):
  modes, permissions, inputs, and outputs.
- [Workflow recipes](https://hotdog-werx.github.io/mustard/github-actions/workflow-recipes/):
  fork pull requests, test shards, badges, and HTML reports.
- [Storage and trust](https://hotdog-werx.github.io/mustard/concepts/storage/):
  what Mustard stores and how it verifies baselines.
- [Troubleshooting](https://hotdog-werx.github.io/mustard/troubleshooting/)

Editors can validate the config with the [JSON Schema](mustard.schema.json).

## Development

Use `mise trust` and `mise install` to install Node 24, the locked Devkit
workspace provider, and the local npm dependencies. Run `mise run check` and
`npm run build` before committing. The workflow runs Devkit's shared repository
checks and checks that rebuilding reproduces the committed bundle. The linter
enforces a cognitive complexity limit of 15 in `src/`.

Run `mise run test-action` for the bundled action tests. CI also invokes the
action with `uses: ./` and checks its outputs and step result in the runner. See
the [action test guide](tests/action/README.md).

## Releasing

Set `RELEEZ_GITHUB_TOKEN` to a token that can open pull requests. From a clean
working tree, run `mise exec -- releez release start` to prepare a release PR
from `master`. For the first release, pass `--version-override 0.1.0` to match
the initial package version. Releez updates the changelog, bumps both npm
manifests, and rebuilds the action bundle before committing. Use `--dry-run` to
preview the version and notes.

Merging a same-repository `release/<version>` PR into `master` runs
`finalize-release.yaml`. The workflow checks the merged bundle, builds and
attests the action ZIP, and uses Releez to create the exact version tag and move
the major tag. It then publishes the GitHub Release with the ZIP and generated
notes. For example, release `0.1.0` uses the tag `0.1.0` and the moving alias
`v0`. Consumers can pin the release commit SHA in `uses:`.
