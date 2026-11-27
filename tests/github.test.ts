import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import { mock, test } from 'node:test';
import {
  checkoutRemapper,
  downloadArtifact,
  loadUploads,
  names,
  readBaseline,
  readZip,
  uploadCheckout,
} from '../src/artifacts.ts';
import {
  assertSubject,
  attestationPolicy,
  findBaseline,
  Provenance,
  trustedRun,
  unsupported,
} from '../src/baseline.ts';
import { readConfig } from '../src/config.ts';
import {
  compareFiles,
  gitDiff,
  newLines,
  oldLine,
  parseGitDiff,
  parsePatch,
  remapFiles,
} from '../src/diff.ts';
import { resolvePull } from '../src/github.ts';
import type { Event, GitHub, Pull, Run } from '../src/github.ts';
import {
  annotationBatches,
  escapeHtml,
  escapeMarkdown,
  failureMessage,
  markdown,
  stickyComment,
  writeChecks,
} from '../src/publish.ts';
import { compute } from '../src/report.ts';
import { deserialize, maxBytes, schema, serialize } from '../src/coverage.ts';

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
  // The signer may be the caller itself or a reusable workflow it calls.
  for (const signer of [
    'https://github.com/hotdog-werx/mustard/.github/workflows/ci.yml@refs/heads/main',
    'https://github.com/hotdog-werx/devkit/.github/workflows/__python_python-checks.yaml@refs/tags/v0',
  ])
    assert.equal(pattern.test(signer), true, signer);
  for (const signer of [
    'https://evil.example/hotdog-werx/mustard/.github/workflows/ci.yml@refs/heads/main',
    'https://github.com/hotdog-werx/mustard/.github/workflows/ci.yml',
    'https://github.com/hotdog-werx/mustard/blob/main/ci.yml@refs/heads/main',
    'user@example.com',
  ])
    assert.equal(pattern.test(signer), false, signer);
  // The trusted caller workflow is pinned exactly through the Build Config URI.
  const buildConfig = policy.oids?.find((oid) => oid.oid?.id.at(-1) === 18);
  assert.equal(
    buildConfig?.value.subarray(2).toString(),
    'https://github.com/hotdog-werx/mustard/.github/workflows/ci.yml@refs/heads/main',
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
      iterator: async function* (_method: unknown, params: { run_id: number; name?: string }) {
        assert.equal(params.run_id, run.id);
        assert.equal(params.name, undefined);
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

test('baseline lookup falls back to a previous report or defaults a missing attempt to one', async (t) => {
  const bytes = fixture('report.zip');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let candidate = run;
  const api = {
    rest: {
      actions: {
        listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [candidate] } }),
        listWorkflowRunArtifacts: () => {},
      },
      repos: { getBranch: async () => ({ data: { protected: true } }) },
    },
    paginate: {
      iterator: async function* () {
        yield {
          data: [
            {
              id: 10,
              name: 'mustard-upload-default-7-1-x',
              expired: false,
              size_in_bytes: 1,
              digest: 'sha256:0',
            },
            {
              id: 11,
              name: `mustard-report-${base}`,
              expired: false,
              size_in_bytes: bytes.length,
              digest: `sha256:${digest}`,
            },
          ],
        };
      },
    },
  } as unknown as GitHub;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(bytes)));
  for (const attempt of [3, undefined]) {
    candidate = { ...run, run_attempt: attempt };
    const config = readConfig('baseline: {attestations: off, max_walk: 0}');
    const result = await findBaseline(api, event, base, 'example', config, names(''));
    assert.equal(result?.runId, 7);
  }
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('the sticky comment recognizes comments posted with a personal or app token', async () => {
  const namespace = names('');
  const update = mock.fn(async (_params: Record<string, unknown>) => ({}));
  const create = mock.fn(async (_params: Record<string, unknown>) => ({}));
  const comments = [
    { id: 1, user: { type: 'User', login: 'attacker' }, body: `${namespace.marker}\nFake` },
    { id: 2, user: { type: 'Bot', login: 'coverage-app[bot]' }, body: `${namespace.marker}\nOld` },
  ];
  const api = {
    rest: {
      issues: { listComments: () => {}, updateComment: update, createComment: create },
      users: {
        getAuthenticated: async () => Promise.reject(Object.assign(new Error('no'), { status: 403 })),
      },
    },
    graphql: async () => ({ viewer: { login: 'coverage-app[bot]' } }),
    paginate: {
      iterator: async function* () {
        yield { data: comments };
      },
    },
  } as unknown as GitHub;
  const config = readConfig();
  const report = compute(new Map(), new Map(), config);
  await stickyComment(api, namespace, { report, config, event, configChanged: false, hasUploads: false });
  assert.equal(create.mock.callCount(), 0);
  assert.equal(update.mock.calls[0].arguments[0].comment_id, 2);
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
  assert.equal(create.mock.calls[1].arguments[0].status, 'completed');
  assert.equal(create.mock.calls[1].arguments[0].conclusion, 'failure');
  assert.equal(update.mock.calls[1].arguments[0].check_run_id, 55);
  assert.deepEqual(
    update.mock.calls.map(
      ({ arguments: [params] }) => (params.output as { annotations: unknown[] }).annotations.length,
    ),
    [50, 1],
  );
});

