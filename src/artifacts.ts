import artifact from '@actions/artifact';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import yauzl from 'yauzl';
import type { ZipFile, Entry } from 'yauzl';
import {
  assertBudget,
  deserialize,
  maxBytes,
  mergeFiles,
  record,
  schema,
  serialize,
  slug,
} from './coverage.ts';
import type { Files, FlagFiles } from './coverage.ts';
import type { Event, GitHub, Repo } from './github.ts';

const maxArchive = maxBytes + 2 * 1024 * 1024;
const maxArtifacts = 256;
const maxRunBytes = 128 * 1024 * 1024;
export type Artifact = {
  id: number;
  name: string;
  expired: boolean;
  size_in_bytes: number;
  digest?: string | null;
  created_at?: string | null;
};
export type Names = { artifact: string; check: string; marker: string };

export function names(input: string): Names {
  const scope = input ? slug(input) : '';
  return {
    artifact: scope ? `mustard-${scope.length}-${scope}` : 'mustard',
    check: scope ? `mustard[${scope}]` : 'mustard',
    marker: scope ? `<!-- mustard:comment:${scope} -->` : '<!-- mustard:comment -->',
  };
}

export function gz(data: unknown): Buffer {
  const buffer = Buffer.from(JSON.stringify(data));
  if (buffer.length > maxBytes) throw new Error('Coverage data exceeds the report size limit');
  return gzipSync(buffer);
}

function unz(data: Buffer): Buffer {
  return gunzipSync(data, { maxOutputLength: maxBytes });
}

export function uploadName(
  prefix: string,
  flag: string,
  run: number,
  attempt: number,
  shard?: string,
): string {
  const suffix = shard ? `~${slug(shard)}` : '';
  return `${prefix}-upload-${slug(flag)}-${run}-${attempt}-${randomUUID()}${suffix}`;
}

export function uploadPayload(commit: string, flag: string, files: Files, shard?: string) {
  return gz({ schema, commit, flags: [flag], shard, files: serialize(files) });
}

export async function putArtifact(
  name: string,
  contents: Map<string, Buffer | string>,
  retentionDays?: number,
) {
  const directory = await mkdtemp(join(tmpdir(), 'mustard-artifact-'));
  try {
    const paths: string[] = [];
    for (const [file, data] of contents) {
      const path = join(directory, file);
      await writeFile(path, data);
      paths.push(path);
    }
    const result = await artifact.uploadArtifact(name, paths, directory, {
      retentionDays,
      compressionLevel: 0,
    });
    if (!result.id || !result.digest) throw new Error('GitHub did not return the artifact ID and digest');
    return { id: result.id, digest: result.digest.replace(/^sha256:/, '') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function listArtifacts(
  api: GitHub,
  repo: Repo,
  runId: number,
  name?: string,
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  for await (const page of api.paginate.iterator(api.rest.actions.listWorkflowRunArtifacts, {
    ...repo,
    run_id: runId,
    per_page: 100,
    name,
  })) {
    artifacts.push(...page.data);
    if (artifacts.length > 1000) throw new Error('Workflow run contains too many artifacts');
  }
  return artifacts;
}

async function boundedBody(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`Artifact download failed (HTTP ${response.status})`);
  if (Number(response.headers.get('content-length')) > maxArchive)
    throw new Error('Artifact exceeds the download size limit');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxArchive) throw new Error('Artifact exceeds the download size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, size);
}

function openZip(data: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, strictFileNames: true }, (error, zip) =>
      error ? reject(error) : resolve(zip),
    );
  });
}

async function entryBytes(zip: ZipFile, entry: Entry): Promise<Buffer> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Artifact entry exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function readZip(data: Buffer, allowed: string[]): Promise<Map<string, Buffer>> {
  const zip = await openZip(data);
  const files = new Map<string, Buffer>();
  try {
    if (zip.entryCount !== allowed.length) throw new Error('Unexpected artifact file count');
    let size = 0;
    for await (const entry of zip.eachEntry()) {
      if (!allowed.includes(entry.fileName) || files.has(entry.fileName))
        throw new Error('Unexpected file in coverage artifact');
      size += entry.uncompressedSize;
      if (size > maxBytes) throw new Error('Artifact exceeds the expanded size limit');
      files.set(entry.fileName, await entryBytes(zip, entry));
    }
    return files;
  } finally {
    zip.close();
  }
}

function requiredEntry(archive: Map<string, Buffer>, name: string): Buffer {
  const entry = archive.get(name);
  if (!entry) throw new Error(`Coverage artifact is missing ${name}`);
  return entry;
}

export async function downloadArtifact(repo: Repo, entry: Artifact, token: string) {
  if (entry.size_in_bytes > maxArchive) throw new Error('Artifact exceeds the download size limit');
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const url = `${base}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/artifacts/${entry.id}/zip`;
  const signal = AbortSignal.timeout(60_000);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    redirect: 'manual',
    signal,
  });
  const location = response.headers.get('location');
  let bytes: Buffer;
  if (response.status === 302 && location) {
    await response.body?.cancel();
    const redirect = new URL(location);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password)
      throw new Error('Invalid artifact download URL');
    bytes = await boundedBody(await fetch(redirect, { signal, redirect: 'error' }));
  } else {
    bytes = await boundedBody(response);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (entry.digest !== `sha256:${digest}`) throw new Error('Artifact digest verification failed');
  return { bytes, digest };
}

