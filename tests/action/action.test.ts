import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { parse } from 'yaml';
import { readZip } from '../../src/artifacts.ts';
import { base, changedCoverage, fullCoverage, head } from './scenario.ts';

type State = {
  archives: Array<{ id: number; run: number; name: string; digest: string }>;
  calls: Array<{ route: string; method: string; body: Record<string, unknown> | null }>;
};

const manifest = parse(readFileSync('action.yml', 'utf8'));
assert.equal(manifest.runs.using, 'node24');
const sourceEntrypoint = process.env.MUSTARD_TEST_ENTRYPOINT;
const entrypoint = sourceEntrypoint ? resolve(sourceEntrypoint) : isolateBundle(resolve(manifest.runs.main));

function isolateBundle(bundle: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'mustard-bundle-'));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const entrypoint = join(directory, 'index.cjs');
  copyFileSync(bundle, entrypoint);
  return entrypoint;
}
const preload = resolve('tests/action/mock-github.ts');

function scenario(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mustard-action-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src/example.ts'), 'one\ntwo\nthree\n');

  function run(inputs: Record<string, string> = {}, env: Record<string, string> = {}) {
    const summary = join(directory, 'summary.md');
    const output = join(directory, 'output.txt');
    for (const file of [summary, output]) writeFileSync(file, '');
    const defaults = Object.fromEntries(
      Object.entries(manifest.inputs).flatMap(([name, input]) => {
        const value = (input as { default?: string }).default;
        return typeof value === 'string' ? [[name, value]] : [];
      }),
    );
    const stepInputs = Object.fromEntries(
      Object.entries({ ...defaults, ...inputs }).map(([key, value]) => [`INPUT_${key.toUpperCase()}`, value]),
    );
    const action = spawnSync(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        ...stepInputs,
        NODE_OPTIONS: `--import=${JSON.stringify(preload)}`,
        ...env,
        GITHUB_WORKSPACE: directory,
        MUSTARD_TEST_STATE: directory,
        MUSTARD_TEST_WORKSPACE: directory,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });
    const outputs = Object.fromEntries(
      [...readFileSync(output, 'utf8').matchAll(/^([\w-]+)<<(\S+)\r?\n(.*?)\r?\n\2\r?$/gms)].map((match) => [
        match[1],
        match[3],
      ]),
    );
    return {
      status: action.status,
      stdout: action.stdout,
      diagnostics: `${action.error ?? ''}\n${action.stdout}\n${action.stderr}`,
      outputs,
      summary: readFileSync(summary, 'utf8'),
    };
  }

  const writeSource = (data: string) => writeFileSync(join(directory, 'src/example.ts'), data);
  const state = (): State => JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  const writeCoverage = (data: string) => writeFileSync(join(directory, 'lcov.info'), data);
  async function inspect(id: number, entries: string[]) {
    return readZip(readFileSync(join(directory, `${id}.zip`)), entries);
  }
  return { run, state, writeCoverage, writeSource, inspect };
}

function ok(result: ReturnType<ReturnType<typeof scenario>['run']>) {
  assert.equal(result.status, 0, result.diagnostics);
  return result;
}

function checks(state: State) {
  return state.calls.filter((call) => call.route === '/check-runs' || call.route.startsWith('/check-runs/'));
}

test('upload uses the artifact service and writes a normalized archive for the PR head and run attempt', async (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info', flag: 'frontend', 'strict-paths': 'true' }));
  const [artifact] = fixture.state().archives;
  assert.match(artifact.name, /^mustard-upload-frontend-7-2-[a-f0-9-]{36}$/);
  const archive = await fixture.inspect(artifact.id, ['coverage.json.gz']);
  const coverage = archive.get('coverage.json.gz');
  assert.ok(coverage);
  assert.deepEqual(JSON.parse(gunzipSync(coverage).toString()), {
    schema: 'mustard.coverage/v1',
    commit: head,
    flags: ['frontend'],
    files: { 'src/example.ts': { lines: { '1': [1], '2': [0], '3': [1] } } },
  });
});

