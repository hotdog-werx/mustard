import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { mock, test } from 'node:test';
import { downloadArtifact, names, readBaseline, readZip } from '../src/artifacts.ts';
import { assertSubject, attestationPolicy, findBaseline, Provenance, trustedRun } from '../src/baseline.ts';
import { readConfig } from '../src/config.ts';
import { compareFiles, gitDiff, newLines, parseGitDiff } from '../src/diff.ts';
import { resolvePull } from '../src/github.ts';
import type { Event, GitHub, Pull, Run } from '../src/github.ts';
import {
  annotationBatches,
  escapeHtml,
  escapeMarkdown,
  markdown,
  stickyComment,
  writeChecks,
} from '../src/publish.ts';
import { compute } from '../src/report.ts';
import { deserialize } from '../src/coverage.ts';

const head = 'b'.repeat(40);
const base = 'a'.repeat(40);
const repo = { owner: 'hotdog-werx', repo: 'mustard' };
const pull: Pull = {
  number: 8,
  head: { sha: head, ref: 'main', repo: { full_name: 'contributor/mustard' } },
  base: { sha: base, ref: 'main', repo: { full_name: 'hotdog-werx/mustard' } },
};
const event: Event = {
  mode: 'comment',
  runId: 11,
  attempt: 1,
  event: 'pull_request',
  commit: head,
  coverageCommit: head,
  base,
  pull,
  fork: true,
  workflow: '.github/workflows/ci.yml',
  defaultBranch: 'main',
  repo,
};
const run: Run = {
  id: 7,
  run_attempt: 1,
  head_sha: base,
  head_branch: 'main',
  status: 'completed',
  event: 'push',
  path: event.workflow,
  updated_at: '2026-11-20T00:00:00Z',
  head_repository: { full_name: 'hotdog-werx/mustard', owner: { login: 'hotdog-werx' } },
};
const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url));

test('parses new-side diff ranges, renames, binary changes, and deleted paths', () => {
  const patch = '@@ -2,2 +2,2 @@\r\n-a\r\n-b\r\n+x\r\n+y\r\n\\ No newline at end of file\r\n';
  const diff = parseGitDiff(
    'R090\0src/old.ts\0src/new.ts\0M\0image.png\0D\0removed.txt\0',
    `diff --git a/src/old.ts b/src/new.ts\n${patch}diff --git a/image.png b/image.png\nBinary files differ\ndiff --git a/removed.txt b/removed.txt\n@@ -1 +0,0 @@\n-x\n`,
  );
  assert.deepEqual([...newLines(patch)], [2, 3]);
  assert.equal(diff.get('src/new.ts')?.oldPath, 'src/old.ts');
  assert.equal(diff.get('image.png')?.lines.size, 0);
  assert.equal(diff.get('removed.txt')?.deleted, true);
  assert.equal(compareFiles([{ filename: 'a.ts', status: 'modified', patch, additions: 3 }]).complete, false);
  assert.throws(() => newLines('@@ -1 +1,2 @@\n-first\n+first'), /Truncated/);
});

test('rejects baseline runs from forks, PRs, other workflows, or incomplete attempts', () => {
  const config = readConfig();
  assert.equal(trustedRun(run, event, base, config), true);
  for (const changed of [
    { event: 'pull_request' },
    { status: 'in_progress' },
    { path: '.github/workflows/other.yml' },
    { head_repository: { full_name: 'contributor/mustard', owner: { login: 'contributor' } } },
    { head_branch: 'test' },
  ])
    assert.equal(trustedRun({ ...run, ...changed }, event, base, config), false);
  const policy = attestationPolicy(event, run, false);
  const pattern = policy.subjectAlternativeName as RegExp;
  assert.equal(
    pattern.test('https://github.com/hotdog-werx/mustard/.github/workflows/ci.yml@refs/heads/main'),
    true,
  );
  assert.equal(
    pattern.test('https://github.com/contributor/mustard/.github/workflows/ci.yml@refs/heads/main'),
    false,
  );
  assert.equal(
    pattern.test('https://github.com/hotdog-werx/mustard/.github/workflows/ciXyml@refs/heads/main'),
    false,
  );
  assert.equal(
    policy.oids?.some((oid) => oid.oid?.id.at(-1) === 13 && oid.value.includes(base)),
    true,
  );
  assert.equal(
    policy.oids?.some((oid) => oid.oid?.id.at(-1) === 11),
    true,
  );
});

test('only an exact attested name and SHA-256 digest are accepted', () => {
  const payload = Buffer.from(
    JSON.stringify({
      _type: 'https://in-toto.io/Statement/v1',
      predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ name: 'coverage', digest: { sha256: 'actual' } }],
    }),
  );
  assert.doesNotThrow(() => assertSubject(payload, 'coverage', 'actual'));
  assert.throws(() => assertSubject(payload, 'coverage', 'different'), /digest/);
  assert.throws(() => assertSubject(payload, 'other', 'actual'), /digest/);
});

