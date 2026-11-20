# Mustard

**Every line covered.** Mustard is a GitHub Action for project and patch
coverage. It stores coverage in Actions artifacts and publishes checks,
annotations, a step summary, and a sticky PR comment. It uses the workflow's
`GITHUB_TOKEN`.

See the [docs index](docs/index.md) for workflow recipes, troubleshooting, and
[what Mustard stores](docs/concepts/storage.md).

## Quick start

Produce a coverage report in your test job. Add an upload step in each matrix
leg and a single aggregation job. Replace `<commit-sha>` with the full SHA of
the Mustard release you use, and change `main` to your default branch.

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
  merge_group:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: python -m pip install pytest pytest-cov
      - run: python -m pytest --cov --cov-report=xml
      - uses: hotdog-werx/mustard@<commit-sha>
        if: always() && !cancelled() && hashFiles('coverage.xml') != ''
        with:
          mode: upload
          files: coverage.xml

  coverage:
    needs: [test]
    if: always() && !cancelled()
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
      checks: write
      pull-requests: write
      id-token: write
      attestations: write
    steps:
      - uses: hotdog-werx/mustard@<commit-sha>
```

The default project check compares coverage to the newest verified baseline and
reports neutral until one exists. The patch check requires **100% of changed
coverable lines**. Partially covered branches count against both percentages.
Set `require_uploads: true` to fail coverage checks when nothing was uploaded.
Each flag uses its uploads from the newest run attempt that produced it, so
**Re-run failed jobs** works. Rerun all of a flag's shards together.

Add `mustard/project` and `mustard/patch` as required checks in your branch
ruleset after the checks have appeared on a PR. Select **GitHub Actions** as the
expected source if you restrict the source. GitHub treats neutral as passing.
The aggregation step stays green for a coverage failure unless you set
`fail-ci: true`.
[GitHub required-check behavior](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)

## Fork pull requests

A fork's read-only `pull_request` workflow can upload coverage and write a step
summary. Install a second workflow on the default branch to recompute its report
and write the checks and comment. Replace `CI` with the upstream workflow's
`name` and use the same action SHA and `name` input in both workflows.

```yaml
name: Mustard fork coverage
on:
  workflow_run:
    workflows: [CI]
    types: [completed]

permissions:
  contents: read
  actions: read
  checks: write
  pull-requests: write
  attestations: read

jobs:
  coverage:
    if: github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.head_repository.full_name != github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: hotdog-werx/mustard@<commit-sha>
        with:
          mode: comment
```

The privileged job can run without a checkout. It resolves an open PR by the
triggering run's head repository, branch, and SHA, loads the merge-base config
through the API, and recomputes coverage from normalized uploads. Fork code
controls the measurements and may fabricate them. Keep your normal test and
review requirements alongside the coverage checks.

## Configuration

Add `.github/mustard.yml` and use the [JSON Schema](mustard.schema.json) for
editor validation. See the [configuration reference](docs/configuration.md) for
the supported Codecov subset, artifact trust rules, flags, and optional output.

```yaml
require_uploads: true
ignore: [tests/**]
coverage:
  status:
    project:
      default:
        target: auto
        threshold: 0.5%
    patch:
      default:
        target: 100%
```

### Action inputs

| Input            | Modes           | Default or behavior                                                                         |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `mode`           | All             | `report`, `upload`, or `comment`                                                            |
| `github-token`   | All             | The workflow's `github.token`                                                               |
| `name`           | All             | Optional namespace. For example, `api` yields `mustard[api]/patch`.                         |
| `files`          | Upload          | Newline-separated globs. Recognizes common report names in the workspace root when omitted. |
| `format`         | Upload          | `auto`, `cobertura`, `lcov`, `coveragepy-json`, `go`, or `jacoco`                           |
| `flag`           | Upload          | `default`. Use one per logical suite. Matrix variants may share a flag.                     |
| `root`           | Upload          | Repo-relative or absolute prefix to strip from coverage paths                               |
| `path-fixes`     | Upload          | Newline-separated `from:to` or `from::to` rewrites                                          |
| `strict-paths`   | Upload          | `false`. Set to `true` to fail on unmatched source paths.                                   |
| `config`         | All             | Explicit repo-relative config path                                                          |
| `config-source`  | Report          | Same-repo PR override of `base` or `head`                                                   |
| `workflow`       | Report, comment | Baseline workflow path. Defaults to the current or triggering workflow, respectively.       |
| `run-id`         | Comment         | Must match the triggering run ID if set.                                                    |
| `fail-ci`        | Report, comment | `false`. Fails the step on a failed check when enabled.                                     |
| `retention-days` | All             | Repository artifact retention policy                                                        |

Report and comment modes expose `project-coverage`, `project-delta` (percentage
points), `patch-coverage`, `patch-hits`, `patch-total`, `baseline-sha`,
`project-status`, `patch-status`, and `report-artifact-id`.

## Development

Use `mise trust` and `mise install` to install Node 24, the locked Devkit
workspace provider, and the local npm dependencies. Run `mise run check` and
`npm run build` before committing. The workflow runs Devkit's shared repository
checks and checks that rebuilding reproduces the committed bundle.

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
