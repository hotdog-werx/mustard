import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { parse } from 'yaml';
import { readZip } from '../../src/artifacts.ts';
import { base, changedCoverage, fullCoverage, head, merge } from './scenario.ts';

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
// --import takes a URL; a bare absolute path fails on Windows (D:\\…).
const preload = pathToFileURL(resolve('tests/action/mock-github.ts')).href;

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
  const state = (): State => {
    const path = join(directory, 'state.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { archives: [], calls: [] };
  };
  const writeCoverage = (data: string) => writeFileSync(join(directory, 'lcov.info'), data);
  async function inspect(id: number, entries: string[]) {
    return readZip(readFileSync(join(directory, `${id}.zip`)), entries);
  }
  return { directory, run, state, writeCoverage, writeSource, inspect };
}

function ok(result: ReturnType<ReturnType<typeof scenario>['run']>) {
  assert.equal(result.status, 0, result.diagnostics);
  return result;
}

function checks(state: State) {
  return state.calls.filter((call) => call.route === '/check-runs' || call.route.startsWith('/check-runs/'));
}

async function uploadedFiles(fixture: ReturnType<typeof scenario>) {
  const [artifact] = fixture.state().archives;
  assert.ok(artifact);
  const archive = await fixture.inspect(artifact.id, ['coverage.json.gz']);
  const coverage = archive.get('coverage.json.gz');
  assert.ok(coverage);
  return JSON.parse(gunzipSync(coverage).toString()).files;
}

const python = process.platform === 'win32' ? 'python' : 'python3';
const coveragePy = spawnSync(python, ['-m', 'coverage', '--version'], { timeout: 5_000 }).status === 0;
const pythonOptions = {
  skip: coveragePy ? false : 'Install tests/fixtures/requirements.txt to test raw coverage.py uploads',
};

for (const mode of ['single', 'parallel', 'mixed']) {
  test(`uploads raw coverage.py data from ${mode} runs`, pythonOptions, async (t) => {
    const fixture = scenario(t);
    writeFileSync(
      join(fixture.directory, 'example.py'),
      "import sys\nif sys.argv[1] == 'yes':\n    print('yes')\nelse:\n    print('no')\n",
    );
    const runs = mode === 'single' ? ['yes'] : ['yes', 'no'];
    for (const [index, value] of runs.entries()) {
      const parallel = mode === 'parallel' || index > 0;
      const run = spawnSync(
        python,
        ['-m', 'coverage', 'run', '--branch', ...(parallel ? ['--parallel-mode'] : []), 'example.py', value],
        { cwd: fixture.directory, encoding: 'utf8', timeout: 5_000 },
      );
      assert.equal(run.status, 0, run.stderr);
    }
    ok(fixture.run({ mode: 'upload', 'strict-paths': 'true' }));
    assert.deepEqual(await uploadedFiles(fixture), {
      'example.py': { lines: { 1: [1], 2: [1, runs.length, 2], 3: [1], 5: [runs.length - 1] } },
    });
    if (mode !== 'parallel') assert.ok(existsSync(join(fixture.directory, '.coverage')));
  });
}

test('reports a raw coverage.py database that cannot be converted', pythonOptions, (t) => {
  const fixture = scenario(t);
  writeFileSync(join(fixture.directory, '.coverage'), '');
  const result = fixture.run({ mode: 'upload' });
  assert.equal(result.status, 1, result.diagnostics);
  assert.match(result.stdout, /Could not convert coverage\.py data/);
  assert.deepEqual(fixture.state().archives, []);
});