test('rejects unsafe ZIP paths and wrong baseline metadata', async () => {
  await assert.rejects(readZip(fixture('unexpected.zip'), ['report.json.gz']), /path/);
  await assert.rejects(readBaseline(fixture('report.zip'), base, 7, 2, event.workflow), /metadata/);
  const result = await readBaseline(fixture('report.zip'), base, 7, 1, event.workflow);
  assert.deepEqual(result.get('default')?.get('a.ts')?.get(1), [1]);
});

test('downloads baseline artifacts with a digest check and without forwarding credentials', async () => {
  const bytes = fixture('report.zip');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const fetchMock = mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    if (String(url).includes('api.github.com')) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer example');
      return new Response(null, { status: 302, headers: { location: 'https://storage.example.org/signed' } });
    }
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return new Response(new Uint8Array(bytes));
  });
  try {
    const entry = {
      id: 10,
      name: 'report',
      expired: false,
      size_in_bytes: bytes.length,
      digest: `sha256:${digest}`,
    };
    assert.equal((await downloadArtifact(repo, entry, 'example')).digest, digest);
    await assert.rejects(
      downloadArtifact(repo, { ...entry, digest: 'sha256:wrong' }, 'example'),
      /digest verification/,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test('baseline lookup ignores a fork and verifies candidates in trusted runs', async () => {
  const bytes = fixture('report.zip');
  const artifactName = `mustard-report-${base}`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const refused = {
    ...run,
    id: 6,
    run_attempt: 2,
    head_repository: { full_name: 'contributor/mustard', owner: { login: 'contributor' } },
  };
  const artifactList = mock.fn();
  const api = {
    rest: {
      actions: {
        listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [refused, run] } }),
        listWorkflowRunArtifacts: artifactList,
      },
    },
    paginate: {
      iterator: async function* (_method: unknown, params: { run_id: number; name: string }) {
        assert.equal(params.run_id, run.id);
        assert.equal(params.name, artifactName);
        yield {
          data: [
            {
              id: 10,
              name: artifactName,
              expired: false,
              size_in_bytes: bytes.length,
              digest: `sha256:${digest}`,
            },
          ],
        };
      },
    },
  } as unknown as GitHub;
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(bytes)));
  try {
    const result = await findBaseline(
      api,
      event,
      base,
      'example',
      readConfig('baseline: {attestations: off}'),
      names(''),
    );
    assert.equal(result?.runId, 7);
    assert.equal(result?.distance, 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test('resolves a fork PR from repository, branch and the exact workflow head', async () => {
  const forkRun = {
    ...run,
    head_sha: head,
    event: 'pull_request',
    head_repository: { full_name: 'contributor/mustard', owner: { login: 'contributor' } },
  };
  const api = {
    rest: { pulls: { list: () => {} } },
    paginate: async (_method: unknown, params: { head: string }) => {
      assert.equal(params.head, 'contributor:main');
      return [{ ...pull, number: 1, head: { ...pull.head, sha: base } }, pull];
    },
  } as unknown as GitHub;
  assert.deepEqual(await resolvePull(api, repo, forkRun), pull);
});

test('trusts a configured release branch only while GitHub reports it as protected', async (t) => {
  const branch = 'release/1.x';
  const bytes = fixture('report.zip');
  const artifactName = `mustard-report-${base}`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  let protectedBranch = false;
  const downloads = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(bytes)));
  const api = {
    rest: {
      actions: {
        listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [{ ...run, head_branch: branch }] } }),
        listWorkflowRunArtifacts: () => {},
      },
      repos: {
        getBranch: async ({ branch: requested }: { branch: string }) => {
          assert.equal(requested, branch);
          return { data: { protected: protectedBranch } };
        },
      },
    },
    paginate: {
      iterator: async function* () {
        yield {
          data: [
            {
              id: 10,
              name: artifactName,
              expired: false,
              size_in_bytes: bytes.length,
              digest: `sha256:${digest}`,
            },
          ],
        };
      },
    },
  } as unknown as GitHub;
  const config = readConfig(`baseline: {attestations: off, max_walk: 0, trusted_branches: [${branch}]}`);
  assert.equal(await findBaseline(api, event, base, 'example', config, names('')), undefined);
  assert.equal(downloads.mock.callCount(), 0);

  protectedBranch = true;
  const baseline = await findBaseline(api, event, base, 'example', config, names(''));
  assert.equal(baseline?.sha, base);
  assert.equal(baseline?.runId, run.id);
  assert.equal(downloads.mock.callCount(), 1);
});

