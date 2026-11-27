# Troubleshooting

## No verified baseline available

The default project check is neutral until an eligible push has produced a
baseline. Check that the expected workflow ran on the default branch, or on a
protected branch allowed by `baseline.trusted_branches`. Look for the
`mustard-report-…` artifact on that run and review any baseline rejection
warnings in the current job. Expired artifacts are skipped. The patch check can
still run.

Mustard only reads baselines from push runs of the report's workflow file. When
the walk finds none, the job log names the workflow file and the number of
commits searched. If a push run of another workflow file holds a report for a
searched commit, a warning names that file. Set the `workflow` input to it. See
[separate PR and push workflows](github-actions/workflow-recipes.md#separate-pr-and-push-workflows).
[Baseline eligibility and retention](concepts/storage.md#which-reports-can-become-baselines)

## Patch fails on the PR that adds Mustard

Mustard reads `.github/mustard.yml` from the PR's merge base. Until the config
reaches the default branch, the PR is judged by the defaults, which require 100%
patch coverage. A PR that adds both Mustard and new code can fail that target.
Merge the adoption PR before requiring the checks or setting `fail-ci: true`.
[Roll out in stages](quick-start.md#roll-out-in-stages)

## No coverage uploads found for this attempt

Check the test job's logs and artifact list. Confirm that the coverage tool
wrote the file matched by the `files` input and that the upload and report steps
use the same `name`. For retries, give each upload within a flag a unique,
stable `shard` ID. If a previous shard artifact expired or an unkeyed flag has
uploads across attempts, start a new workflow run. Set `require_uploads: true`
to fail coverage checks when nothing was uploaded.
[Upload inputs](github-actions/action.md#inputs)

## Patch coverage is lower than the test tool's line percentage

The patch score covers changed, coverable lines. Mustard counts a hit line with
an uncovered branch as partial. Check the line annotations for those branches.
If annotations point to the wrong lines, confirm the report uses repo-relative
source paths and that the test job ran against the code being diffed. Mustard
maps coverage from GitHub's PR merge checkout to the head's line numbers. If the
log warns that it could not map coverage from the test checkout, check out
`github.event.pull_request.head.sha` in PR test jobs instead.
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
