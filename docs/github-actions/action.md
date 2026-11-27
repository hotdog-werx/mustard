# Action reference

Use `hotdog-werx/mustard@<mustard-commit-sha>` in a workflow step. The action
defaults to `report`.

## Modes and permissions

| Mode      | Where it runs                                                | Permissions                                                                                                                       |
| --------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `upload`  | Each test job that produces coverage                         | `contents: read` for configuration. The runner provides the artifact upload credentials.                                          |
| `report`  | A job that depends on the test jobs                          | `contents: read` and `actions: read` for configuration, comparison, and artifacts.                                                |
| `comment` | A trusted workflow triggered by a completed fork PR workflow | `contents: read`, `actions: read`, `checks: write`, `pull-requests: write`, and `attestations: read` when verifying attestations. |

For `report` on same-repository PRs, add `checks: write` and
`pull-requests: write` when posting results. Verifying attestations requires
`attestations: read`. Signing reports on trusted pushes requires
`id-token: write` and `attestations: write`. Badge publishing requires
`contents: write` on the default-branch push job. See
[workflow recipes](workflow-recipes.md) for example permission blocks.

## Inputs

| Input            | Modes           | Default or behavior                                                                                                                                     |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`           | All             | `report`. Also accepts `upload` and `comment`.                                                                                                          |
| `github-token`   | All             | `github.token` from the workflow.                                                                                                                       |
| `name`           | All             | Optional namespace for artifacts, checks, the sticky comment, and the badge branch.                                                                     |
| `files`          | Upload          | Newline-separated globs. Searches for common coverage report filenames when omitted.                                                                    |
| `format`         | Upload          | `auto`, `cobertura`, `lcov`, `coveragepy-json`, `go`, or `jacoco`.                                                                                      |
| `flag`           | Upload          | `default`. Set a flag to group reports from one logical suite.                                                                                          |
| `shard`          | Upload          | Stable upload ID within a flag for merging coverage across retries. Use 1–64 letters, digits, hyphens, or underscores, starting with a letter or digit. |
| `root`           | Upload          | Absolute or repo-relative prefix to strip from paths reported by the coverage tool.                                                                     |
| `path-fixes`     | Upload          | Newline-separated `from:to` or `from::to` prefix rewrites.                                                                                              |
| `strict-paths`   | Upload          | `false`. Set `true` to fail if a source path is absent from the checkout.                                                                               |
| `config`         | All             | Repo-relative path to an explicit configuration file. Otherwise uses the [configuration discovery order](../configuration.md).                          |
| `config-source`  | Report          | Overrides `base` or `head` on same-repository PRs. Forks use the merge base.                                                                            |
| `workflow`       | Report, comment | Workflow file to accept for baseline artifacts. Defaults to the current or triggering workflow file.                                                    |
| `run-id`         | Comment         | If supplied, it must match the completed run that triggered the workflow.                                                                               |
| `fail-ci`        | Report, comment | `false`. When enabled, a non-informational coverage failure also fails the action step.                                                                 |
| `retention-days` | All             | Uses the repository's Actions retention policy unless overridden.                                                                                       |

Pass the same `name` when uploading or consuming reports for a namespace. For
`name: api`, the default patch check becomes `mustard[api]/patch`.

## Outputs

`report` and `comment` expose the outputs below. Assign an `id` to the action
step to reference them in the same job.

| Output                   | Value                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `project-coverage`       | Project coverage as a percentage. Empty without uploads.                                               |
| `project-delta`          | Project coverage difference from the baseline, in percentage points. Empty when it cannot be computed. |
| `patch-coverage`         | Coverage of changed coverable lines as a percentage. Empty for pushes or without uploads.              |
| `patch-hits`             | Number of fully covered changed lines.                                                                 |
| `patch-total`            | Number of changed coverable lines.                                                                     |
| `baseline-sha`           | Commit SHA of the verified baseline, if available.                                                     |
| `project-status`         | Conclusion of the default project check, if configured.                                                |
| `patch-status`           | Conclusion of the default patch check, if configured for the event.                                    |
| `report-artifact-id`     | GitHub Actions artifact ID of the normalized coverage report, if published.                            |
| `missing-required-flags` | Comma-separated required flags with no upload or carried-forward coverage. Empty when complete.        |