test('attaches checks to the PR head and batches annotations across API updates', async () => {
  const path = 'src/a.ts';
  const lines = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [index + 1, [0]]));
  const config = readConfig();
  const report = compute(
    new Map([['default', deserialize({ [path]: { lines } })]]),
    new Map([[path, { lines: new Set(Array.from({ length: 101 }, (_, index) => index + 1)) }]]),
    config,
  );
  assert.deepEqual(
    annotationBatches(report.annotations).map((batch) => batch.length),
    [50, 50, 1],
  );
  const create = mock.fn(async (_params: Record<string, unknown>) => ({ data: { id: 55 } }));
  const update = mock.fn(async (_params: Record<string, unknown>) => ({}));
  const api = { rest: { checks: { create, update } } } as unknown as GitHub;
  await writeChecks(api, names(''), { report, config, event, configChanged: false, hasUploads: true });
  assert.equal(create.mock.calls[1].arguments[0].head_sha, head);
  assert.equal(create.mock.calls[1].arguments[0].status, 'in_progress');
  assert.equal(update.mock.calls[1].arguments[0].check_run_id, 55);
  assert.equal(update.mock.calls[1].arguments[0].conclusion, 'failure');
});

test('escapes PR comment data and updates only the Actions bot sticky comment', async () => {
  const path = 'src/<a>|@user [test].ts';
  const config = readConfig();
  const report = compute(
    new Map([['default', deserialize({ [path]: { lines: { 1: [0] } } })]]),
    new Map([[path, { lines: new Set([1]) }]]),
    config,
  );
  const display = { report, config, event, configChanged: true, hasUploads: true };
  const rendered = markdown(display);
  assert.ok(rendered.includes('&#64;user'));
  assert.ok(rendered.includes('%3Ca%3E%7C%40user%20%5Btest%5D.ts'));
  assert.equal(escapeMarkdown('<script>'), '&#60;script&#62;');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  const namespace = names('');
  const update = mock.fn(async (_params: Record<string, unknown>) => ({}));
  const create = mock.fn();
  const api = {
    rest: { issues: { listComments: () => {}, updateComment: update, createComment: create } },
    paginate: {
      iterator: async function* () {
        yield {
          data: [
            { id: 1, user: { type: 'User', login: 'test' }, body: namespace.marker },
            { id: 2, user: { type: 'Bot', login: 'github-actions[bot]' }, body: namespace.marker },
          ],
        };
      },
    },
  } as unknown as GitHub;
  await stickyComment(api, namespace, display);
  assert.equal(update.mock.calls[0].arguments[0].comment_id, 2);
  assert.equal(create.mock.callCount(), 0);
});

test('walks first parents to find the newest available verified baseline', async () => {
  const checked: string[] = [];
  const bytes = fixture('report.zip');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const start = 'c'.repeat(40);
  const api = {
    rest: {
      actions: {
        listWorkflowRunsForRepo: async ({ head_sha }: { head_sha: string }) => {
          checked.push(head_sha);
          return { data: { workflow_runs: head_sha === base ? [run] : [] } };
        },
        listWorkflowRunArtifacts: () => {},
      },
      repos: {
        getCommit: async ({ ref }: { ref: string }) => {
          assert.equal(ref, start);
          return { data: { parents: [{ sha: base }, { sha: 'd'.repeat(40) }] } };
        },
      },
    },
    paginate: {
      iterator: async function* () {
        yield {
          data: [
            {
              id: 31,
              name: `mustard-report-${base}`,
              size_in_bytes: bytes.length,
              digest: `sha256:${digest}`,
            },
          ],
        };
      },
    },
  } as unknown as GitHub;
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(bytes)));
  try {
    const config = readConfig('baseline: {attestations: off, max_walk: 1}');
    const baseline = await findBaseline(api, event, start, 'example', config, names(''));
    assert.deepEqual(checked, [start, base]);
    assert.equal(baseline?.sha, base);
    assert.equal(baseline?.distance, 1);
  } finally {
    fetch.mock.restore();
  }
});

test('auto attestation policy falls back for an unsupported plan and rejects missing permissions', async () => {
  const plan = Object.assign(
    new Error(
      'Artifact attestations are unavailable on this repository plan. Attestations are not supported.',
    ),
    { status: 403 },
  );
  const permission = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
  function withError(error: Error) {
    const request = mock.fn(async () => {
      throw error;
    });
    const api = { rest: { repos: { listAttestations: request } } } as unknown as GitHub;
    return { api, request };
  }
  const unavailable = withError(plan);
  const optional = new Provenance(unavailable.api, event, readConfig());
  await optional.verify('report', 'digest', run);
  await optional.verify('another-report', 'digest', run);
  assert.equal(unavailable.request.mock.callCount(), 1);
  const strict = new Provenance(unavailable.api, event, readConfig('baseline: {attestations: required}'));
  await assert.rejects(strict.verify('report', 'digest', run), /not supported/);
  const forbidden = new Provenance(withError(permission).api, event, readConfig());
  await assert.rejects(forbidden.verify('report', 'digest', run), /not accessible/);
});

