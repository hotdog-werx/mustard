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
          shard: test

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

## Roll out in stages

Add Mustard to an existing repository in three steps, so the first enforced PR
already has a baseline and the policy you chose.

1. **Open the adoption PR without enforcement.** Add the workflow and
   `.github/mustard.yml`, but leave `fail-ci` unset and do not require any
   Mustard check yet. The PR usually changes only CI files, so `mustard/patch`
   reports that no coverable lines changed and `mustard/project` stays neutral
   without a baseline.
2. **Merge it.** The push run on the default branch stores the first baseline
   report and signs it where GitHub supports attestations. From then on, the
   project check compares each PR with that baseline.
3. **Enforce the checks.** Once a PR has received the checks, require them in
   the repository's branch ruleset using one of these approaches:
   - Require `mustard/project` and `mustard/patch`. If the ruleset specifies an
     expected source, choose the GitHub Actions app that posted the checks.
   - Require a single aggregate job instead. Set `fail-ci: true` on the
     aggregation step so a failed coverage check also fails its job, then make
     one final job `needs` every other job and fail if any of them failed.

Mustard reads the policy from the PR's merge base, so a PR cannot loosen its own
gate. The adoption PR is judged by the defaults, including the 100% patch
target, and your `.github/mustard.yml` applies only after it reaches the default
branch. Change targets the same way: merge a PR that lowers a target or sets
`informational: true` before the PRs that need it.
[Config source](configuration.md#artifacts-and-provenance)

If the adoption PR also adds a lot of code, such as a new project's first
import, its patch includes all of that code and can fail the default target.
Merge it before enabling enforcement, or cover the new code first.

GitHub treats neutral checks as passing. Set `baseline.required: true` if a
missing baseline should block an automatic project target. Without `fail-ci`, a
failed coverage check does not fail the aggregation step itself.
[GitHub required-check behavior](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)

Use the
[fork PR recipe](github-actions/workflow-recipes.md#report-on-fork-pull-requests)
if your repository accepts contributions from forks.
