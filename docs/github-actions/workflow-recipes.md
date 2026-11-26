# Workflow recipes

Start with the [basic CI workflow](../quick-start.md). The recipes below show
where to change it for fork PRs, matrix tests, and optional outputs.

## Report on fork pull requests

The fork's `pull_request` workflow uploads coverage and can write a step
summary. A second workflow on the upstream default branch recomputes the results
and posts the checks and comment.

Save this as `.github/workflows/mustard-comment.yml`. Use the same action SHA
and `name` input as the upload workflow. Set `workflows` to the upstream
workflow's display name.

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
      - uses: hotdog-werx/mustard@<mustard-commit-sha>
        with:
          mode: comment
```

Run the privileged workflow from the trusted upstream branch. It can run without
checking out code. Mustard reads the merge-base configuration and recomputes
checks from normalized coverage inputs. Fork code supplies those measurements,
so keep any independent test and review requirements.
[Storage and trust](../concepts/storage.md#which-reports-can-become-baselines)

## Combine test shards or suites

Upload a report in every matrix job that runs tests. Use the same `flag` for
shards in one suite and a distinct, stable `shard` ID for each upload. Give
distinct suites different flags if you want separate checks or badge files.

```yaml
- uses: hotdog-werx/mustard@<mustard-commit-sha>
  if: always() && !cancelled() && hashFiles('lcov.info') != ''
  with:
    mode: upload
    files: lcov.info
    flag: frontend
    shard: node-${{ matrix.node }}
```

Include all matrix dimensions needed to distinguish uploads in the ID. Keep a
single report job with `needs` covering all test jobs. Mustard uses the newest
upload for each shard and keeps the previous uploads for jobs that did not
rerun. A report-only retry can also reuse unkeyed uploads from a single attempt.
If the same flag has unkeyed uploads across attempts, the report fails because
it cannot tell which uploads to replace. Add shard IDs and start a new run. For
path-filtered suites, see
[flag settings and carryforward](../configuration.md#flags-and-components).

Suites in different languages can share a report. Mustard merges Cobertura,
LCOV, and the other formats by repository path and line, so the project and
patch results cover every suite. Upload each suite with its own flag in the same
namespace, and mark the suites that every run must include as required:

```yaml
flags:
  python: { paths: [src/**], required: true }
  cpp: { paths: [windows/**], required: true }
```

Run the report job after every producer, even one that failed, so the summary
can name a suite that did not upload:

```yaml
coverage:
  needs: [python-tests, windows-tests]
  if: always() && !cancelled()
```

When a required flag has no upload, the report is incomplete. The summary and PR
comment name the missing flag, checks without a `flags` filter fail, and
`fail-ci` fails the step. The badge and baseline keep their last complete
values. Checks filtered to the suites that reported still give their usual
result. The flags table lists each suite's project and patch coverage, its
covered lines, and whether it was uploaded, carried forward, or missing.

To gate each suite's patch separately, add named patch checks with a `flags`
filter, such as `cpp: { flags: [cpp], target: 90% }`.

When you add a required flag, earlier baselines lack it, so Mustard skips them.
Project checks with an `auto` target use `if_no_baseline` until a complete
default-branch run publishes a new baseline.

## Publish a badge

Add the following to the default branch's `.github/mustard.yml`.

```yaml
badge:
  enabled: true
  branch: mustard-badges
```

Give the report job `contents: write` for default-branch pushes. Keep the
coverage workflow path the same as the workflow used for baseline lookup. Once a
push reports coverage at the tip of the default branch, a public repository can
embed the SVG in its README.

```markdown
![Coverage](https://raw.githubusercontent.com/OWNER/REPO/mustard-badges/badge.svg)
```

Use the configured branch in the URL if you change `badge.branch`. For a
namespace or a per-suite badge, see the
[badge branch file layout](../concepts/storage.md#badge-branch).

## Download an HTML coverage report

Set `html.enabled: true` in the repository configuration. To include source text
in a same-repository report, add a checkout step before invoking Mustard in the
report job. Open the **HTML report** artifact linked in the workflow summary,
download it, and open the archive's `index.html`. Fork PR report jobs omit
source text. The privileged `comment` mode skips HTML generation.