test('merges overlapping coverage from multiple LCOV files matched by a glob', async (t) => {
  const fixture = scenario(t);
  mkdirSync(join(fixture.directory, 'reports'));
  writeFileSync(join(fixture.directory, 'reports', 'one.info'), changedCoverage);
  writeFileSync(
    join(fixture.directory, 'reports', 'two.info'),
    'SF:src/example.ts\nDA:1,0\nDA:2,2\nend_of_record\n',
  );
  ok(
    fixture.run({
      mode: 'upload',
      files: join(realpathSync(fixture.directory), 'reports', '*.info'),
    }),
  );
  assert.deepEqual(await uploadedFiles(fixture), { 'src/example.ts': { lines: { 1: [1], 2: [2], 3: [1] } } });
});

test('rejects an explicitly configured report outside the checkout', (t) => {
  const fixture = scenario(t);
  const result = fixture.run({ mode: 'upload', files: '../lcov.info' });
  assert.equal(result.status, 1, result.diagnostics);
  assert.match(result.stdout, /Coverage file globs must stay inside GITHUB_WORKSPACE/);
  assert.deepEqual(fixture.state().archives, []);
});

test('does not follow a coverage report symlink outside the checkout', {
  skip: process.platform === 'win32' ? 'Creating symlinks can require elevated privileges on Windows' : false,
}, (t) => {
  const fixture = scenario(t);
  const outside = mkdtempSync(join(tmpdir(), 'mustard-external-report-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const report = join(outside, 'report.info');
  writeFileSync(report, changedCoverage);
  symlinkSync(report, join(fixture.directory, 'lcov.info'));
  const result = fixture.run({ mode: 'upload', files: 'lcov.info' });
  assert.equal(result.status, 1, result.diagnostics);
  assert.match(result.stdout, /No files matched the files input/);
  assert.deepEqual(fixture.state().archives, []);
});

test('explains how to supply a coverage report when default discovery finds nothing', (t) => {
  const fixture = scenario(t);
  const result = fixture.run({ mode: 'upload' });
  assert.equal(result.status, 1, result.diagnostics);
  assert.match(result.stdout, /No coverage files found.*Set the files input/);
  assert.deepEqual(fixture.state().archives, []);
});

test('warns about unmatched sources in a default upload while retaining usable paths', async (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(`${changedCoverage}SF:src/generated.ts\nDA:1,1\nend_of_record\n`);
  const result = ok(fixture.run({ mode: 'upload' }));
  assert.match(result.stdout, /coverage path\(s\) did not match the checkout: "src\/generated.ts"/);
  assert.deepEqual(await uploadedFiles(fixture), {
    'src/example.ts': { lines: { 1: [1], 2: [0], 3: [1] } },
    'src/generated.ts': { lines: { 1: [1] } },
  });
});

test('rejects a report when it contains no coverable source lines', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage('SF:src/example.ts\nend_of_record\n');
  const result = fixture.run({ mode: 'upload' });
  assert.equal(result.status, 1, result.diagnostics);
  assert.match(result.stdout, /Coverage reports contain no usable coverable lines/);
  assert.deepEqual(fixture.state().archives, []);
});

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
    checkout: merge,
    files: { 'src/example.ts': { lines: { '1': [1], '2': [0], '3': [1] } } },
  });
});

test('report compares a PR to a push baseline and replaces an earlier upload for the same shard', async (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, { MUSTARD_TEST_EVENT: 'push' }));
  const baseline = ok(fixture.run({}, { MUSTARD_TEST_EVENT: 'push' }));
  assert.equal(baseline.outputs['project-coverage'], '100.00%');
  assert.equal(baseline.outputs['report-artifact-id'], '2');
  assert.equal(checks(fixture.state()).length, 0);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info', shard: 'unit' }, { MUSTARD_TEST_ATTEMPT: '1' }));
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info', shard: 'unit' }));
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

