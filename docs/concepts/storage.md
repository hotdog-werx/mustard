# Storage and trust

Mustard uses GitHub Actions artifacts for coverage data and GitHub's attestation
service for signed provenance. GitHub Checks, workflow summaries, and PR
comments are views of the computed result.

## What gets stored where

| Location                                | Stored data                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test workflow run                       | A `mustard-upload-…` artifact containing `coverage.json.gz` with normalized file paths and line coverage.                                                                                                    |
| Report or comment workflow run          | A `mustard-report-…` artifact containing `report.json.gz`, `summary.json`, and `meta.json`. It includes merged line data, totals, and the commit, workflow, attempt, config hash, and carryforward metadata. |
| Report workflow run with `html.enabled` | A `mustard-html-…` artifact containing `index.html`. Same-repository reports can include source text when a checkout is present.                                                                             |
| GitHub attestation service              | Signed SLSA provenance for eligible trusted push reports when attestation is enabled. It binds the artifact name and SHA-256 digest to the producing run.                                                    |
| GitHub Checks, summaries, and comments  | Check conclusions, annotations, and formatted coverage results.                                                                                                                                              |
| Badge branch                            | The latest badge files when badge publishing is enabled.                                                                                                                                                     |

Find the artifacts on the Actions run page. By default, repository artifact
retention controls how long they are available. Use the `retention-days` input
to request a different retention period within the repository policy.

## Badge branch

Publishing badges is optional and occurs only on a default-branch push that
still matches the branch tip. The badge branch defaults to `mustard-badges`. Set
`badge.branch` to choose another name. Namespaced runs append the namespace
length and name. For example, `name: api` publishes to `mustard-badges-3-api`
with the default setting.

| Path on the badge branch                      | Contents                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `badge.svg`                                   | The rendered project coverage badge.                                       |
| `badge.json`                                  | The Shields-compatible project badge payload.                              |
| `flags/<name>.svg`, `flags/<name>.json`       | Optional badges for reported flags listed under `badge.flags`.             |
| `components/<id>.svg`, `components/<id>.json` | Optional badges for configured components listed under `badge.components`. |

Each publish replaces the branch tip with a new root commit containing just the
current badge files. Mustard protects the default branch, dedicated trusted
branches, and badge branches with unrelated history. Baseline lookup uses
Actions artifacts exclusively.

## Which reports can become baselines

Mustard starts at the pull request's merge base and searches up to
`baseline.max_walk` first-parent commits. The default is 20. A candidate comes
from a completed push in the same repository and the expected workflow. It must
run on the default branch or a protected branch listed in
`baseline.trusted_branches`. The artifact must match the commit, workflow, run,
and attempt. A push that carries coverage forward starts with the previous
first-parent commit.

Mustard verifies the artifact digest before reading its contents. In the
attested path it also verifies the signed subject, repository and workflow
identity, commit and ref, run attempt, and runner environment. By default
attested baselines require GitHub-hosted runners. Set
`baseline.allow_self_hosted: true` only for runners you trust.

Public attestations use Sigstore transparency logs. Private attestations use
GitHub's trust root and a signed timestamp. GitHub makes attestations available
for private and internal repositories on Enterprise Cloud.
[GitHub attestation availability](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

| `baseline.attestations` | Behavior                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default)        | Sign and verify where available. Fall back to workflow and artifact provenance when GitHub explicitly reports attestations are unavailable. |
| `required`              | Reject unsigned or invalid baselines.                                                                                                       |
| `off`                   | Use workflow and digest provenance.                                                                                                         |

Forks supply coverage measurements and can choose what they upload. The
privileged workflow looks up the actual PR and recomputes the result with a
trusted configuration. Fork and PR reports are ineligible as project baselines.
