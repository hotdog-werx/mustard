import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warning } from '@actions/core';
import { maxBytes, maxLines, safePath } from './coverage.ts';
import { repository, sha } from './github.ts';
import type { Event, GitHub } from './github.ts';
import type { Diff } from './report.ts';

export function newLines(patch: string, result = new Set<number>()): Set<number> {
  let next = 0;
  let remaining = 0;
  for (const line of patch.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (remaining) throw new Error('Truncated diff hunk');
      next = Number(hunk[1]);
      remaining = Number(hunk[2] ?? 1);
    } else if (remaining && (line.startsWith('+') || line.startsWith(' '))) {
      if (line.startsWith('+')) result.add(next);
      next++;
      remaining--;
    }
  }
  if (remaining) throw new Error('Truncated diff hunk');
  return result;
}

export function parseGitDiff(names: string, patch: string): Diff {
  const chunks = patch.split(/^diff --git .*\n/m).slice(1);
  const entries = names.split('\0');
  const result: Diff = new Map();
  let chunk = 0;
  for (let index = 0; index < entries.length - 1; ) {
    const kind = entries[index++];
    const from = entries[index++];
    const rename = kind.startsWith('R') || kind.startsWith('C');
    const to = rename ? entries[index++] : from;
    if (chunk >= chunks.length || !to || !from || !safePath(to) || !safePath(from)) {
      throw new Error('Unsupported or inconsistent Git diff paths');
    }
    result.set(to, {
      oldPath: rename ? from : undefined,
      deleted: kind === 'D',
      lines: newLines(chunks[chunk++]),
    });
  }
  if (chunk !== chunks.length) throw new Error('Inconsistent Git diff');
  return result;
}

export function gitDiff(event: Event, base: string, token: string): Diff {
  const server = new URL(process.env.GITHUB_SERVER_URL ?? 'https://github.com');
  if (server.protocol !== 'https:' || server.username || server.password)
    throw new Error('Invalid GitHub server URL');
  const url = new URL(`/${repository(event.repo)}.git`, server);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${server.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'http.followRedirects',
    GIT_CONFIG_VALUE_1: 'false',
  };
  const directory = mkdtempSync(join(tmpdir(), 'mustard-git-'));
  function git(...args: string[]) {
    return execFileSync('git', args, {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: maxBytes,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  try {
    git('init', '--bare', '--template=');
    git('fetch', '--no-tags', '--depth=1', url.href, sha(base), sha(event.commit));
    const options = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '-U0'];
    return parseGitDiff(
      git('diff', ...options, '--name-status', '-z', base, event.commit, '--'),
      git('diff', ...options, base, event.commit, '--'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function compareFiles(
  files: Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    patch?: string;
    additions: number;
  }>,
): { diff: Diff; complete: boolean } {
  const diff: Diff = new Map();
  let complete = files.length < 300;
  for (const file of files) {
    if (!safePath(file.filename) || (file.previous_filename && !safePath(file.previous_filename))) {
      complete = false;
      continue;
    }
    let lines = new Set<number>();
    try {
      lines = file.patch ? newLines(file.patch) : lines;
    } catch {
      complete = false;
    }
    if (lines.size !== file.additions) complete = false;
    diff.set(file.filename, { lines, oldPath: file.previous_filename, deleted: file.status === 'removed' });
  }
  return { diff, complete };
}

export async function getDiff(api: GitHub, event: Event, token: string) {
  if (!event.base) return { base: undefined, diff: new Map() as Diff, complete: true };
  const { data } = await api.rest.repos.compareCommitsWithBasehead({
    ...event.repo,
    basehead: `${event.base}...${event.commit}`,
    per_page: 1,
  });
  const base = sha(data.merge_base_commit.sha);
  let diff: Diff;
  let complete = true;
  try {
    diff = gitDiff(event, base, token);
  } catch {
    warning('Could not diff fetched Git objects. Using the GitHub Compare API.');
    if (!data.files) return { base, diff: new Map() as Diff, complete: false };
    ({ diff, complete } = compareFiles(data.files));
    if (!complete) warning('The GitHub Compare API returned an incomplete diff. Patch checks will fail.');
  }
  const lines = [...diff.values()].reduce((count, change) => count + change.lines.size, 0);
  return { base, diff, complete: complete && lines <= maxLines };
}
