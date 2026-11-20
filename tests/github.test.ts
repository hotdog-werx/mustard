import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import { downloadArtifact, names, readBaseline, readZip } from '../src/artifacts.ts';
import { assertSubject, attestationPolicy, findBaseline, trustedRun } from '../src/baseline.ts';
import { readConfig } from '../src/config.ts';
import { compareFiles, newLines, parseGitDiff } from '../src/diff.ts';
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