test('report compares a PR to a push baseline and excludes uploads from the previous attempt', async (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, { MUSTARD_TEST_EVENT: 'push' }));
  const baseline = ok(fixture.run({}, { MUSTARD_TEST_EVENT: 'push' }));
  assert.equal(baseline.outputs['project-coverage'], '100.00%');
  assert.equal(baseline.outputs['report-artifact-id'], '2');
  assert.equal(checks(fixture.state()).length, 0);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, { MUSTARD_TEST_ATTEMPT: '1' }));
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = ok(fixture.run());
  assert.equal(report.outputs['baseline-sha'], base);
  assert.equal(report.outputs['project-coverage'], '66.66%');
  assert.ok(Math.abs(Number(report.outputs['project-delta']) + 100 / 3) < 0.000001);
  assert.equal(report.outputs['patch-coverage'], '50.00%');
  assert.equal(report.outputs['patch-hits'], '1');
  assert.equal(report.outputs['patch-total'], '2');
  assert.equal(report.outputs['patch-status'], 'failure');
  assert.equal(report.outputs['project-status'], 'success');
  assert.equal(report.outputs['report-artifact-id'], '5');
  assert.match(report.summary, /Patch 50\.00%/);

  const state = fixture.state();
  assert.deepEqual(
    checks(state).map((call) => [call.body?.name, call.body?.head_sha, call.body?.conclusion]),
    [
      ['mustard/project', head, 'success'],
      ['mustard/patch', head, 'failure'],
    ],
  );
  const patchOutput = checks(state)[1].body?.output as
    | { annotations: Array<{ path: string; start_line: number }> }
    | undefined;
  assert.ok(patchOutput);
  assert.deepEqual(
    patchOutput.annotations.map((item) => [item.path, item.start_line]),
    [['src/example.ts', 2]],
  );
  assert.ok(state.calls.some((call) => call.route === '/issues/5/comments' && call.method === 'POST'));
  const reportArchive = await fixture.inspect(5, ['report.json.gz', 'meta.json', 'summary.json']);
  assert.match(reportArchive.get('meta.json')?.toString() ?? '', /"run_attempt":2/);
});

test('fork report emits outputs without writes and comment recomputes with trusted configuration', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  const fork = { MUSTARD_TEST_FORK: 'true' };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, fork));
  assert.equal(ok(fixture.run({}, fork)).outputs['patch-status'], 'failure');
  assert.equal(checks(fixture.state()).length, 0);
  const comment = ok(
    fixture.run({ mode: 'comment', 'config-source': 'head' }, { MUSTARD_TEST_EVENT: 'workflow_run' }),
  );
  assert.match(comment.summary, /merge-base configuration/);
  assert.equal(comment.outputs['patch-status'], 'failure');
  assert.ok(
    fixture.state().calls.some((call) => call.route === '/issues/5/comments' && call.method === 'POST'),
  );
  assert.equal(checks(fixture.state()).length, 2);
});

test('fail-ci propagates a failed patch to the runner', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = fixture.run({ 'fail-ci': 'true' });
  assert.equal(report.status, 1, report.diagnostics);
  assert.equal(report.outputs['patch-status'], 'failure');
  assert.match(report.stdout, /required Mustard coverage check failed/);
});

test('merge queue attaches a patch check without posting a PR comment', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  const env = { MUSTARD_TEST_EVENT: 'merge_group' };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, env));
  assert.equal(ok(fixture.run({}, env)).outputs['patch-status'], 'success');
  assert.ok(checks(fixture.state()).every((call) => call.body?.head_sha === head));
  assert.ok(fixture.state().calls.every((call) => !call.route.includes('/comments')));
});

test('rejects an artifact digest mismatch before publishing any checks', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = fixture.run({}, { MUSTARD_TEST_BAD_DIGEST: 'true' });
  assert.equal(report.status, 1, report.diagnostics);
  assert.match(report.stdout, /Artifact digest verification failed/);
  assert.equal(checks(fixture.state()).length, 0);
});

test('publishes the HTML report with escaped source and missed lines marked', async (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  fixture.writeSource('one\n<script>uncovered</script>\nthree\n');
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = ok(fixture.run({}, { MUSTARD_TEST_CONFIG_SUFFIX: 'html: {enabled: true}\n' }));
  const artifact = fixture.state().archives.find(({ name }) => name.startsWith('mustard-html-'));
  assert.ok(artifact);
  const html = (await fixture.inspect(artifact.id, ['index.html'])).get('index.html')?.toString();
  assert.ok(html);
  assert.ok(html.includes('class="miss">2  &lt;script&gt;uncovered&lt;/script&gt;'));
  assert.match(report.summary, new RegExp(`HTML report.*artifacts/${artifact.id}`));
});