test('a push carries forward a missing flag from the first parent and records its origin', async (t) => {
  const fixture = scenario(t);
  const push = {
    MUSTARD_TEST_EVENT: 'push',
    MUSTARD_TEST_CONFIG_SUFFIX: '\nflags: {integration: {carryforward: true}}\n',
  };
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info', flag: 'integration' }, push));
  const first = ok(fixture.run({}, push));
  assert.equal(first.outputs['baseline-sha'], '');

  const next = { ...push, MUSTARD_TEST_NEXT_PUSH: 'true' };
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info', flag: 'unit' }, next));
  const report = ok(fixture.run({}, next));
  assert.equal(report.outputs['baseline-sha'], base);
  assert.match(report.summary, /integration.*100\.00%.*Carried forward from a{12}/);
  assert.match(report.summary, /unit.*66\.66%/);
  const archive = await fixture.inspect(Number(report.outputs['report-artifact-id']), [
    'meta.json',
    'report.json.gz',
    'summary.json',
  ]);
  assert.deepEqual(JSON.parse(archive.get('meta.json')?.toString() ?? '{}').carryforward, {
    integration: base,
  });
});

test('publishes the patch verdict and PR comment when GitHub cannot append annotations', (t) => {
  const fixture = scenario(t);
  const lines = Array.from({ length: 75 }, (_, index) => index + 1);
  fixture.writeSource(lines.map((line) => `line ${line}`).join('\n'));
  fixture.writeCoverage(
    `SF:src/example.ts\n${lines.map((line) => `DA:${line},0`).join('\n')}\nend_of_record\n`,
  );
  ok(fixture.run({ mode: 'upload' }));

  const report = ok(
    fixture.run(
      {},
      {
        MUSTARD_TEST_LARGE_DIFF: 'true',
        MUSTARD_TEST_DENY: 'append-annotations',
      },
    ),
  );
  assert.equal(report.outputs['patch-status'], 'failure');
  assert.equal(report.outputs['patch-total'], '75');
  assert.match(report.stdout, /GitHub would not append 25 more annotations/);

  const state = fixture.state();
  const patch = checks(state).find((call) => call.body?.name === 'mustard/patch')?.body;
  assert.ok(patch);
  assert.equal(patch.status, 'completed');
  assert.equal(patch.conclusion, 'failure');
  assert.equal((patch.output as { annotations: unknown[] }).annotations.length, 50);
  assert.ok(state.calls.some((call) => call.route === '/issues/5/comments' && call.method === 'POST'));
});

test('fork report emits outputs without writes and comment recomputes with trusted configuration', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  const fork = { MUSTARD_TEST_FORK: 'true' };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, fork));
  assert.equal(ok(fixture.run({}, fork)).outputs['patch-status'], 'failure');
  assert.equal(checks(fixture.state()).length, 0);
  const comment = ok(
    fixture.run(
      { mode: 'comment', 'config-source': 'head', 'run-id': '7' },
      { MUSTARD_TEST_EVENT: 'workflow_run' },
    ),
  );
  assert.match(comment.summary, /merge-base configuration/);
  assert.equal(comment.outputs['patch-status'], 'failure');
  assert.ok(
    fixture.state().calls.some((call) => call.route === '/issues/5/comments' && call.method === 'POST'),
  );
  assert.equal(checks(fixture.state()).length, 2);
});

test('comment mode refuses a pull_request event or a run ID different from the triggering run', (t) => {
  const fixture = scenario(t);
  const wrongEvent = fixture.run({ mode: 'comment' });
  assert.equal(wrongEvent.status, 1, wrongEvent.diagnostics);
  assert.match(wrongEvent.stdout, /comment mode requires a completed workflow_run event/);
  const wrongRun = fixture.run({ mode: 'comment', 'run-id': '6' }, { MUSTARD_TEST_EVENT: 'workflow_run' });
  assert.equal(wrongRun.status, 1, wrongRun.diagnostics);
  assert.match(wrongRun.stdout, /run-id must match the triggering workflow_run/);
  assert.deepEqual(fixture.state().calls, []);
});