test('the fail-ci message names each failed check and explains the policy source', () => {
  const config = readConfig();
  const uploads = new Map([
    [
      'default',
      new Map([
        [
          'src/a.ts',
          new Map([
            [1, [1]],
            [2, [0]],
            [3, [0]],
          ] as const),
        ],
      ]),
    ],
  ]);
  const diff = new Map([['src/a.ts', { lines: new Set([1, 2, 3]) }]]);
  const report = compute(uploads as never, diff, config, undefined, true, true);
  const failed = report.checks.filter((check) => check.conclusion === 'failure');
  const message = failureMessage(failed, report, 'mustard', {
    fromBase: true,
    hasConfig: false,
    configChanged: true,
  });
  assert.match(message, /^1 Mustard coverage check\(s\) failed, and fail-ci is enabled:/);
  assert.match(
    message,
    /- mustard\/patch: 33\.33% coverage, minimum 100\.00%\. 2 changed line\(s\) lack full coverage/,
  );
  assert.match(message, /merge base has no Mustard config, so the defaults apply/);
  assert.match(message, /This PR changes the coverage config/);
  const quiet = failureMessage(failed, report, 'mustard[api]', {
    fromBase: true,
    hasConfig: true,
    configChanged: false,
  });
  assert.match(quiet, /- mustard\[api\]\/patch:/);
  assert.doesNotMatch(quiet, /merge base|changes the coverage config/);
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

test('auto attestation policy falls back only where GitHub cannot offer attestations', async () => {
  // Verbatim from POST /repos/{owner}/{repo}/attestations on a user-owned private repository.
  const plan = Object.assign(
    new Error(
      'Feature not available for user-owned private repositories. To enable this feature, please make this repository public.',
    ),
    { status: 422 },
  );
  const notFound = Object.assign(new Error('Not Found'), { status: 404 });
  const permission = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
  const unavailableResource = Object.assign(new Error('Resource not available'), { status: 404 });
  assert.equal(unsupported(plan), true);
  assert.equal(unsupported(permission), false);
  assert.equal(unsupported(unavailableResource), false);
  function withError(error: Error, visibility = 'private') {
    const request = mock.fn(async () => {
      throw error;
    });
    const api = {
      rest: { repos: { listAttestations: request, get: async () => ({ data: { visibility } }) } },
    } as unknown as GitHub;
    return { api, request };
  }
  const unavailable = withError(plan);
  const optional = new Provenance(unavailable.api, event, readConfig());
  await optional.verify('report', 'digest', run);
  await optional.verify('another-report', 'digest', run);
  assert.equal(unavailable.request.mock.callCount(), 1);
  const strict = new Provenance(unavailable.api, event, readConfig('baseline: {attestations: required}'));
  await assert.rejects(strict.verify('report', 'digest', run), /not available/);
  // Every public repository supports attestations, so a missing one is never excused.
  const publicRepo = new Provenance(withError(notFound, 'public').api, event, readConfig());
  await assert.rejects(publicRepo.verify('report', 'digest', run), /No attestation found/);
  const publicPlan = new Provenance(withError(plan, 'public').api, event, readConfig());
  await assert.rejects(publicPlan.verify('report', 'digest', run), /not available/);
  const forbidden = new Provenance(withError(permission).api, event, readConfig());
  await assert.rejects(forbidden.verify('report', 'digest', run), /not accessible/);
});

test('a missing or inaccessible private attestation never disables checks on later candidates', async (t) => {
  const listAttestations = t.mock.fn(async ({ subject_digest }: { subject_digest: string }) => {
    if (subject_digest === 'sha256:inaccessible')
      throw Object.assign(new Error('Not Found'), { status: 404 });
    return { data: { attestations: [] } };
  });
  const api = {
    rest: { repos: { listAttestations, get: async () => ({ data: { visibility: 'private' } }) } },
  } as unknown as GitHub;
  const provenance = new Provenance(api, event, readConfig());
  await assert.rejects(provenance.verify('report', 'inaccessible', run), /No attestation found/);
  await assert.rejects(provenance.verify('another-report', 'unsigned', run), /No attestation found/);
  assert.equal(listAttestations.mock.callCount(), 2);
});

test("an unsigned private baseline is accepted only with its run's plan-limit marker", async (t) => {
  const listAttestations = t.mock.fn(async () => {
    throw Object.assign(new Error('Not Found'), { status: 404 });
  });
  const repoApi = (visibility: string) =>
    ({
      rest: { repos: { listAttestations, get: async () => ({ data: { visibility } }) } },
    }) as unknown as GitHub;
  const attempt = run.run_attempt ?? 1;
  const auto = new Provenance(repoApi('private'), event, readConfig());
  await auto.verify('report', 'digest', run, attempt, true);
  // The marker is per artifact evidence, so it does not excuse later candidates.
  await assert.rejects(auto.verify('other', 'digest', run, attempt, false), /No attestation found/);
  const onPublic = new Provenance(repoApi('public'), event, readConfig());
  await assert.rejects(onPublic.verify('report', 'digest', run, attempt, true), /No attestation found/);
  const required = new Provenance(
    repoApi('private'),
    event,
    readConfig('baseline: {attestations: required}'),
  );
  await assert.rejects(required.verify('report', 'digest', run, attempt, true), /No attestation found/);
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

test('a passing patch with unchanged coverage skips failure-only and change-only comments', async () => {
  const uploads = new Map([['default', deserialize({ 'src/example.ts': { lines: { 1: [1] } } })]]);
  const list = mock.fn();
  const api = { paginate: { iterator: list } } as unknown as GitHub;
  for (const policy of ['require_changes', 'only_on_failure']) {
    const config = readConfig(`comment: {${policy}: true}`);
    const report = compute(uploads, new Map([['src/example.ts', { lines: new Set([1]) }]]), config, uploads);
    await stickyComment(api, names(''), {
      report,
      config,
      event,
      configChanged: false,
      hasUploads: true,
      baseline: { sha: base, runId: 7, distance: 0 },
    });
  }
  assert.equal(list.mock.callCount(), 0);
});

test('limits changed-file links and still shows coverage deltas for unmeasured patches', () => {
  const config = readConfig('comment: {max_files: 2}');
  const missed = [1, 2, ...Array.from({ length: 14 }, (_, index) => (index + 2) * 2)];
  const current = new Map([
    [
      'default',
      deserialize({
        'src/missed.ts': { lines: Object.fromEntries(missed.map((line) => [line, [0]])) },
        'src/changed.ts': { lines: { 1: [1] } },
        'src/also-changed.ts': { lines: { 1: [1] } },
      }),
    ],
  ]);
  const previous = new Map([['default', deserialize({ 'src/changed.ts': { lines: { 1: [0] } } })]]);
  const diff = new Map([
    ['src/missed.ts', { lines: new Set(missed) }],
    ['src/changed.ts', { lines: new Set([2]) }],
    ['src/also-changed.ts', { lines: new Set([1]) }],
  ]);
  const report = compute(current, diff, config, previous);
  const body = markdown({ report, config, event, configChanged: false, hasUploads: true });
  assert.match(body, /\[1&#8211;2\]\([^\n]*#L1-L2\)/);
  assert.match(body, /src\/missed\.ts[^\n]* … \|/);
  assert.match(body, /src\/changed\.ts[^\n]* \| — \| ▲ \+100\.00 pp \| — \|/);
  assert.match(body, /\+1 more file/);
  assert.doesNotMatch(body, /also-changed\.ts/);
});

test('hides carried flags in the PR comment while keeping them in the job summary', () => {
  const config = readConfig(`
flags: {integration: {carryforward: true}, missing: {}}
comment: {layout: flags, show_carryforward_flags: false}
`);
  const files = deserialize({ 'src/example.ts': { lines: { 1: [1] } } });
  const report = compute(new Map([['unit', files]]), new Map(), config, new Map([['integration', files]]));
  const display = {
    report,
    config,
    event,
    configChanged: false,
    hasUploads: true,
    baseline: { sha: base, runId: 7, distance: 0 },
  };
  const comment = markdown(display, true);
  assert.doesNotMatch(comment, /\*\*Project \d/);
  assert.match(comment, /\| unit \| 100\.00% \| — \| 1\/1 \| Uploaded \|/);
  assert.match(comment, /\| missing \| — \| — \| — \| Missing \|/);
  assert.doesNotMatch(comment, /integration/);
  const summary = markdown(display);
  assert.match(summary, /\*\*Project 100\.00%/);
  assert.match(summary, /\| integration \| 100\.00% \| — \| 1\/1 \| Carried forward from a{12} \|/);
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

test('summarizes global coverage first, then a row per flag, and explains a missing required flag', () => {
  const config = readConfig('flags: {python: {required: true}, cpp: {required: true}}');
  const files = deserialize({ 'src/app.py': { lines: { 1: [1], 2: [0] } } });
  const report = compute(new Map([['python', files]]), new Map(), config);
  const body = markdown({ report, config, event, configChanged: false, hasUploads: true }, true);
  assert.ok(body.indexOf('**Project 50.00%**') < body.indexOf('### Flags'));
  assert.match(body, /\*\*Incomplete coverage\.\*\* Required flag\(s\) \*\*cpp\*\* did not report/);
  assert.match(body, /\| python \| 50\.00% \| — \| 1\/2 \| Uploaded \|/);
  assert.match(body, /\| cpp \| — \| — \| — \| \*\*Missing \(required\)\*\* \|/);
  const message = failureMessage([], report, 'mustard', {
    fromBase: false,
    hasConfig: true,
    configChanged: false,
  });
  assert.match(
    message,
    /^Mustard coverage is incomplete, and fail-ci is enabled:\n- Required flag\(s\) did not report: cpp\./,
  ); // A failing non-patch check is listed after the missing flags without the uncovered-lines hint.
  const project = report.checks.filter((check) => check.name === 'project');
  const both = failureMessage(project, report, 'mustard', {
    fromBase: false,
    hasConfig: true,
    configChanged: false,
  });
  assert.match(
    both,
    /^1 Mustard coverage check\(s\) failed[\s\S]*did not report: cpp\.\n- mustard\/project: Incomplete/,
  );
  assert.doesNotMatch(both, /lack full coverage/);
});

test('baseline lookup skips a report that lacks a required flag', async (t) => {
  const bytes = fixture('report.zip');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const api = {
    rest: {
      actions: { listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [run] } }) },
      repos: { getBranch: async () => ({ data: { protected: true } }) },
    },
    paginate: {
      iterator: async function* () {
        yield {
          data: [
            {
              id: 11,
              name: `mustard-report-${base}`,
              expired: false,
              size_in_bytes: bytes.length,
              digest: `sha256:${digest}`,
            },
          ],
        };
      },
    },
  } as unknown as GitHub;
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(bytes)));
  const settings = 'baseline: {attestations: off, max_walk: 0}';
  const complete = await findBaseline(api, event, base, 'example', readConfig(settings), names(''));
  assert.equal(complete?.runId, 7);
  const partial = readConfig(`${settings}\nflags: {cpp: {required: true}}`);
  assert.equal(await findBaseline(api, event, base, 'example', partial, names('')), undefined);
});

test('maps new-side lines through insertions, deletions, and replacements', () => {
  // Zero-context hunks name the line before an empty side. New 1-2 are inserted,
  // old 5-6 are deleted, and old 9 is replaced by new 9-10.
  const zero = parsePatch(
    '@@ -0,0 +1,2 @@\n+a\n+b\n@@ -5,2 +6,0 @@\n-x\n-y\n@@ -9 +9,2 @@\n-old\n+n1\n+n2\n',
  );
  assert.deepEqual([...zero.lines], [1, 2, 9, 10]);
  assert.deepEqual(
    [1, 2, 3, 6, 7, 8, 9, 10, 11].map((line) => oldLine(line, zero.segments)),
    [undefined, undefined, 1, 4, 7, 8, undefined, undefined, 10],
  );
  // Compare API patches carry context lines.
  const context = parsePatch('@@ -1,3 +1,4 @@\n ctx1\n+added\n ctx2\n ctx3\n\\ No newline at end of file');
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((line) => oldLine(line, context.segments)),
    [1, undefined, 2, 3, 4],
  );
  assert.throws(() => parsePatch('@@ -1,2 +1,2 @@\n-a\n+b'), /Truncated/);
});

test('remaps merge-checkout coverage to head paths and drops base-only files and lines', () => {
  const coverage = deserialize({
    'src/a.ts': { lines: { 1: [1], 3: [0], 9: [1] } },
    'src/new.ts': { lines: { 4: [2] } },
    'src/base.ts': { lines: { 1: [1] } },
    'src/same.ts': { lines: { 7: [1] } },
  });
  const diff = new Map([
    ['src/a.ts', { lines: new Set([1, 2]), segments: parsePatch('@@ -0,0 +1,2 @@\n+a\n+b').segments }],
    ['src/new.ts', { lines: new Set<number>(), oldPath: 'src/old.ts', segments: [] }],
    ['src/base.ts', { lines: new Set([1]), segments: parsePatch('@@ -0,0 +1 @@\n+x').segments }],
    ['src/gone.ts', { lines: new Set<number>(), deleted: true }],
  ]);
  const files = remapFiles(coverage, diff);
  assert.deepEqual(Object.keys(serialize(files)).sort(), ['src/a.ts', 'src/old.ts', 'src/same.ts']);
  assert.deepEqual(serialize(files)['src/a.ts'].lines, { 1: [0], 7: [1] });
  assert.deepEqual(serialize(files)['src/old.ts'].lines, { 4: [2] });
  assert.deepEqual(serialize(files)['src/same.ts'].lines, { 7: [1] });
  assert.equal(remapFiles(deserialize({ 'src/gone.ts': { lines: { 1: [1] } } }), diff).size, 0);
});

test("validates an upload's recorded checkout and diffs each checkout once", async () => {
  const payload = { schema: 'mustard.coverage/v1', commit: head, flags: ['unit'], shard: 'linux' };
  assert.equal(uploadCheckout(payload, event, 'unit', 'linux'), undefined);
  const checkout = 'c'.repeat(40);
  assert.equal(uploadCheckout({ ...payload, checkout }, event, 'unit', 'linux'), checkout);
  for (const invalid of [{ checkout: 'C'.repeat(40) }, { checkout: 7 }, { commit: base }, { shard: 'mac' }])
    assert.throws(() => uploadCheckout({ ...payload, ...invalid }, event, 'unit', 'linux'), /does not match/);

  const files = deserialize({ 'src/a.ts': { lines: { 2: [1] } } });
  const diffed: string[] = [];
  const remap = checkoutRemapper(async (sha) => {
    diffed.push(sha);
    return sha === checkout
      ? new Map([
          [
            'src/a.ts',
            { lines: new Set([1]), segments: [{ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 2 }] },
          ],
        ])
      : undefined;
  });
  assert.equal(await remap(files, undefined), files);
  assert.deepEqual(serialize(await remap(files, checkout)), { 'src/a.ts': { lines: { 1: [1] } } });
  assert.deepEqual(serialize(await remap(files, checkout)), { 'src/a.ts': { lines: { 1: [1] } } });
  for (const other of ['1', '2', '3']) assert.equal(await remap(files, other.repeat(40)), files);
  await assert.rejects(remap(files, '4'.repeat(40)), /too many test checkouts/);
  assert.deepEqual(diffed, [checkout, '1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]);
  assert.equal(await checkoutRemapper()(files, checkout), files);
});

/** Builds a single-entry, uncompressed ZIP like the archives GitHub serves for artifacts. */
function storedZip(name: string, data: Buffer) {
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  const directoryOffset = local.length + file.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

// Why this test exists: Node's --experimental-test-coverage uses V8 block
// coverage, which reports branches on a best-effort basis. A branch that never
// runs, such as the `throw` on the expanded-size check in loadUploads, can be
// recorded as an uncovered branch in one CI run and left out in the next, even
// on the same OS. Mustard merges the Linux and Windows uploads, so one flicker
// moves project coverage by a line and lists the untouched file under
// "Indirect changes". The project check uses `target: auto` with no threshold,
// so a flicker in the losing direction fails the PR. To diagnose a coverage
// change that a PR did not cause, download the upload artifacts from the
// baseline push run and the PR run (gh run download <id>), gunzip
// coverage.json.gz, and diff `files[path].lines` per OS. An entry such as
// [hits, 0, 1] in one run and [hits] in the other is this flicker. The fix is
// to test the branch: once it runs, V8 reports it in every run.
test('rejects uploads whose expanded data exceeds the per-run limit', async () => {
  const json = JSON.stringify({ schema, commit: head, flags: ['default'], files: {} });
  // Each payload expands to just under the per-upload limit, so the fifth
  // upload pushes the total past the 128 MiB per-run limit.
  const zip = storedZip('coverage.json.gz', gzipSync(json.padEnd(maxBytes - 1024, ' ')));
  const digest = `sha256:${createHash('sha256').update(zip).digest('hex')}`;
  const uploads = Array.from({ length: 5 }, (_, index) => ({
    id: 100 + index,
    name: `mustard-upload-default-${event.runId}-1-${String(index).padStart(8, '0')}-0000-0000-0000-000000000000`,
    expired: false,
    size_in_bytes: zip.length,
    digest,
  }));
  const api = {
    rest: { actions: { listWorkflowRunArtifacts: mock.fn() } },
    paginate: {
      iterator: async function* () {
        yield { data: uploads };
      },
    },
  } as unknown as GitHub;
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(zip)));
  try {
    await assert.rejects(
      loadUploads(api, event, 'example', names('')),
      /exceed the per-run expanded size limit/,
    );
    assert.equal(fetchMock.mock.callCount(), 5);
  } finally {
    fetchMock.mock.restore();
  }
});
