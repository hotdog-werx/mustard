import { type getOctokit, context } from '@actions/github';
import { getInput, warning } from '@actions/core';
import { readConfig } from './config.ts';
import { safePath } from './coverage.ts';

export type GitHub = ReturnType<typeof getOctokit>;
export type Repo = { owner: string; repo: string };
export type Pull = {
  number: number;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } | null };
};
export type Run = {
  id: number;
  run_attempt?: number;
  path: string;
  head_sha: string;
  head_branch: string | null;
  status: string | null;
  event: string;
  updated_at: string;
  head_repository: { full_name: string; owner: { login: string } } | null;
};
export type Event = {
  mode: 'report' | 'comment';
  runId: number;
  attempt: number;
  event: string;
  commit: string;
  coverageCommit: string;
  base?: string;
  pull?: Pull;
  fork: boolean;
  workflow: string;
  branch?: string;
  defaultBranch: string;
  repo: Repo;
};

/** Validates a full Git commit SHA before it is used in paths or API queries. */
export function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value))
    throw new Error('Invalid GitHub commit SHA');
  return value;
}

/** Reads an HTTP status from an API error without assuming its shape. */
export function statusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number')
    return error.status;
}

/** Builds the owner/name identifier used by GitHub APIs and provenance checks. */
export function repository(repo: Repo): string {
  return `${repo.owner}/${repo.repo}`;
}

/** Extracts and validates a repository-relative workflow file from a workflow reference. */
function workflowPath(ref: string): string {
  const path = ref.replace(/^[^/]+\/[^/]+\/(?=\.github\/)/, '').split('@')[0];
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(path))
    throw new Error('Invalid baseline workflow path');
  return path;
}

/** Finds the open pull request whose repository, branch, and head match a completed workflow run. */
export async function resolvePull(api: GitHub, repo: Repo, run: Run): Promise<Pull | undefined> {
  if (!run.head_repository || !run.head_branch) return;
  const pulls = await api.paginate(api.rest.pulls.list, {
    ...repo,
    head: `${run.head_repository.owner.login}:${run.head_branch}`,
    state: 'open',
    per_page: 100,
  });
  const matched = pulls.filter(
    (pull) =>
      pull.head.sha === run.head_sha &&
      pull.head.ref === run.head_branch &&
      pull.head.repo?.full_name.toLowerCase() === run.head_repository?.full_name.toLowerCase() &&
      pull.base.repo?.full_name.toLowerCase() === repository(repo).toLowerCase(),
  );
  if (matched.length > 1)
    throw new Error('Several open PRs match the triggering run. Mustard cannot select one safely.');
  return matched[0];
}

/** Rebuilds a fork PR event from the exact workflow run and attempt. */
async function getCommentEvent(
  api: GitHub,
  repo: Repo,
  defaultBranch: string,
  workflowInput: string,
): Promise<Event | undefined> {
  const { payload } = context;
  if (context.eventName !== 'workflow_run' || payload.action !== 'completed') {
    throw new Error('comment mode requires a completed workflow_run event');
  }
  const id = Number(payload.workflow_run?.id);
  const override = getInput('run-id');
  if (!Number.isSafeInteger(id) || id <= 0 || (override && override !== String(id))) {
    throw new Error('run-id must match the triggering workflow_run');
  }
  const { data: run } = await api.rest.actions.getWorkflowRun({ ...repo, run_id: id });
  const payloadRun = payload.workflow_run;
  if (run.event !== 'pull_request' || run.status !== 'completed') return;
  if (run.head_sha !== payloadRun?.head_sha || run.run_attempt !== payloadRun?.run_attempt) return;
  const pull = await resolvePull(api, repo, run);
  if (!pull || pull.head.repo?.full_name.toLowerCase() === repository(repo).toLowerCase()) return;
  const commit = sha(pull.head.sha);
  // pull_request jobs normally run on refs/pull/N/merge. The upload
  // explicitly records the PR head identity, independently of the test checkout.
  return {
    mode: 'comment',
    runId: id,
    attempt: run.run_attempt ?? 1,
    event: run.event,
    commit,
    coverageCommit: commit,
    pull,
    fork: true,
    workflow: workflowPath(workflowInput || run.path),
    base: sha(pull.base.sha),
    defaultBranch,
    repo,
  };
}

