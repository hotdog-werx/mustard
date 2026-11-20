# Troubleshooting

## No verified baseline available

The default project check is neutral until an eligible push has produced a
baseline. Check that the expected workflow ran on the default branch, or on a
protected branch allowed by `baseline.trusted_branches`. Look for the
`mustard-report-…` artifact on that run and review any baseline rejection
warnings in the current job. Expired artifacts are skipped. The patch check can
still run.
[Baseline eligibility and retention](concepts/storage.md#which-reports-can-become-baselines)

## No coverage uploads found for this attempt

Check the test job's logs and artifact list. Confirm that the coverage tool
wrote the file matched by the `files` input and that the upload and report steps
use the same `name`. Use **Re-run all jobs** for matrix retries so each shard
uploads to the new attempt. Set `require_uploads: true` if this should fail the
coverage checks. [Upload inputs](github-actions/action.md#inputs)

## Patch coverage is lower than the test tool's line percentage

The patch score covers changed, coverable lines. Mustard counts a hit line with
an uncovered branch as partial. Check the line annotations for those branches.
If annotations point to the wrong lines, confirm the report uses repo-relative
source paths and that the test job ran against the code being diffed. If the
synthetic PR merge checkout shifts line numbers, check out
`github.event.pull_request.head.sha` for PR test jobs.
[Coverage formats and path mapping](configuration.md#coverage-inputs-and-paths)

## The PR changes coverage configuration but the checks use the old policy

The merge base controls gating by default. For a same-repository PR, you can
choose `config-source: head` in the report step or set `config.source: head` in
trusted configuration. Fork PRs always use the merge base.
[Action configuration inputs](github-actions/action.md#inputs)

## The check or comment is missing on a fork PR

The unprivileged PR workflow can upload reports. Install the separate
`workflow_run` workflow on the upstream default branch, verify that its
`workflows` list matches the first workflow's display name, and check that it
has the write permissions listed in the recipe.
[Fork PR workflow](github-actions/workflow-recipes.md#report-on-fork-pull-requests)

## GitHub returned an incomplete diff

Mustard first tries to compare the fetched Git objects locally. If that is
unavailable, it falls back to GitHub's Compare API. An incomplete comparison
fails the patch check. Check the report job's warnings for the reason local
diffing failed and ensure Git and repository read access are available to it.