test('a fork PR closed before the privileged job starts receives no report or checks', (t) => {
  const fixture = scenario(t);
  const result = ok(
    fixture.run(
      { mode: 'comment' },
      { MUSTARD_TEST_EVENT: 'workflow_run', MUSTARD_TEST_FORK_CLOSED: 'true' },
    ),
  );
  assert.match(result.stdout, /No matching open fork PR/);
  assert.deepEqual(result.outputs, {});
  assert.equal(
    fixture.state().calls.some(({ method }) => method !== 'GET'),
    false,
  );
});

test('comment mode ignores push runs and runs already back in progress', (t) => {
  const fixture = scenario(t);
  const triggers: Record<string, string>[] = [
    { MUSTARD_TEST_TRIGGER_EVENT: 'push' },
    { MUSTARD_TEST_TRIGGER_STATUS: 'in_progress' },
  ];
  for (const trigger of triggers) {
    const report = ok(fixture.run({ mode: 'comment' }, { MUSTARD_TEST_EVENT: 'workflow_run', ...trigger }));
    assert.match(report.stdout, /No matching open fork PR/);
    assert.deepEqual(report.outputs, {});
  }
  assert.deepEqual(
    fixture.state().calls.map(({ method, route }) => [method, route]),
    [
      ['GET', '/actions/runs/7'],
      ['GET', '/actions/runs/7'],
    ],
  );
});

test('comment mode accepts the first upload when both run records omit the attempt', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload' }, { MUSTARD_TEST_FORK: 'true', MUSTARD_TEST_ATTEMPT: '1' }));
  const report = ok(
    fixture.run({ mode: 'comment' }, { MUSTARD_TEST_EVENT: 'workflow_run', MUSTARD_TEST_LEGACY_RUN: 'true' }),
  );
  assert.equal(report.outputs['patch-status'], 'success');
  assert.ok(
    fixture.state().calls.some(({ method, route }) => method === 'POST' && route === '/issues/5/comments'),
  );
});

test('fail-ci propagates a failed patch to the runner', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = fixture.run({ 'fail-ci': 'true' });
  assert.equal(report.status, 1, report.diagnostics);
  assert.equal(report.outputs['patch-status'], 'failure');
  assert.match(report.stdout, /Mustard coverage check\(s\) failed, and fail-ci is enabled/);
  assert.match(report.stdout, /mustard\/patch: .*coverage, minimum/);
});

test('a late completion event from an earlier fork run cannot write checks or comments', (t) => {
  const fixture = scenario(t);
  const report = ok(
    fixture.run(
      { mode: 'comment' },
      {
        MUSTARD_TEST_EVENT: 'workflow_run',
        MUSTARD_TEST_FORK_RERUN: 'true',
      },
    ),
  );
  assert.match(report.stdout, /No matching open fork PR for this workflow run and attempt/);
  assert.deepEqual(report.outputs, {});
  assert.equal(
    fixture.state().calls.some((call) => call.method !== 'GET'),
    false,
  );
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
  fixture.writeSource('one\n<script>uncovered</script>\nthree\n// unmeasured comment\n');
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = ok(fixture.run({}, { MUSTARD_TEST_CONFIG_SUFFIX: 'html: {enabled: true}\n' }));
  const artifact = fixture.state().archives.find(({ name }) => name.startsWith('mustard-html-'));
  assert.ok(artifact);
  const html = (await fixture.inspect(artifact.id, ['index.html'])).get('index.html')?.toString();
  assert.ok(html);
  assert.ok(html.includes('class="miss">2  &lt;script&gt;uncovered&lt;/script&gt;'));
  assert.ok(html.includes('class="">4  // unmeasured comment'));
  assert.match(report.summary, new RegExp(`HTML report.*artifacts/${artifact.id}`));
});