test('reports a useful failure when GitHub refuses to download an artifact', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('Not Found', { status: 404 }));
  try {
    const artifact = { id: 5, name: 'report', expired: false, size_in_bytes: 10 };
    await assert.rejects(downloadArtifact(repo, artifact, 'example'), /download failed \(HTTP 404\)/);
  } finally {
    fetch.mock.restore();
  }
});

test('preserves or replaces existing comments according to the repository policy', async () => {
  const namespace = names('');
  const create = mock.fn(async (_params: Record<string, unknown>) => ({}));
  const remove = mock.fn(async (_params: Record<string, unknown>) => ({}));
  const api = {
    rest: { issues: { listComments: () => {}, deleteComment: remove, createComment: create } },
    paginate: {
      iterator: async function* () {
        yield {
          data: [
            {
              id: 42,
              user: { type: 'Bot', login: 'github-actions[bot]' },
              body: `${namespace.marker}\nPrevious`,
            },
          ],
        };
      },
    },
  } as unknown as GitHub;
  for (const behavior of ['once', 'new']) {
    const config = readConfig(`comment: {behavior: ${behavior}}`);
    const report = compute(new Map(), new Map(), config);
    await stickyComment(api, namespace, { report, config, event, configChanged: false, hasUploads: false });
    assert.equal(create.mock.callCount(), behavior === 'new' ? 1 : 0);
  }
  assert.equal(remove.mock.calls[0].arguments[0].comment_id, 42);
  assert.equal(create.mock.calls[0].arguments[0].issue_number, pull.number);
});

test('explains indirect coverage regressions separately from changed files', () => {
  const config = readConfig('comment: {max_files: 1}');
  const previous = new Map([
    [
      'default',
      deserialize({
        'src/untouched-a.ts': { lines: { 1: [1] } },
        'src/untouched-b.ts': { lines: { 1: [1] } },
      }),
    ],
  ]);
  const current = new Map([
    [
      'default',
      deserialize({
        'src/untouched-a.ts': { lines: { 1: [0] } },
        'src/untouched-b.ts': { lines: { 1: [0] } },
      }),
    ],
  ]);
  const report = compute(current, new Map(), config, previous);
  const body = markdown({
    report,
    config,
    event,
    configChanged: false,
    hasUploads: true,
    baseline: { sha: base, runId: 7, distance: 1 },
  });
  assert.match(body, /No coverable lines changed/);
  assert.match(body, /1 first-parent commit/);
  assert.match(body, /### Indirect changes/);
  assert.match(body, /src\/untouched-a.ts/);
  assert.match(body, /\+1 more file/);
  assert.doesNotMatch(body, /### Changed files/);
});

test('gets the actual changed lines of two Git commits through a shallow fetch', {
  skip: process.platform === 'win32' ? 'Fixture uses a POSIX Git transport shim' : false,
}, (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'mustard-git-fixture-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const checkout = join(workspace, 'fixture');
  const bin = join(workspace, 'bin');
  mkdirSync(checkout);
  mkdirSync(bin);
  const git = (...args: string[]) =>
    execFileSync(actualGit, args, {
      cwd: checkout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q', '--template=');
  const commit = (message: string) => {
    git('add', 'example.ts');
    git(
      '-c',
      'user.name=Mustard Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      message,
    );
    return git('rev-parse', 'HEAD');
  };
  writeFileSync(join(checkout, 'example.ts'), 'const one = 1;\nconst two = 2;\n');
  const oldSha = commit('initial');
  writeFileSync(join(checkout, 'example.ts'), 'const one = 1;\nconst updated = 2;\n');
  const newSha = commit('update one line');

  const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = fetch ]; then
  shift 4
  exec ${shellQuote(actualGit)} fetch --no-tags --depth=1 ${shellQuote(`file://${checkout}`)} "$@"
fi
exec ${shellQuote(actualGit)} "$@"
`,
    { mode: 0o755 },
  );

  const previousPath = process.env.PATH;
  const previousServer = process.env.GITHUB_SERVER_URL;
  process.env.PATH = [bin, previousPath].join(delimiter);
  process.env.GITHUB_SERVER_URL = 'https://mustard.invalid';
  try {
    const diff = gitDiff({ ...event, commit: newSha }, oldSha, 'fixture-token');
    assert.deepEqual([...diff.keys()], ['example.ts']);
    assert.deepEqual([...(diff.get('example.ts')?.lines ?? [])], [2]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousServer === undefined) delete process.env.GITHUB_SERVER_URL;
    else process.env.GITHUB_SERVER_URL = previousServer;
  }
});
