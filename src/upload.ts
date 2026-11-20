import { execFileSync } from 'node:child_process';
import { globSync, mkdtempSync, rmSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { getInput, getBooleanInput, info, warning } from '@actions/core';
import { context } from '@actions/github';
import { putArtifact, uploadName, uploadPayload } from './artifacts.ts';
import type { Names } from './artifacts.ts';
import { parseFix, readConfig } from './config.ts';
import type { Fix } from './config.ts';
import { assertBudget, integer, maxBytes, mergeFiles, safePath, slug } from './coverage.ts';
import type { Files } from './coverage.ts';
import { configAt, sha } from './github.ts';
import type { GitHub } from './github.ts';
import { existsIn, normalizePath } from './paths.ts';
import { parseCoverage } from './parsers.ts';

export function retention(): number | undefined {
  const value = getInput('retention-days');
  return value ? integer(value, 1, 400) : undefined;
}

function inputs(input: string, workspace: string): string[] {
  const patterns = input
    ? input
        .split(/\r?\n/)
        .map((pattern) => pattern.trim())
        .filter(Boolean)
    : ['coverage.xml', 'coverage.json', 'coverage.lcov', 'lcov.info', 'coverage.out', 'jacoco.xml'];
  const paths = new Set<string>();
  for (const raw of patterns) {
    const path = isAbsolute(raw) ? relative(workspace, raw) : raw;
    if (!safePath(path.replaceAll('\\', '/').replace(/^\.\//, ''))) {
      throw new Error('Coverage file globs must stay inside GITHUB_WORKSPACE');
    }
    for (const match of globSync(path, { cwd: workspace })) {
      const candidate = match.replaceAll('\\', '/');
      if (!existsIn(workspace, candidate)) continue;
      paths.add(join(workspace, match));
      if (paths.size > 128) throw new Error('Coverage glob matched too many files');
    }
  }
  return [...paths].sort();
}

async function readLimited(path: string, limit: number): Promise<string> {
  if (statSync(path).size > limit) throw new Error('Coverage input exceeds the size limit');
  const stream = createReadStream(path);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('Coverage input exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function generateCoverage(workspace: string): Promise<string> {
  if (!globSync(['.coverage', '.coverage.*'], { cwd: workspace }).some((path) => existsIn(workspace, path))) {
    throw new Error(
      'No coverage files found. Set the files input to coverage reports produced by your tests.',
    );
  }
  const temporary = mkdtempSync(join(tmpdir(), 'mustard-coverage-'));
  const output = join(temporary, 'coverage.json');
  const data = join(temporary, '.coverage');
  function run(...args: string[]) {
    execFileSync('python3', ['-m', 'coverage', ...args], {
      cwd: workspace,
      stdio: 'pipe',
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
  }
  try {
    try {
      const parts = globSync('.coverage.*', { cwd: workspace }).filter((path) => existsIn(workspace, path));
      if (parts.length) {
        const files = existsIn(workspace, '.coverage') ? ['.coverage', ...parts] : parts;
        run('combine', '--keep', '--data-file', data, ...files.map((file) => join(workspace, file)));
      }
      run('json', '--data-file', parts.length ? data : join(workspace, '.coverage'), '-o', output);
    } catch {
      throw new Error(
        'Could not convert coverage.py data. Install coverage in the test environment or provide coverage JSON/XML.',
      );
    }
    return await readLimited(output, maxBytes);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function pathResolver(workspace: string, root: string, fixes: Fix[]) {
  const unmatched = new Set<string>();
  const normalized = new Map<string, string>();
  function normalize(raw: string, sources: string[] = []) {
    // Relative Cobertura paths resolve against each report's own <sources>, so
    // the same raw name can mean different files in different reports.
    const key = JSON.stringify([raw, sources]);
    const seen = normalized.get(key);
    if (seen) return seen;
    const path = normalizePath(raw, workspace, root, fixes);
    const candidates = [path];
    if (!/^(?:[A-Za-z]:)?[/\\]/.test(raw)) {
      for (const source of sources)
        candidates.push(normalizePath(`${source}/${raw}`, workspace, root, fixes));
    }
    const found = candidates.find((candidate) => existsIn(workspace, candidate));
    if (!found) unmatched.add(raw);
    const result = found ?? path;
    if (!safePath(result)) return '';
    normalized.set(key, result);
    return result;
  }
  return { normalize, unmatched };
}

export async function upload(api: GitHub, namespace: Names, workspace: string) {
  const pull = context.payload.pull_request;
  const commit = sha(pull?.head.sha ?? context.payload.merge_group?.head_sha ?? context.sha);
  const testCheckout = sha(context.sha);
  const { text } = await configAt(api, context.repo, testCheckout, getInput('config'));
  const config = readConfig(text, warning);
  const fixes = [...config.fixes, ...getInput('path-fixes').split(/\r?\n/).filter(Boolean).map(parseFix)];
  const root = getInput('root');
  const { normalize, unmatched } = pathResolver(workspace, root, fixes);
  const format = getInput('format') || 'auto';
  const flag = slug(getInput('flag') || 'default');
  const fileInput = getInput('files');
  const paths = inputs(fileInput, workspace);
  const files: Files = new Map();
  const ingest = (data: string) => {
    const parsed = parseCoverage(data, format, normalize);
    parsed.delete('');
    mergeFiles(files, parsed);
    assertBudget([files]);
  };
  if (!paths.length) {
    if (fileInput) throw new Error('No files matched the files input');
    ingest(await generateCoverage(workspace));
  }
  let remaining = maxBytes;
  for (const path of paths) {
    const data = await readLimited(path, remaining);
    remaining -= Buffer.byteLength(data);
    ingest(data);
  }
  if (unmatched.size) {
    const message = `${unmatched.size} coverage path(s) did not match the checkout: ${[...unmatched]
      .slice(0, 10)
      .map((path) => JSON.stringify(path.slice(0, 180)))
      .join(', ')}`;
    if (getBooleanInput('strict-paths')) throw new Error(message);
    warning(message);
  }
  if (!files.size) throw new Error('Coverage reports contain no usable coverable lines');
  const run = integer(context.runId, 1);
  const attempt = integer(process.env.GITHUB_RUN_ATTEMPT ?? 1, 1);
  const name = uploadName(namespace.artifact, flag, run, attempt);
  const { id, digest } = await putArtifact(
    name,
    new Map([['coverage.json.gz', uploadPayload(commit, flag, files)]]),
    retention(),
  );
  info(`Uploaded ${name} (artifact ${id}, SHA-256 ${digest})`);
}