test('keeps an HTML artifact usable when escaped source exceeds the rendering budget', async (t) => {
  const fixture = scenario(t);
  const generated = '&'.repeat(49_000);
  const files = Array.from({ length: 56 }, (_, index) => `src/generated-${index}.ts`);
  for (const file of files) writeFileSync(join(fixture.directory, file), generated);
  fixture.writeCoverage(files.map((file) => `SF:${file}\nDA:1,1\nend_of_record\n`).join(''));
  ok(fixture.run({ mode: 'upload' }));
  const result = ok(fixture.run({}, { MUSTARD_TEST_CONFIG_SUFFIX: 'html: {enabled: true}\n' }));
  assert.equal(result.outputs['project-coverage'], '100.00%');
  const artifact = fixture.state().archives.find(({ name }) => name.startsWith('mustard-html-'));
  assert.ok(artifact);
  const html = (await fixture.inspect(artifact.id, ['index.html'])).get('index.html')?.toString();
  assert.ok(html);
  assert.ok(html.includes('src/generated-0.ts'));
  assert.ok(!html.includes('src/generated-55.ts'));
  assert.ok(html.includes('the report reached its size limit'));
  assert.ok(html.endsWith('</main></html>'));
});

test('fork HTML reports show line status without including checkout source', async (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  fixture.writeSource('source-only text\nlocal checkout line\nthree\n');
  const fork = { MUSTARD_TEST_FORK: 'true', MUSTARD_TEST_CONFIG_SUFFIX: 'html: {enabled: true}\n' };
  ok(fixture.run({ mode: 'upload' }, fork));
  ok(fixture.run({}, fork));
  const artifact = fixture.state().archives.find(({ name }) => name.startsWith('mustard-html-'));
  assert.ok(artifact);
  const html = (await fixture.inspect(artifact.id, ['index.html'])).get('index.html')?.toString() ?? '';
  assert.match(html, /class="miss">2 {2}miss<\/span>/);
  assert.doesNotMatch(html, /source-only text|local checkout line/);
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

test('an incomplete push fails CI with neutral checks, keeps the last badge, and signs no baseline', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  const push = {
    MUSTARD_TEST_EVENT: 'push',
    MUSTARD_TEST_SIGN: 'true',
    // Informational checks stay neutral, so only the incomplete report fails the step.
    MUSTARD_TEST_CONFIG_SUFFIX:
      '\nbadge: {enabled: true}\nflags: {default: {required: true}, cpp: {required: true}}\ncoverage: {status: {project: {default: {informational: true}}}}\n',
  };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, push));
  const report = fixture.run({ 'fail-ci': 'true' }, push);
  assert.equal(report.status, 1, report.diagnostics);
  assert.match(report.stdout, /Required flag\(s\) did not report: cpp/);
  assert.equal(report.outputs['missing-required-flags'], 'cpp');
  assert.equal(report.outputs['project-status'], 'neutral');
  assert.match(report.stdout, /Mustard coverage is incomplete, and fail-ci is enabled/);
  assert.equal(report.outputs['project-coverage'], '100.00%');
  assert.match(report.summary, /Incomplete coverage/);
  const { archives, calls } = fixture.state();
  assert.ok(archives.some((archive) => archive.name === `mustard-report-${base}`));
  assert.equal(
    calls.some(({ route }) => route === '/git/trees' || route === '/attestations'),
    false,
  );
});

test('a named coverage report uses its own badge branch', (t) => {
  const fixture = scenario(t);
  const push = { MUSTARD_TEST_EVENT: 'push', MUSTARD_TEST_CONFIG_SUFFIX: '\nbadge: {enabled: true}\n' };
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ name: 'api', mode: 'upload', files: 'lcov.info' }, push));
  ok(fixture.run({ name: 'api' }, push));
  const { calls } = fixture.state();
  assert.deepEqual(calls.find(({ route }) => route === '/git/refs')?.body, {
    ref: 'refs/heads/mustard-badges-3-api',
    sha: 'badge-commit',
  });
  assert.equal(
    calls.find(({ route }) => route === '/git/commits')?.body?.message,
    'Publish Mustard coverage badges for mustard[api]',
  );
  assert.equal(
    calls.some(({ route }) => route === '/branches/mustard-badges'),
    false,
  );
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

