import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warning } from '@actions/core';
import { attestProvenance } from '@actions/attest';
import { bundleFromJSON } from '@sigstore/bundle';
import { getTrustedRoot } from '@sigstore/tuf';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';
import type { VerificationPolicy } from '@sigstore/verify';
import {
  downloadArtifact,
  listArtifacts,
  putArtifact,
  readBaseline,
  reportArtifactName,
  unattestedName,
} from './artifacts.ts';
import type { Names } from './artifacts.ts';
import type { Config } from './config.ts';
import { record } from './coverage.ts';
import { repository, sha, statusCode } from './github.ts';
import type { GitHub, Event, Run } from './github.ts';
import githubRoot from './trust/github.json' with { type: 'json' };

const predicateType = 'https://slsa.dev/provenance/v1';
const issuer = 'https://token.actions.githubusercontent.com';

// GitHub reports plan limits with wording such as "Feature not available for
// user-owned private repositories". Permission problems must never downgrade.
export function unsupported(error: unknown): boolean {
  const code = statusCode(error);
  const message = error instanceof Error ? error.message : '';
  const planLimit =
    /not supported|not available|not enabled|enterprise cloud|make (?:this|the) repository public|require[s]? a public/i;
  return (
    [403, 404, 422].includes(code ?? 0) &&
    planLimit.test(message) &&
    /attestations?|user-owned private repositor(?:y|ies)/i.test(message) &&
    !/token|permission|not accessible|scope/i.test(message)
  );
}

// Attestations are available on every public repository, so a public
// repository never falls back. Private and internal repositories only have
// them on some plans.
export async function publicRepository(api: GitHub, repo: Event['repo']): Promise<boolean> {
  const { data } = await api.rest.repos.get(repo);
  return data.visibility ? data.visibility === 'public' : !data.private;
}

export function trustedRun(run: Run, event: Event, commit: string, config: Config): boolean {
  return (
    run.head_sha === commit &&
    run.event === 'push' &&
    run.status === 'completed' &&
    run.head_repository?.full_name.toLowerCase() === repository(event.repo).toLowerCase() &&
    run.path === event.workflow &&
    !!run.head_branch &&
    [event.defaultBranch, ...config.baseline.branches].includes(run.head_branch)
  );
}

export async function protectedBranch(api: GitHub, event: Event, branch: string): Promise<boolean> {
  if (event.defaultBranch === branch) return true;
  const { data } = await api.rest.repos.getBranch({ ...event.repo, branch });
  return data.protected;
}

export async function signReport(
  api: GitHub,
  event: Event,
  name: string,
  digest: string,
  token: string,
  config: Config,
  retentionDays?: number,
) {
  if (config.baseline.attestations === 'off') return;
  try {
    const { bundle } = await attestProvenance({
      subjectName: name,
      subjectDigest: { sha256: digest },
      token,
      skipWrite: true,
    });
    await api.request('POST /repos/{owner}/{repo}/attestations', { ...event.repo, bundle });
  } catch (error) {
    if (
      config.baseline.attestations === 'auto' &&
      unsupported(error) &&
      !(await publicRepository(api, event.repo))
    ) {
      warning(
        'Artifact attestations are unavailable on this repository plan. Using workflow and artifact provenance.',
      );
      // GitHub answers a later list request with a bare 404, so record the
      // refusal where only this trusted run can write it.
      await putArtifact(
        unattestedName(name),
        new Map([
          [
            'unattested.json',
            JSON.stringify({
              status: statusCode(error),
              message: (error instanceof Error ? error.message : '').slice(0, 500),
            }),
          ],
        ]),
        retentionDays,
      );
      return;
    }
    throw new Error('Could not attest the coverage report. Check id-token: write and attestations: write.', {
      cause: error,
    });
  }
}

function oid(number: number, text: string): NonNullable<VerificationPolicy['oids']>[number] {
  const payload = Buffer.from(text);
  const length = payload.length;
  if (length > 65535) throw new Error('Certificate policy value is too large');
  const tag =
    length < 128 ? [12, length] : length < 256 ? [12, 129, length] : [12, 130, length >> 8, length & 255];
  return {
    oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, number] },
    value: Buffer.concat([Buffer.from(tag), payload]),
  };
}

