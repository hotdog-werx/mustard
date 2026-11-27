import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warning } from '@actions/core';
import { maxBytes, maxLines, safePath } from './coverage.ts';
import { repository, sha } from './github.ts';
import type { Event, GitHub } from './github.ts';
import type { Files, Line } from './coverage.ts';
import type { Diff, Segment } from './report.ts';

/** Gives the first line a hunk side covers. An empty side names the line before the change. */
function hunkStart(start: string, count: string | undefined) {
  return Number(start) + (count === '0' ? 1 : 0);
}

/** Tracks both sides of one diff while grouping consecutive added and removed lines into segments. */
class PatchReader {
  lines = new Set<number>();
  segments: Segment[] = [];
  private old = 0;
  private next = 0;
  private oldLeft = 0;
  private newLeft = 0;
  private open?: { oldStart: number; newStart: number };

  /** Starts a hunk after checking that the previous one was complete. */
  hunk(header: RegExpExecArray) {
    this.finish();
    [this.old, this.oldLeft] = [hunkStart(header[1], header[2]), Number(header[2] ?? 1)];
    [this.next, this.newLeft] = [hunkStart(header[3], header[4]), Number(header[4] ?? 1)];
  }

  /** Advances past one body line. Lines beyond the hunk's counts, such as "\ No newline", are ignored. */
  line(text: string) {
    const kind = text[0];
    if (kind === ' ' && this.oldLeft && this.newLeft) {
      this.close();
      [this.old, this.oldLeft, this.next, this.newLeft] = [
        this.old + 1,
        this.oldLeft - 1,
        this.next + 1,
        this.newLeft - 1,
      ];
    } else if (kind === '+' && this.newLeft) {
      this.open ??= { oldStart: this.old, newStart: this.next };
      this.lines.add(this.next);
      [this.next, this.newLeft] = [this.next + 1, this.newLeft - 1];
    } else if (kind === '-' && this.oldLeft) {
      this.open ??= { oldStart: this.old, newStart: this.next };
      [this.old, this.oldLeft] = [this.old + 1, this.oldLeft - 1];
    }
  }

  /** Ends the current hunk and rejects one whose body was cut short. */
  finish() {
    if (this.oldLeft || this.newLeft) throw new Error('Truncated diff hunk');
    this.close();
  }

  private close() {
    if (this.open) this.segments.push({ ...this.open, oldEnd: this.old, newEnd: this.next });
    this.open = undefined;
  }
}

/**
 * Reads a unified diff into the added line numbers and the runs of changed lines on both sides.
 * Rejects a truncated hunk.
 */
export function parsePatch(patch: string): { lines: Set<number>; segments: Segment[] } {
  const reader = new PatchReader();
  for (const line of patch.split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) reader.hunk(header);
    else reader.line(line);
  }
  reader.finish();
  return { lines: reader.lines, segments: reader.segments };
}

/** Collects added line numbers on the new side of a unified diff and rejects a truncated hunk. */
export function newLines(patch: string): Set<number> {
  return parsePatch(patch).lines;
}

/** Maps a line on the new side of a diff to the old side, or undefined for a line the diff added. */
export function oldLine(line: number, segments: Segment[]): number | undefined {
  let shift = 0;
  for (const segment of segments) {
    if (line < segment.newStart) break;
    if (line < segment.newEnd) return undefined;
    shift = segment.oldEnd - segment.newEnd;
  }
  return line + shift;
}

/**
 * Moves coverage measured on the new side of a diff to the old side's paths and line numbers.
 * Lines and files that exist only on the new side are dropped.
 */
export function remapFiles(files: Files, diff: Diff): Files {
  const result: Files = new Map();
  for (const [path, lines] of files) {
    const change = diff.get(path);
    if (change?.deleted) continue;
    const mapped = new Map<number, Line>();
    for (const [number, line] of lines) {
      const target = change?.segments ? oldLine(number, change.segments) : number;
      if (target !== undefined) mapped.set(target, line);
    }
    if (mapped.size) result.set(change?.oldPath ?? path, mapped);
  }
  return result;
}

/** Combines Git’s NUL-delimited path list and patch, retaining rename origins and deletion markers. */
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
      ...parsePatch(chunks[chunk++]),
    });
  }
  if (chunk !== chunks.length) throw new Error('Inconsistent Git diff');
  return result;
}

/** Fetches the two exact revisions into a temporary bare repository and computes their diff. */
export function gitDiff(event: Event, base: string, token: string, head = event.commit): Diff {
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
    git('fetch', '--no-tags', '--depth=1', url.href, sha(base), sha(head));
    const options = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '-U0'];
    return parseGitDiff(
      git('diff', ...options, '--name-status', '-z', base, head, '--'),
      git('diff', ...options, base, head, '--'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Converts GitHub’s Compare API file list to a diff and marks truncated or inconsistent data. */
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
    let parsed: ReturnType<typeof parsePatch> = { lines: new Set(), segments: [] };
    try {
      if (file.patch) parsed = parsePatch(file.patch);
    } catch {
      complete = false;
    }
    if (parsed.lines.size !== file.additions) complete = false;
    diff.set(file.filename, {
      ...parsed,
      oldPath: file.previous_filename,
      deleted: file.status === 'removed',
    });
  }
  return { diff, complete };
}

/** Finds the merge base and prefers a local Git diff, with the GitHub comparison as a fallback. */
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

/**
 * Diffs the PR head against the commit the tests ran on, usually GitHub's merge commit.
 * Returns undefined, with a warning, when no complete diff is available.
 */
export async function checkoutDiff(
  api: GitHub,
  event: Event,
  token: string,
  checkout: string,
): Promise<Diff | undefined> {
  const head = event.coverageCommit;
  try {
    return gitDiff(event, head, token, checkout);
  } catch {}
  try {
    const { data } = await api.rest.repos.compareCommitsWithBasehead({
      ...event.repo,
      basehead: `${head}...${checkout}`,
      per_page: 1,
    });
    // A three-dot comparison starts at the merge base, which is the head only when the checkout descends from it.
    if (data.merge_base_commit.sha === head && data.files) {
      const { diff, complete } = compareFiles(data.files);
      if (complete) return diff;
    }
  } catch {}
  warning(
    `Could not map coverage from test checkout ${checkout.slice(0, 12)} to PR head ${head.slice(0, 12)}. Patch lines may be offset in files the base branch changed.`,
  );
}