test('a private repository without attestations records the refusal and keeps its baseline', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  const env = { MUSTARD_TEST_PLAN_LIMIT: 'true' };
  const push = { ...env, MUSTARD_TEST_EVENT: 'push' };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, push));
  const signed = ok(fixture.run({}, push));
  assert.match(signed.stdout, /attestations are unavailable/i);
  assert.ok(fixture.state().archives.some((archive) => archive.name === `mustard-report-${base}-unattested`));
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, env));
  const report = ok(fixture.run({}, env));
  assert.equal(report.outputs['baseline-sha'], base);
  assert.match(report.stdout, /Accepting unsigned baseline/);
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

test('a failed head config comparison still publishes the verdict from trusted policy', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const result = ok(fixture.run({}, { MUSTARD_TEST_HEAD_CONFIG_UNAVAILABLE: 'true' }));
  assert.match(result.stdout, /Could not compare the PR configuration with the trusted configuration/);
  assert.equal(result.outputs['patch-status'], 'failure');
  assert.doesNotMatch(result.summary, /This PR changes coverage configuration/);
  assert.equal(checks(fixture.state()).length, 2);
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

test('a rerun of only the report job uses uploads from the earlier attempt', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, { MUSTARD_TEST_ATTEMPT: '1' }));
  const report = ok(fixture.run());
  assert.equal(report.outputs['project-coverage'], '100.00%');
  assert.doesNotMatch(report.summary, /No coverage uploads found/);
});

test('rerunning one shard keeps the other shard’s uncovered lines in the patch check', (t) => {
  const fixture = scenario(t);
  const first = { MUSTARD_TEST_ATTEMPT: '1' };
  const upload = { mode: 'upload', flag: 'unit' };
  fixture.writeCoverage('SF:src/example.ts\nDA:1,0\nend_of_record\n');
  ok(fixture.run({ ...upload, shard: 'fast' }, first));
  fixture.writeCoverage('SF:src/example.ts\nDA:2,0\nend_of_record\n');
  ok(fixture.run({ ...upload, shard: 'slow' }, first));
  fixture.writeCoverage('SF:src/example.ts\nDA:1,1\nend_of_record\n');
  ok(fixture.run({ ...upload, shard: 'fast' }));

  const report = ok(fixture.run());
  assert.equal(report.outputs['patch-total'], '2');
  assert.equal(report.outputs['patch-coverage'], '50.00%');
  assert.equal(report.outputs['patch-status'], 'failure');
});

test('an ambiguous retry without shard IDs fails before publishing a patch check', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload' }, { MUSTARD_TEST_ATTEMPT: '1' }));
  fixture.writeCoverage('SF:src/example.ts\nDA:1,1\nend_of_record\n');
  ok(fixture.run({ mode: 'upload' }));

  const report = fixture.run();
  assert.equal(report.status, 1, report.diagnostics);
  assert.match(report.stdout, /multiple attempts without stable shard IDs/);
  assert.equal(checks(fixture.state()).length, 0);
});

test('rejects duplicate shard IDs in the same attempt before publishing checks', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  const upload = { mode: 'upload', shard: 'linux' };
  ok(fixture.run(upload, { MUSTARD_TEST_ATTEMPT: '1' }));
  ok(fixture.run(upload, { MUSTARD_TEST_ATTEMPT: '1' }));
  ok(fixture.run(upload));

  const report = fixture.run();
  assert.equal(report.status, 1, report.diagnostics);
  assert.match(report.stdout, /duplicate uploads for shard "linux"/);
  assert.equal(checks(fixture.state()).length, 0);
});