/** Resolves the event, checkout identity, and source run used by report or comment mode. */
export async function getEvent(api: GitHub, mode: Event['mode']): Promise<Event | undefined> {
  const repo = context.repo;
  const payload = context.payload;
  const defaultBranch =
    typeof payload.repository?.default_branch === 'string'
      ? payload.repository.default_branch
      : (await api.rest.repos.get(repo)).data.default_branch;
  const workflowInput = getInput('workflow');
  if (mode === 'comment') return getCommentEvent(api, repo, defaultBranch, workflowInput);
  if (!['pull_request', 'push', 'merge_group'].includes(context.eventName)) {
    throw new Error('report mode supports pull_request, push, and merge_group; use comment for workflow_run');
  }
  const pull = payload.pull_request as Pull | undefined;
  const group = payload.merge_group;
  const commit = sha(pull?.head.sha ?? group?.head_sha ?? context.sha);
  return {
    mode,
    repo,
    defaultBranch,
    pull,
    commit,
    coverageCommit: commit,
    runId: context.runId,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    event: context.eventName,
    workflow: workflowPath(workflowInput || process.env.GITHUB_WORKFLOW_REF || ''),
    base: pull ? sha(pull.base.sha) : group ? sha(group.base_sha) : undefined,
    branch: context.ref.startsWith('refs/heads/') ? context.ref.slice('refs/heads/'.length) : undefined,
    fork: !!pull && pull.head.repo?.full_name.toLowerCase() !== repository(repo).toLowerCase(),
  };
}

const configPaths = [
  '.github/mustard.yml',
  'mustard.yml',
  'codecov.yml',
  '.codecov.yml',
  '.github/codecov.yml',
];
/** Reads the first available supported config file at an exact repository commit. */
export async function configAt(api: GitHub, repo: Repo, ref: string, explicit = '') {
  if (explicit && !safePath(explicit)) throw new Error('Config input must be a repo-relative file path');
  for (const path of explicit ? [explicit] : configPaths) {
    try {
      const { data } = await api.rest.repos.getContent({ ...repo, path, ref: sha(ref) });
      if (
        Array.isArray(data) ||
        data.type !== 'file' ||
        data.encoding !== 'base64' ||
        data.size > 256 * 1024 ||
        !('content' in data)
      )
        throw new Error('Expected a small, regular config file');
      return { path, text: Buffer.from(data.content, 'base64').toString('utf8') };
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }
  }
  return { path: undefined, text: '' };
}

/** Loads trusted coverage policy and allows a head-policy override only for a same-repository pull request. */
export async function loadConfig(api: GitHub, event: Event, base: string | undefined) {
  const explicit = getInput('config');
  const atBase = await configAt(api, event.repo, base ?? event.commit, explicit);
  const config = readConfig(atBase.text, warning);
  if (atBase.path?.includes('codecov.yml')) warning(`Reading ${atBase.path} in Codecov compatibility mode`);
  const requested = getInput('config-source');
  if (requested && requested !== 'base' && requested !== 'head')
    throw new Error('config-source must be base or head');
  if (event.pull && !event.fork && (requested || config.source) === 'head') {
    const atHead = await configAt(api, event.repo, event.commit, explicit);
    if (explicit && !atHead.path) throw new Error('Requested config file does not exist on the PR head');
    return { config: readConfig(atHead.text, warning), text: atHead.text, fromBase: false };
  }
  if (explicit && !atBase.path) throw new Error('Requested config file does not exist at the trusted commit');
  return { config, text: atBase.text, fromBase: !!base };
}

/** Identifies pushes eligible for signing based on the branch allowlist, before protection is checked. */
export function isProtectedSource(event: Event, branches: string[]): boolean {
  return (
    event.event === 'push' &&
    !!event.branch &&
    (event.branch === event.defaultBranch || branches.includes(event.branch))
  );
}