test('publishes project, flag, and component badges on the default branch push', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  const push = { MUSTARD_TEST_EVENT: 'push' };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, push));
  ok(
    fixture.run(
      {},
      {
        ...push,
        MUSTARD_TEST_CONFIG_SUFFIX: `
badge: {enabled: true, flags: [default], components: [source]}
component_management:
  individual_components:
    - component_id: source
      paths: ['src/**']
`,
      },
    ),
  );
  const { calls } = fixture.state();
  const tree = calls.find(({ route }) => route === '/git/trees')?.body?.tree as
    | Array<{ path: string; content: string }>
    | undefined;
  assert.ok(tree);
  assert.deepEqual(
    tree.map(({ path }) => path),
    [
      'badge.json',
      'badge.svg',
      'flags/default.json',
      'flags/default.svg',
      'components/source.json',
      'components/source.svg',
    ],
  );
  assert.deepEqual(JSON.parse(tree[0].content), {
    schemaVersion: 1,
    label: 'coverage',
    message: '100.00%',
    color: 'brightgreen',
  });
  assert.deepEqual(calls.find(({ route }) => route === '/git/commits')?.body?.parents, []);
  assert.deepEqual(calls.find(({ route }) => route === '/git/refs')?.body, {
    ref: 'refs/heads/mustard-badges',
    sha: 'badge-commit',
  });
});

test('publishes a timestamped attestation for the exact push report digest', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  const push = { MUSTARD_TEST_EVENT: 'push' };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, push));
  ok(fixture.run({}, { ...push, MUSTARD_TEST_SIGN: 'true' }));
  const { archives, calls } = fixture.state();
  const report = archives.find((archive) => archive.name.startsWith('mustard-report-'));
  assert.ok(report);
  const posted = calls.find((call) => call.method === 'POST' && call.route === '/attestations');
  assert.ok(posted?.body);
  const bundle = posted.body.bundle as {
    dsseEnvelope: { payloadType: string; payload: string; signatures: Array<{ sig: string }> };
    verificationMaterial: {
      timestampVerificationData: { rfc3161Timestamps: Array<{ signedTimestamp: string }> };
    };
  };
  assert.equal(bundle.dsseEnvelope.payloadType, 'application/vnd.in-toto+json');
  assert.ok(bundle.dsseEnvelope.signatures[0].sig);
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString());
  assert.equal(statement.predicateType, 'https://slsa.dev/provenance/v1');
  assert.deepEqual(statement.subject, [{ name: report.name, digest: { sha256: report.digest.slice(7) } }]);
  assert.deepEqual(bundle.verificationMaterial.timestampVerificationData.rfc3161Timestamps, [
    { signedTimestamp: Buffer.from('fixture-timestamp').toString('base64') },
  ]);
});

test('rejects an otherwise valid baseline when the required attestation is missing', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  const push = { MUSTARD_TEST_EVENT: 'push' };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, push));
  ok(fixture.run({}, push));
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = ok(fixture.run({}, { MUSTARD_TEST_REQUIRE_ATTESTATION: 'true' }));
  assert.equal(report.outputs['baseline-sha'], '');
  assert.equal(report.outputs['project-status'], 'failure');
  assert.equal(report.outputs['patch-status'], 'success');
  assert.match(report.stdout, /No attestation found/);
});

test('missing required uploads produces failed checks and an explanatory summary', (t) => {
  const fixture = scenario(t);
  const report = ok(fixture.run());
  assert.equal(report.outputs['patch-status'], 'failure');
  assert.equal(report.outputs['project-status'], 'failure');
  assert.match(report.summary, /No coverage uploads found/);
});

test('invalid mode and missing files fail through the action entrypoint', (t) => {
  const fixture = scenario(t);
  const invalid = fixture.run({ mode: 'unknown' });
  assert.equal(invalid.status, 1, invalid.diagnostics);
  assert.match(invalid.stdout, /mode must be upload, report, or comment/);
  const missing = fixture.run({ mode: 'upload', files: 'absent.lcov' });
  assert.equal(missing.status, 1, missing.diagnostics);
  assert.match(missing.stdout, /No files matched the files input/);
});