export function attestationPolicy(
  event: Event,
  run: Run,
  allowSelfHosted: boolean,
  attempt = run.run_attempt ?? 1,
): VerificationPolicy {
  const source = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository(event.repo)}`;
  const ref = `refs/heads/${run.head_branch}`;
  const workflow = `${source}/${run.path}@${ref}`;
  const exact = workflow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    subjectAlternativeName: new RegExp(`^${exact}$`),
    extensions: { issuer },
    oids: [
      oid(12, source),
      oid(13, run.head_sha),
      oid(14, ref),
      oid(18, workflow),
      oid(20, 'push'),
      oid(21, `${source}/actions/runs/${run.id}/attempts/${attempt}`),
      ...(!allowSelfHosted ? [oid(11, 'github-hosted')] : []),
    ],
  };
}

export function assertSubject(payload: Buffer, name: string, digest: string) {
  const statement = record(JSON.parse(payload.toString('utf8')));
  if (
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== predicateType ||
    !Array.isArray(statement.subject)
  )
    throw new Error('Expected a signed SLSA provenance statement');
  if (
    !statement.subject.some((raw) => {
      const item = record(raw);
      return item.name === name && record(item.digest).sha256 === digest;
    })
  )
    throw new Error('Attestation does not match the coverage artifact digest');
}

async function createVerifier(privateRepo: boolean): Promise<Verifier> {
  const directory = await mkdtemp(join(tmpdir(), 'mustard-tuf-'));
  try {
    const rootPath = join(directory, 'github-root.json');
    if (privateRepo) await writeFile(rootPath, JSON.stringify(githubRoot));
    const root = await getTrustedRoot({
      cachePath: join(directory, 'cache'),
      timeout: 8000,
      retry: 1,
      ...(privateRepo ? { mirrorURL: 'https://tuf-repo.github.com', rootPath } : {}),
    });
    return new Verifier(toTrustMaterial(root), {
      tlogThreshold: privateRepo ? 0 : 1,
      ctlogThreshold: privateRepo ? 0 : 1,
      timestampThreshold: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class Provenance {
  private verifier?: Promise<Verifier>;
  private unavailable = false;

  private readonly api: GitHub;
  private readonly event: Event;
  private readonly config: Config;

  constructor(api: GitHub, event: Event, config: Config) {
    this.api = api;
    this.event = event;
    this.config = config;
  }

  private visibility?: Promise<boolean>;

  private isPublic(): Promise<boolean> {
    this.visibility ??= publicRepository(this.api, this.event.repo);
    return this.visibility;
  }

  private fallBack(): void {
    this.unavailable = true;
    warning(
      'Artifact attestations are unavailable on this repository plan. Using workflow and artifact provenance.',
    );
  }

  async verify(
    name: string,
    digest: string,
    run: Run,
    attempt = run.run_attempt ?? 1,
    unattested = false,
  ): Promise<void> {
    if (this.config.baseline.attestations === 'off' || this.unavailable) return;
    const auto = this.config.baseline.attestations === 'auto';
    let entries: unknown[];
    try {
      const { data } = await this.api.rest.repos.listAttestations({
        ...this.event.repo,
        subject_digest: `sha256:${digest}`,
        per_page: 30,
      });
      entries = data.attestations ?? [];
    } catch (error) {
      if (auto && unsupported(error) && !(await this.isPublic())) return this.fallBack();
      if (statusCode(error) !== 404) throw error;
      entries = [];
    }
    if (!entries.length) {
      // The producing run recorded that GitHub refused to sign for a plan
      // limit. Public repositories always support attestations.
      if (auto && unattested && !(await this.isPublic())) {
        warning(`Accepting unsigned baseline ${name}: its run recorded that attestations are unavailable.`);
        return;
      }
      throw new Error('No attestation found for the coverage artifact');
    }
    this.verifier ??= this.isPublic().then((isPublic) => createVerifier(!isPublic));
    const verifier = await this.verifier;
    const policy = attestationPolicy(this.event, run, this.config.baseline.selfHosted, attempt);
    for (const entry of entries) {
      try {
        const bundle = bundleFromJSON(record(entry).bundle);
        if (
          bundle.content.$case !== 'dsseEnvelope' ||
          bundle.content.dsseEnvelope.payloadType !== 'application/vnd.in-toto+json'
        )
          continue;
        const entity = toSignedEntity(bundle);
        if (entity.key.$case !== 'certificate') continue;
        verifier.verify(entity, policy);
        assertSubject(bundle.content.dsseEnvelope.payload, name, digest);
        return;
      } catch {
        // A digest can have attestations from other workflows.
      }
    }
    throw new Error('No attestation matched the trusted workflow, run, commit, runner, and artifact');
  }
}

export async function findBaseline(
  api: GitHub,
  event: Event,
  start: string,
  token: string,
  config: Config,
  namespace: Names,
) {
  const provenance = new Provenance(api, event, config);
  let commit = start;
  for (let distance = 0; distance <= config.baseline.maxWalk; distance++) {
    const { data } = await api.rest.actions.listWorkflowRunsForRepo({
      ...event.repo,
      head_sha: commit,
      event: 'push',
      status: 'completed',
      per_page: 100,
    });
    const runs = data.workflow_runs
      .filter((run) => trustedRun(run, event, commit, config))
      .sort(
        (a, b) => (b.run_attempt ?? 1) - (a.run_attempt ?? 1) || b.updated_at.localeCompare(a.updated_at),
      );
    for (const run of runs) {
      try {
        if (!run.head_branch || !(await protectedBranch(api, event, run.head_branch))) continue;
        // Newer attempts may not have rerun the report job, so fall back to the
        // newest attempt that produced a report.
        const artifacts = await listArtifacts(api, event.repo, run.id);
        for (let attempt = run.run_attempt ?? 1; attempt >= 1; attempt--) {
          const name = reportArtifactName(namespace, commit, attempt);
          const artifact = artifacts.find((entry) => entry.name === name && !entry.expired);
          if (!artifact) continue;
          const { bytes, digest } = await downloadArtifact(event.repo, artifact, token);
          const unattested = artifacts.some((entry) => entry.name === unattestedName(name) && !entry.expired);
          await provenance.verify(name, digest, run, attempt, unattested);
          const flags = await readBaseline(bytes, commit, run.id, attempt, run.path);
          return { sha: commit, runId: run.id, distance, flags };
        }
      } catch (error) {
        warning(
          `Rejected coverage baseline from run ${run.id}: ${error instanceof Error ? error.message : 'verification error'}`,
        );
      }
    }
    if (distance === config.baseline.maxWalk) break;
    const { data: revision } = await api.rest.repos.getCommit({ ...event.repo, ref: commit, per_page: 1 });
    if (!revision.parents[0]) break;
    commit = sha(revision.parents[0].sha);
  }
}
