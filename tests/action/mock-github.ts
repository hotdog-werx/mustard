import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nock from 'nock';
import { mockSigning } from './mock-signing.ts';
import {
  api,
  base,
  baseConfig,
  forkRun,
  githubToken,
  head,
  merge,
  pull,
  repo,
  results,
  runtimeToken,
  storage,
  workflow,
} from './scenario.ts';

type Archive = {
  id: number;
  run: number;
  name: string;
  size_in_bytes?: number;
  digest?: string;
  expired?: boolean;
};
type Call = { method: string; route: string; body: unknown };
type State = { archives: Archive[]; calls: Call[] };
const directory = process.env.MUSTARD_TEST_STATE;
assert.ok(directory, 'MUSTARD_TEST_STATE is required');
const stateFile = join(directory, 'state.json');
const eventKind = process.env.MUSTARD_TEST_EVENT ?? 'pull_request';
const fork = process.env.MUSTARD_TEST_FORK === 'true' || eventKind === 'workflow_run';
const runId = eventKind === 'push' ? 6 : eventKind === 'workflow_run' ? 8 : 7;
const attempt = process.env.MUSTARD_TEST_ATTEMPT ?? (eventKind === 'push' ? '1' : '2');
const eventFile = join(directory, 'event.json');
const signPush = eventKind === 'push' && process.env.MUSTARD_TEST_SIGN === 'true';
const repository = { default_branch: 'main', visibility: signPush ? 'private' : 'public' };
const badgeTip = process.env.MUSTARD_TEST_BADGE_TIP;

writeFileSync(
  eventFile,
  JSON.stringify({
    repository,
    ...(eventKind === 'pull_request' ? { pull_request: pull(fork) } : {}),
    ...(eventKind === 'workflow_run' ? { action: 'completed', workflow_run: forkRun } : {}),
    ...(eventKind === 'merge_group' ? { merge_group: { base_sha: base, head_sha: head } } : {}),
  }),
);
Object.assign(process.env, {
  ...(process.env.MUSTARD_TEST_WORKSPACE ? { GITHUB_WORKSPACE: process.env.MUSTARD_TEST_WORKSPACE } : {}),
  GITHUB_API_URL: api,
  GITHUB_SERVER_URL: signPush ? 'https://github.com' : 'http://mustard.localhost',
  GITHUB_EVENT_NAME: eventKind,
  GITHUB_EVENT_PATH: eventFile,
  GITHUB_REPOSITORY: repo,
  GITHUB_RUN_ID: String(runId),
  GITHUB_RUN_ATTEMPT: attempt,
  GITHUB_WORKFLOW_REF: `${repo}/${workflow}@refs/heads/main`,
  GITHUB_SHA: eventKind === 'push' ? base : eventKind === 'pull_request' ? merge : head,
  GITHUB_REF: eventKind === 'push' ? 'refs/heads/main' : 'refs/pull/5/merge',
  ACTIONS_RUNTIME_TOKEN: runtimeToken,
  ACTIONS_RESULTS_URL: results,
  'INPUT_GITHUB-TOKEN': githubToken,
});

function readState(): State {
  return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { archives: [], calls: [] };
}

function update(change: (state: State) => void) {
  const state = readState();
  change(state);
  writeFileSync(stateFile, JSON.stringify(state));
}

function record(method: string, route: string, body: unknown) {
  update((state) => state.calls.push({ method, route, body }));
}

function noRoute(method: string, route: string): [number, { message: string }] {
  return [500, { message: `Unexpected fixture route ${method} ${route}` }];
}

nock.disableNetConnect();
if (signPush) mockSigning();