test('same-repository PRs use base policy unless the caller opts into head policy', (t) => {
  const headPolicy = {
    MUSTARD_TEST_HEAD_CONFIG:
      'baseline: {attestations: off, max_walk: 0}\ncoverage: {status: {patch: false}}\n',
  };
  for (const source of ['base', 'head']) {
    const fixture = scenario(t);
    fixture.writeCoverage(changedCoverage);
    ok(fixture.run({ mode: 'upload', name: 'frontend' }));
    const report = ok(fixture.run({ name: 'frontend', 'config-source': source }, headPolicy));
    const { calls } = fixture.state();
    const patch = calls.find((call) => call.body?.name === 'mustard[frontend]/patch');
    if (source === 'base') {
      assert.ok(patch);
      assert.equal(report.outputs['patch-status'], 'failure');
      assert.match(report.summary, /merge-base configuration/);
    } else {
      assert.equal(patch, undefined);
      assert.equal(report.outputs['patch-status'], '');
    }
  }
});

test('reads Codecov settings as a fallback when the repository has no Mustard config', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload' }));
  const report = ok(fixture.run({}, { MUSTARD_TEST_CODECOV: 'true' }));
  assert.match(report.stdout, /Reading codecov.yml in Codecov compatibility mode/);
  assert.equal(report.outputs['project-status'], 'success');
  assert.equal(report.outputs['patch-status'], 'failure');
});

test('reports a failed patch check when the GitHub comparison is incomplete', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload' }));
  const report = ok(fixture.run({}, { MUSTARD_TEST_INCOMPLETE_DIFF: 'true' }));
  assert.equal(report.outputs['patch-status'], 'failure');
  assert.match(report.summary, /complete patch was unavailable/i);
});

test('does not publish stale checks after the PR head changes', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload' }));
  const report = ok(fixture.run({}, { MUSTARD_TEST_PR_UPDATED: 'true' }));
  assert.match(report.stdout, /pull request changed while Mustard was reporting/);
  assert.equal(checks(fixture.state()).length, 0);
  assert.equal(
    fixture.state().calls.some((call) => call.method === 'POST' && call.route.endsWith('/comments')),
    false,
  );
});

test('gives workflow authors an actionable error for missing GitHub write permissions', (t) => {
  for (const [denied, permission] of [
    ['checks', 'checks: write'],
    ['comments', 'pull-requests: write'],
  ]) {
    const fixture = scenario(t);
    fixture.writeCoverage(fullCoverage);
    ok(fixture.run({ mode: 'upload' }));
    const report = fixture.run({}, { MUSTARD_TEST_DENY: denied });
    assert.equal(report.status, 1, report.diagnostics);
    assert.ok(report.stdout.includes(permission));
  }
});

test('strict upload rejects source paths missing from the checkout', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage.replace('src/example.ts', 'dist/example.js'));
  const report = fixture.run({ mode: 'upload', 'strict-paths': 'true' });
  assert.equal(report.status, 1, report.diagnostics);
  assert.match(report.stdout, /did not match the checkout.*dist\/example.js/);
  assert.equal(fixture.state().archives.length, 0);
});

test('a newly adopted repository gates its patch without a project baseline', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  const env = { MUSTARD_TEST_NO_CONFIG: 'true' };
  ok(fixture.run({ mode: 'upload' }, env));
  const report = ok(fixture.run({}, env));
  assert.equal(report.outputs['project-status'], 'neutral');
  assert.equal(report.outputs['patch-status'], 'failure');
  assert.match(report.summary, /No verified baseline available/);
});

test('leaves an existing badge branch with unrelated history untouched', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  const env = { MUSTARD_TEST_EVENT: 'push' };
  ok(fixture.run({ mode: 'upload' }, env));
  const report = fixture.run(
    {},
    {
      ...env,
      MUSTARD_TEST_CONFIG_SUFFIX: 'badge: {enabled: true}\n',
      MUSTARD_TEST_EXISTING_BADGE_BRANCH: 'true',
    },
  );
  assert.equal(report.status, 1, report.diagnostics);
  assert.match(report.stdout, /Badge branch already has unrelated history/);
  assert.equal(
    fixture.state().calls.some((call) => call.method !== 'GET' && call.route.startsWith('/git/')),
    false,
  );
});
