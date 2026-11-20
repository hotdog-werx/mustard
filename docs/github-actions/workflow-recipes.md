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
shards in one suite. Give distinct suites different flags if you want separate
checks or badge files.

```yaml
- uses: hotdog-werx/mustard@<mustard-commit-sha>
  if: always() && !cancelled() && hashFiles('lcov.info') != ''
  with:
    mode: upload
    files: lcov.info
    flag: frontend
```

Keep a single report job with `needs` covering all test jobs. **Re-run failed
jobs** and **Re-run all jobs** both work. Each flag uses its uploads from the
newest attempt that produced it, so shards that were not rerun still count. If
you rerun only some shards of one flag, rerun all of that flag's jobs, because a
newer attempt replaces the flag's older uploads. For path-filtered suites, see
[flag settings and carryforward](../configuration.md#flags-and-components).

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