const github = nock(api, { reqheaders: { authorization: `token ${githubToken}` } }).persist();
github.get(/.*/).reply((request: Request) => {
  const url = new URL(request.url);
  const route = decodeURIComponent(url.pathname).replace(`/repos/${repo}`, '');
  record('GET', route, null);
  if (route === '/actions/runs/7') {
    return [
      200,
      process.env.MUSTARD_TEST_FORK_RERUN === 'true'
        ? { ...forkRun, run_attempt: forkRun.run_attempt + 1 }
        : forkRun,
    ];
  }
  if (route === '/pulls') return [200, [pull(fork)]];
  if (route === '/pulls/5') {
    const current = pull(fork);
    if (process.env.MUSTARD_TEST_PR_UPDATED === 'true') current.head.sha = merge;
    if (process.env.MUSTARD_TEST_BASE_MOVED === 'true') current.base.sha = 'f'.repeat(40);
    return [200, current];
  }
  if (route.startsWith('/compare/')) {
    return [
      200,
      {
        merge_base_commit: { sha: base },
        files: [
          {
            filename: 'src/example.ts',
            status: 'modified',
            additions: process.env.MUSTARD_TEST_INCOMPLETE_DIFF === 'true' ? 3 : 2,
            patch: '@@ -1,2 +1,2 @@\n-old\n-old\n+one\n+two',
          },
        ],
      },
    ];
  }
  if (route.startsWith('/contents/') && process.env.MUSTARD_TEST_NO_CONFIG === 'true')
    return [404, { message: 'Not Found' }];
  if (route === '/contents/.github/mustard.yml' && process.env.MUSTARD_TEST_CODECOV === 'true')
    return [404, { message: 'Not Found' }];
  if (route === '/contents/mustard.yml') return [404, { message: 'Not Found' }];
  if (route === '/contents/.github/mustard.yml' || route === '/contents/codecov.yml') {
    const ref = url.searchParams.get('ref');
    const required = signPush || process.env.MUSTARD_TEST_REQUIRE_ATTESTATION === 'true';
    const config =
      fork && ref === head
        ? 'require_uploads: false\ncomment: {behavior: off}'
        : required
          ? 'require_uploads: true\nbaseline: {attestations: required, required: true, max_walk: 0}'
          : baseConfig;
    const headConfig = ref === head ? process.env.MUSTARD_TEST_HEAD_CONFIG : undefined;
    const text = (headConfig ?? config) + (process.env.MUSTARD_TEST_CONFIG_SUFFIX ?? '');
    return [
      200,
      { type: 'file', encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64') },
    ];
  }
  if (route === '/actions/runs') {
    const runs = readState().archives.some((item) => item.run === 6 && item.name.includes('-report-'))
      ? [
          {
            ...forkRun,
            id: 6,
            event: 'push',
            head_sha: base,
            head_branch: 'main',
            run_attempt: 1,
            head_repository: { full_name: repo, owner: { login: 'example' } },
            updated_at: '2026-01-01T00:00:00Z',
          },
        ]
      : [];
    return [200, { total_count: runs.length, workflow_runs: runs }];
  }
  const listing = route.match(/^\/actions\/runs\/(\d+)\/artifacts$/);
  if (listing) {
    const name = url.searchParams.get('name');
    const artifacts = readState().archives.filter(
      (item) => item.run === Number(listing[1]) && item.digest && (!name || item.name === name),
    );
    if (process.env.MUSTARD_TEST_BAD_DIGEST === 'true' && artifacts.length)
      artifacts[0].digest = 'sha256:fixture-mismatch';
    return [200, { total_count: artifacts.length, artifacts }];
  }
  if (route === '/issues/5/comments') return [200, []];
  if (route === '/branches/main')
    return [200, { name: 'main', protected: true, commit: { sha: badgeTip === 'stale' ? head : base } }];
  if (route === '/branches/mustard-badges') {
    if (badgeTip === 'unrelated' || badgeTip === 'owned')
      return [200, { name: 'mustard-badges', protected: false, commit: { sha: 'existing-tip' } }];
    return [404, { message: 'Branch not found' }];
  }
  if (route === '/git/commits/existing-tip')
    return [
      200,
      badgeTip === 'owned'
        ? { parents: [], message: 'Publish Mustard coverage badges' }
        : { parents: [{ sha: base }], message: 'Existing project branch' },
    ];
  if (route === `/commits/${base}`) return [200, { parents: [] }];
  if (route.startsWith('/attestations/sha256:')) return [200, { attestations: [] }];
  return noRoute('GET', route);
});

for (const method of ['POST', 'PATCH'] as const) {
  github.intercept(/.*/, method).reply(async (request: Request) => {
    const body = await request.json();
    const route = decodeURIComponent(new URL(request.url).pathname).replace(`/repos/${repo}`, '');
    record(method, route, body);
    if (route === '/git/trees' && method === 'POST') return [201, { sha: 'badge-tree' }];
    if (route === '/git/commits' && method === 'POST') return [201, { sha: 'badge-commit' }];
    if (route === '/git/refs/heads/mustard-badges' && method === 'PATCH')
      return badgeTip === 'owned'
        ? [200, { ref: 'refs/heads/mustard-badges' }]
        : [404, { message: 'Ref not found' }];
    if (route === '/git/refs' && method === 'POST') return [201, { ref: 'refs/heads/mustard-badges' }];
    if (route === '/attestations' && signPush) return [201, { id: 'test-attestation' }];
    if (route === '/check-runs' && process.env.MUSTARD_TEST_DENY === 'checks')
      return [403, { message: 'Resource not accessible by integration' }];
    if (route === '/issues/5/comments' && process.env.MUSTARD_TEST_DENY === 'comments')
      return [403, { message: 'Resource not accessible by integration' }];
    if (route === '/check-runs') return [201, { id: 70 }];
    if (route === '/check-runs/70' || route === '/issues/5/comments') return [200, { id: 90 }];
    return noRoute(method, route);
  });
}

nock(api, { reqheaders: { authorization: `Bearer ${githubToken}` } })
  .persist()
  .get(/\/actions\/artifacts\/\d+\/zip$/)
  .reply((request: Request) => {
    const id = new URL(request.url).pathname.split('/').at(-2);
    record('GET', `artifact/${id}`, null);
    return [200, readFileSync(join(directory, `${id}.zip`)), { 'content-type': 'application/zip' }];
  });

nock(results, { reqheaders: { authorization: `Bearer ${runtimeToken}` } })
  .persist()
  .post(/\/twirp\/.*\/(?:CreateArtifact|FinalizeArtifact)$/)
  .reply(async (request: Request) => {
    const body = (await request.json()) as { name: string; size: string; hash: string };
    if (new URL(request.url).pathname.endsWith('/CreateArtifact')) {
      const { archives } = readState();
      if (archives.some((item) => item.run === runId && item.name === body.name))
        return [409, { msg: 'Artifact already exists in this workflow run' }];
      const id = archives.length + 1;
      update((state) => state.archives.push({ id, name: body.name, run: runId }));
      return [200, { ok: true, signed_upload_url: `${storage}/container/${id}.zip` }];
    }
    const archive = readState().archives.find((item) => item.run === runId && item.name === body.name);
    assert.ok(archive);
    const bytes = readFileSync(join(directory, `${archive.id}.zip`));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.equal(body.hash, digest);
    assert.equal(Number(body.size), bytes.length);
    update((state) =>
      Object.assign(state.archives[archive.id - 1], { digest, size_in_bytes: bytes.length, expired: false }),
    );
    return [200, { ok: true, artifact_id: String(archive.id) }];
  });

nock(storage)
  .persist()
  .put(/\/container\/\d+\.zip$/)
  .query(true)
  .reply(async (request: Request) => {
    const url = new URL(request.url);
    const id = url.pathname.split('/').at(-1)?.split('.')[0];
    assert.ok(id);
    const operation = url.searchParams.get('comp');
    if (operation === 'blocklist') {
      assert.ok(existsSync(join(directory, `${id}.zip`)), 'Commit requires the staged ZIP block');
    } else {
      assert.ok(operation === null || operation === 'block');
      const bytes = Buffer.from(await request.arrayBuffer());
      writeFileSync(join(directory, `${id}.zip`), bytes);
    }
    return [201, '', { etag: '"test-etag"', 'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT' }];
  });