export async function loadUploads(
  api: GitHub,
  event: Event,
  token: string,
  namespace: Names,
): Promise<FlagFiles> {
  const all = await listArtifacts(api, event.repo, event.runId);
  const prefix = `${namespace.artifact}-upload-`;
  const pattern = new RegExp(
    `^([A-Za-z0-9][A-Za-z0-9_-]{0,63})-${event.runId}-([1-9][0-9]{0,4})-[0-9a-f-]{36}(?:~([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?$`,
  );
  const candidates = all.flatMap((entry) => {
    if (!entry.name.startsWith(prefix)) return [];
    const match = pattern.exec(entry.name.slice(prefix.length));
    const attempt = Number(match?.[2]);
    return match && attempt <= event.attempt ? [{ entry, flag: match[1], attempt, shard: match[3] }] : [];
  });
  const valid = [...Map.groupBy(candidates, ({ flag }) => flag)].flatMap(([flag, uploads]) => {
    // Legacy artifacts cannot distinguish a retried shard from one that first uploaded on retry.
    if (
      uploads.some(({ shard }) => shard === undefined) &&
      uploads.some(({ attempt }) => attempt !== uploads[0].attempt)
    ) {
      throw new Error(
        `Coverage flag "${flag}" has uploads from multiple attempts without stable shard IDs. Set the shard input on each upload and start a new workflow run.`,
      );
    }
    return [...Map.groupBy(uploads, ({ shard }) => shard)].flatMap(([shard, history]) => {
      if (shard === undefined) return history;
      const attempts = Map.groupBy(history, ({ attempt }) => attempt);
      if ([...attempts.values()].some((entries) => entries.length > 1))
        throw new Error(
          `Coverage flag "${flag}" has duplicate uploads for shard "${shard}". Use a distinct shard ID for each upload.`,
        );
      return history.reduce((latest, upload) => (upload.attempt > latest.attempt ? upload : latest));
    });
  });
  if (valid.some(({ entry }) => entry.expired))
    throw new Error('A coverage upload has expired. Start a new workflow run to regenerate all coverage.');
  if (
    valid.length > maxArtifacts ||
    valid.reduce((size, item) => size + item.entry.size_in_bytes, 0) > maxRunBytes
  ) {
    throw new Error('Coverage uploads exceed the per-run size or artifact count limit');
  }
  const flags: FlagFiles = new Map();
  let expanded = 0;
  for (const { entry, flag, shard } of valid.sort((a, b) => a.entry.id - b.entry.id)) {
    const { bytes } = await downloadArtifact(event.repo, entry, token);
    const archive = await readZip(bytes, ['coverage.json.gz']);
    const json = unz(requiredEntry(archive, 'coverage.json.gz'));
    expanded += json.length;
    if (expanded > maxRunBytes) throw new Error('Coverage uploads exceed the per-run expanded size limit');
    const payload = record(JSON.parse(json.toString('utf8')));
    if (
      payload.schema !== schema ||
      payload.commit !== event.coverageCommit ||
      !Array.isArray(payload.flags) ||
      payload.flags.length !== 1 ||
      payload.flags[0] !== flag ||
      payload.shard !== shard
    ) {
      throw new Error('Coverage upload does not match the run commit, schema, flag, or shard');
    }
    flags.set(flag, mergeFiles(flags.get(flag) ?? new Map(), deserialize(payload.files)));
    assertBudget(flags.values());
  }
  return flags;
}

export async function readBaseline(
  bytes: Buffer,
  commit: string,
  runId: number,
  attempt: number,
  workflow: string,
) {
  const archive = await readZip(bytes, ['report.json.gz', 'summary.json', 'meta.json']);
  const meta = record(JSON.parse(requiredEntry(archive, 'meta.json').toString('utf8')));
  if (
    meta.schema !== schema ||
    meta.sha !== commit ||
    meta.event !== 'push' ||
    meta.run_id !== runId ||
    meta.run_attempt !== attempt ||
    meta.workflow !== workflow
  ) {
    throw new Error('Baseline metadata does not match the trusted workflow run');
  }
  const payload = record(JSON.parse(unz(requiredEntry(archive, 'report.json.gz')).toString('utf8')));
  if (payload.schema !== schema || payload.commit !== commit)
    throw new Error('Invalid baseline report schema or commit');
  const flags: FlagFiles = new Map();
  for (const [name, files] of Object.entries(record(payload.flags))) {
    flags.set(slug(name), deserialize(files));
    assertBudget(flags.values());
  }
  if (!flags.size) throw new Error('Baseline report has no coverage data');
  return flags;
}

// Uploaded by a trusted push run when GitHub refuses to sign its report for a
// plan limit. Verification accepts an unsigned private baseline only with it.
export function unattestedName(reportName: string) {
  return `${reportName}-unattested`;
}

export function reportArtifactName(namespace: Names, commit: string, attempt: number) {
  const base = `${namespace.artifact}-report-${commit}`;
  // Keep the first attempt immutable and give reruns their own report.
  return attempt === 1 ? base : `${base}-attempt-${attempt}`;
}
