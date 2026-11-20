# Quick start

This example runs Python tests and uploads a Cobertura report. If you already
produce coverage, keep your test step and pass the report to Mustard. See
[supported formats](configuration.md#coverage-inputs-and-paths).

Add `.github/workflows/ci.yml`. Replace `<mustard-commit-sha>` with the full
commit SHA of a Mustard release and replace `main` with your default branch.

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
        with:
          persist-credentials: false
      - run: python -m pip install pytest pytest-cov
      - run: python -m pytest --cov --cov-report=xml
      - uses: hotdog-werx/mustard@<mustard-commit-sha>
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
      - uses: hotdog-werx/mustard@<mustard-commit-sha>
```

## Set your coverage policy

Store this in `.github/mustard.yml` if the workflow should fail its coverage
checks whenever the current run has no uploads. Keep `tests/**` only if you want
to exclude those paths.

```yaml
require_uploads: true
ignore: [tests/**]
coverage:
  status:
    project:
      default:
        target: auto
    patch:
      default:
        target: 100%
```

The patch check measures changed coverable lines and defaults to 100%. A line
with an uncovered branch counts as partially covered. The default project check
compares the whole project with a verified baseline. It is neutral until Mustard
finds an eligible default-branch report with the configured provenance
requirements.

## Require the checks before merging

After a PR has received the checks, add `mustard/project` and `mustard/patch` to
the repository's branch ruleset. If a ruleset specifies an expected source,
choose the GitHub Actions app that posted the checks. GitHub treats neutral
checks as passing. Set `baseline.required: true` if a missing baseline should
block an automatic project target.

By default, a failed coverage check does not fail the aggregation step itself.
Set `fail-ci: true` in that action step if you also want the job to fail.
[GitHub required-check behavior](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)

Use the
[fork PR recipe](github-actions/workflow-recipes.md#report-on-fork-pull-requests)
if your repository accepts contributions from forks.