test('an expired shard stops a partial retry from publishing incomplete coverage', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  ok(fixture.run({ mode: 'upload', shard: 'slow' }, { MUSTARD_TEST_ATTEMPT: '1' }));
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload', shard: 'fast' }));

  const report = fixture.run({}, { MUSTARD_TEST_EXPIRED_SHARD: 'slow' });
  assert.equal(report.status, 1, report.diagnostics);
  assert.match(report.stdout, /upload has expired/);
  assert.equal(checks(fixture.state()).length, 0);
});

test('publishes checks when only the PR base moved during the run', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload' }));
  ok(fixture.run({}, { MUSTARD_TEST_BASE_MOVED: 'true' }));
  assert.ok(checks(fixture.state()).length > 0);
});

test('does not publish stale results after the PR is retargeted with the same head', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload' }));
  const report = ok(fixture.run({}, { MUSTARD_TEST_PR_RETARGETED: 'true' }));
  assert.match(report.stdout, /pull request changed while Mustard was reporting/);
  assert.equal(checks(fixture.state()).length, 0);
  assert.equal(
    fixture.state().calls.some((call) => call.method === 'POST' && call.route.endsWith('/comments')),
    false,
  );
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
      MUSTARD_TEST_BADGE_TIP: 'unrelated',
    },
  );
  assert.equal(report.status, 1, report.diagnostics);
  assert.match(report.stdout, /Badge branch already has unrelated history/);
  assert.equal(
    fixture.state().calls.some((call) => call.method !== 'GET' && call.route.startsWith('/git/')),
    false,
  );
});

test('refreshes a Mustard-owned badge ref with the latest default-branch coverage', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  const push = { MUSTARD_TEST_EVENT: 'push' };
  ok(fixture.run({ mode: 'upload' }, push));
  ok(
    fixture.run(
      {},
      { ...push, MUSTARD_TEST_CONFIG_SUFFIX: 'badge: {enabled: true}\n', MUSTARD_TEST_BADGE_TIP: 'owned' },
    ),
  );
  const { calls } = fixture.state();
  const update = calls.find(
    (call) => call.method === 'PATCH' && call.route === '/git/refs/heads/mustard-badges',
  );
  assert.deepEqual(update?.body, { sha: 'badge-commit', force: true });
  assert.equal(
    calls.some((call) => call.method === 'POST' && call.route === '/git/refs'),
    false,
  );
});

test('an older default-branch run cannot overwrite current coverage badges', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(changedCoverage);
  const push = { MUSTARD_TEST_EVENT: 'push' };
  ok(fixture.run({ mode: 'upload' }, push));
  ok(
    fixture.run(
      {},
      { ...push, MUSTARD_TEST_CONFIG_SUFFIX: 'badge: {enabled: true}\n', MUSTARD_TEST_BADGE_TIP: 'stale' },
    ),
  );
  assert.equal(
    fixture.state().calls.some((call) => call.method !== 'GET' && call.route.startsWith('/git/')),
    false,
  );
});

/** Reads the default patch check's annotated lines. */
function patchAnnotations(state: State) {
  const patch = checks(state).find((call) => call.body?.name === 'mustard/patch');
  const output = patch?.body?.output as { annotations: Array<{ start_line: number }> } | undefined;
  return output?.annotations.map((item) => item.start_line);
}

// The merge checkout has one base-branch line above the head's three lines.
const mergeCoverage = 'SF:src/example.ts\nDA:1,0\nDA:2,1\nDA:3,0\nDA:4,1\nend_of_record\n';

test('maps coverage from the PR merge checkout to the head line numbers', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(mergeCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = ok(fixture.run({}, { MUSTARD_TEST_MERGE_OFFSET: 'true' }));
  // Head lines 1-3 are hit, missed, hit. The base-only line is dropped.
  assert.equal(report.outputs['project-coverage'], '66.66%');
  assert.deepEqual([report.outputs['patch-hits'], report.outputs['patch-total']], ['1', '2']);
  assert.deepEqual(patchAnnotations(fixture.state()), [2]);
  assert.doesNotMatch(report.stdout, /Could not map coverage/);
});

