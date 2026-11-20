export const repo = 'example/mustard-action-test';
export const head = 'b'.repeat(40);
export const base = 'a'.repeat(40);
export const merge = 'c'.repeat(40);
export const workflow = '.github/workflows/ci.yaml';
export const githubToken = 'mustard-test-github-token';
export const runtimeToken = `e30.${Buffer.from(JSON.stringify({ scp: 'Actions.Results:run:job' })).toString('base64url')}.c2ln`;
export const api = 'https://api.mustard.invalid';
export const results = 'https://results.mustard.invalid';
export const storage = 'https://storage.mustard.invalid';

export function pull(fork: boolean) {
  return {
    number: 5,
    state: 'open',
    head: { sha: head, ref: 'feature', repo: { full_name: fork ? 'contributor/mustard-action-test' : repo } },
    base: { sha: base, ref: 'main', repo: { full_name: repo } },
  };
}

export const forkRun = {
  id: 7,
  event: 'pull_request',
  status: 'completed',
  head_sha: head,
  run_attempt: 2,
  path: workflow,
  head_branch: 'feature',
  head_repository: { full_name: 'contributor/mustard-action-test', owner: { login: 'contributor' } },
};

export const baseConfig = `require_uploads: true
baseline: {attestations: off, max_walk: 0}
coverage:
  status:
    project:
      default: {target: 60%}
`;

export const changedCoverage = 'SF:src/example.ts\nDA:1,1\nDA:2,0\nDA:3,1\nend_of_record\n';
export const fullCoverage = 'SF:src/example.ts\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n';
