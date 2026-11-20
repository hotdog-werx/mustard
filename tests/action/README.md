# Action tests

Run `mise run test-action` after installing dependencies. The suite builds the
action, reads its entrypoint and input defaults from `action.yml`, and executes
the bundle with runner-style event, input, output, and summary files. It covers
upload, report, and fork comment workflows, including a real toolkit ZIP upload
and download round trip over mocked HTTP. The mocks block external requests and
check the artifact digest sent by the toolkit.

CI also runs [the action workflow](../../.github/workflows/action-tests.yaml).
It invokes `uses: ./` for all three modes and checks the outputs and step
conclusion through GitHub's workflow expressions. A test preload supplies
synthetic GitHub events and API responses. These tests require no Docker or
GitHub credentials. Mustard's regular CI separately exercises the GitHub-hosted
artifact service when it reports this repository's coverage.

`npm run coverage` runs the unit and action scenarios together against the
TypeScript sources so the native V8 LCOV report includes the action's child
processes. The standalone action suite and the `uses: ./` workflow exercise the
production bundle.

The raw coverage.py upload scenarios run when `python3 -m coverage` is
available. CI installs the version pinned in
[`tests/fixtures/requirements.txt`](../fixtures/requirements.txt). To run those
scenarios locally, install that file in a Python virtual environment and
activate it before running the suite.

The provenance integration tests use a checked-in DSSE envelope for
`tests/fixtures/report.zip`. A test certificate authority issued the workflow
and timestamping certificates. The RFC 3161 timestamp fixes the signing time, so
verification does not depend on the current date. The tests supply the fixture
trust root in place of TUF and run the real Sigstore verifier.