test('keeps merge checkout line numbers and warns when the head diff is unavailable', (t) => {
  // The checkout does not descend from the head, the comparison is incomplete, or it fails.
  for (const offset of ['', 'incomplete', 'error']) {
    const fixture = scenario(t);
    fixture.writeCoverage(mergeCoverage);
    ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
    const report = ok(fixture.run({}, { MUSTARD_TEST_MERGE_OFFSET: offset }));
    assert.match(report.stdout, /Could not map coverage from test checkout c{12} to PR head b{12}/);
    assert.equal(report.outputs['project-coverage'], '50.00%');
    assert.deepEqual(patchAnnotations(fixture.state()), [1]);
  }
});

test('an empty report fails the upload unless if-empty is warn', (t) => {
  const fixture = scenario(t);
  writeFileSync(join(fixture.directory, 'coverage.xml'), '<coverage><packages/></coverage>');
  const failed = fixture.run({ mode: 'upload', files: 'coverage.xml' });
  assert.equal(failed.status, 1, failed.diagnostics);
  assert.match(failed.stdout, /no usable coverable lines/);
  const warned = ok(fixture.run({ mode: 'upload', files: 'coverage.xml', flag: 'api', 'if-empty': 'warn' }));
  assert.match(
    warned.stdout,
    /::warning::Coverage reports contain no usable coverable lines\. Nothing was uploaded for flag api\./,
  );
  assert.equal(fixture.state().archives.length, 0);
  const invalid = fixture.run({ mode: 'upload', files: 'coverage.xml', 'if-empty': 'skip' });
  assert.match(invalid.stdout, /if-empty must be error or warn/);
});

test('a PR whose test jobs were all skipped reports carried-forward coverage under require_uploads', (t) => {
  const fixture = scenario(t);
  writeFileSync(join(fixture.directory, 'src/lib.ts'), 'one\ntwo\n');
  fixture.writeCoverage('SF:src/lib.ts\nDA:1,1\nDA:2,1\nend_of_record\n');
  const config = { MUSTARD_TEST_CONFIG_SUFFIX: 'flags: {lib: {carryforward: true}}\n' };
  const push = { ...config, MUSTARD_TEST_EVENT: 'push' };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info', flag: 'lib' }, push));
  ok(fixture.run({}, push));
  const report = ok(fixture.run({ 'fail-ci': 'true' }, config));
  assert.equal(report.outputs['baseline-sha'], base);
  assert.equal(report.outputs['project-coverage'], '100.00%');
  assert.equal(report.outputs['project-status'], 'success');
  assert.equal(report.outputs['patch-status'], 'success');
  assert.match(report.summary, /Every flag was carried forward from a{12}/);
  assert.doesNotMatch(report.summary, /No coverage uploads found|No verified baseline/);
});

test('names the workflow that holds a baseline when the report searches another one', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  const push = { MUSTARD_TEST_EVENT: 'push' };
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }, push));
  ok(fixture.run({}, push));
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = ok(fixture.run({ workflow: '.github/workflows/pr.yaml' }));
  assert.equal(report.outputs['baseline-sha'], '');
  assert.match(
    report.stdout,
    /::warning::No baseline from \.github\/workflows\/pr\.yaml, but push run 6 of \.github\/workflows\/ci\.yaml has a Mustard report for a{12}\. Set the workflow input to \.github\/workflows\/ci\.yaml/,
  );
});

test('explains an empty baseline search and points at the workflow input', (t) => {
  const fixture = scenario(t);
  fixture.writeCoverage(fullCoverage);
  ok(fixture.run({ mode: 'upload', files: 'lcov.info' }));
  const report = ok(fixture.run());
  assert.match(
    report.stdout,
    /No baseline report found in push runs of \.github\/workflows\/ci\.yaml across 1 commit\(s\)\. If push coverage runs in another workflow file, set the workflow input/,
  );
});
