# Configuration reference

Mustard looks for `.github/mustard.yml`, `mustard.yml`, `codecov.yml`,
`.codecov.yml`, and `.github/codecov.yml`, in that order. Unsupported keys
generate warnings. Duplicate keys and YAML aliases are rejected. Use the
[JSON Schema](https://github.com/hotdog-werx/mustard/blob/master/mustard.schema.json)
to check spelling and value types.

## Checks

- `coverage.status.project.default.target` defaults to `auto`, which compares
  project coverage with the baseline. Set a numeric percentage for an absolute
  target.
- `coverage.status.patch.default.target` defaults to 100%. An explicit `auto`
  also means 100% because a patch has no earlier equivalent. A diff with zero
  changed coverable lines passes. When GitHub returns a truncated diff, Mustard
  fails the patch check if local Git diffing is also unavailable.
- `threshold` is an allowed drop in percentage points. `informational: true`
  makes the check neutral. `if_no_baseline` controls the project auto-target
  conclusion and defaults to `neutral`. `baseline.required: true` makes a
  missing auto-target baseline fail.
- Use named project or patch entries to create additional checks, with optional
  `paths` and `flags` filters. Set a check or an entire kind to `false` to
  disable it.
- `coverage.precision` and `coverage.round` control displayed percentages. Gates
  use the unrounded coverage. `coverage.range` controls badge colors.
- `annotations.enabled` defaults to true. `annotations.max` defaults to 200.
  Mustard sends up to 50 annotations per Checks API request and publishes the
  check result with the first batch. If GitHub cannot find the check to append
  another batch, the workflow summary still shows the coverage details.
- `require_uploads: true` fails coverage checks when no upload is present for
  the current attempt. The default is neutral.
- Set top-level `indirect_changes: fail` to fail the default project check when
  coverage changes in unchanged files. The comment lists these changes by
  default.

## Coverage inputs and paths

| Format           | Common producer                            | Path note                                                                     |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Cobertura XML    | coverage.py, many other tools              | Mustard looks at declared source directories for relative class filenames.    |
| LCOV             | c8, Istanbul, Vitest, grcov                | Supply the LCOV output, commonly `lcov.info`.                                 |
| coverage.py JSON | `coverage json`                            | Run within the test environment.                                              |
| Go coverprofile  | `go test -coverprofile=coverage.out ./...` | Use `root` to remove a Go module prefix if present.                           |
| JaCoCo XML       | JaCoCo XML report                          | Add a path rewrite when the Java package path differs from the checkout path. |

Apply Codecov-compatible `fixes` first, `path-fixes` second, then strip `root`
and the workspace prefix. Paths are stored repo-relative with forward slashes.
With no report found and no explicit `files` input, the upload can run
`python3 -m coverage` to combine and convert local `.coverage` files. This
requires coverage.py in the existing environment.

Hits are summed per line. For branch coverage, Mustard takes the largest branch
total across uploads, adds covered branches, and clamps that sum to the total.
Two uploads that cover the same branch can therefore overstate combined branch
coverage. In a single measurement, a hit with incomplete branch coverage counts
as partial and lowers the coverage percentage.

## Flags and components

Use `flag: api` on upload jobs to group reports. Unnamed uploads use `default`.
Flag paths limit which uploaded files enter the project view. A missing flag
with `carryforward: true` uses its coverage from the verified baseline,
restricted to the configured paths. Use this for path-filtered jobs whose
sources and tests are unchanged when skipped. `status: true` enables the
corresponding project-style `mustard/flag/api` check.

```yaml
flags:
  api:
    paths: [services/api/**]
    carryforward: true
    status: true

component_management:
  individual_components:
    - component_id: core
      name: Core
      paths: [src/core/**]
      statuses:
        - type: patch
          target: 95%
```

For `ignore`, flags, checks, and components, a plain path such as `src/api` or
`src/api/` matches that path and everything below it. Standard globs include
`src/**` and `**/*.test.*`. Start a regular expression with `^` to identify it
explicitly. Mustard also recognizes some unanchored Codecov regex patterns, such
as `test_.*.rb`, and anchors them at the start of the path. A project, flag, or
component check that selects no coverable lines fails.

Components select paths from the combined project view. One component rule
creates `mustard/component/core`. A component with both types uses
`mustard/component/core/project` and `mustard/component/core/patch`.

## Artifacts and provenance

See [storage and trust](concepts/storage.md#which-reports-can-become-baselines)
for the baseline selection rules, attestations, and retention.

The PR's merge-base config controls gating by default. To opt into the PR head
on a same-repo PR, set `config.source: head` in trusted config or pass
`config-source: head` to the report action. Fork checks always use the
merge-base config. For PR workflows that test GitHub's synthetic merge checkout,
Mustard measures the uploaded reports and associates them with the PR head. If
base-only changes cause source line offsets, test the exact head checkout for
line-accurate patch measurements.

## Comments, badges, and HTML

The step summary always reports the computed results. The PR comment can be
updated in place (`comment.behavior: default`), written once (`once`), deleted
and recreated (`new`), or disabled (`off`). Use `require_changes`,
`only_on_failure`, `show_carryforward_flags`, `indirect_changes`, and
`max_files` under `comment` to adjust its content.

Set `badge.enabled: true` on the default branch to publish `badge.svg` and a
Shields-compatible `badge.json` to the orphan `mustard-badges` branch. Add
optional `badge.flags` and `badge.components` lists. See the
[badge recipe](github-actions/workflow-recipes.md#publish-a-badge) for
permissions and the README image URL.

Set `html.enabled: true` for a downloadable HTML report. In report mode, add a
checkout for source highlighting. Fork reports omit source text, and the
privileged comment job skips HTML generation.

## Codecov compatibility

| Codecov setting                                                         | Mustard support                                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `coverage.status.project`, `coverage.status.patch`                      | Default and named checks with targets, tolerance, paths, flags, and informational status                       |
| `coverage.precision`, `coverage.round`, `coverage.range`                | Percentage formatting and badge range                                                                          |
| `ignore`, `fixes`                                                       | Path patterns and prefix rewrites                                                                              |
| `flags`, `flag_management`                                              | Flag paths, carryforward defaults, and individual flags                                                        |
| `component_management.individual_components`                            | Path groups and project/patch checks                                                                           |
| `comment`                                                               | Behavior, change requirements, and layout sections for header, files, flags, components, and indirect coverage |
| `codecov`, `notify`, `github_checks`, `bundle_analysis`, and other keys | Ignored with warnings                                                                                          |
