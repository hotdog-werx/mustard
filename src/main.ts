import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { getBooleanInput, getInput, info, setFailed, setSecret, warning } from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { gz, loadUploads, names, putArtifact, reportArtifactName } from './artifacts.ts';
import type { Names } from './artifacts.ts';
import { findBaseline, protectedBranch, signReport } from './baseline.ts';
import { schema, serialize, totals } from './coverage.ts';
import { checkoutDiff, getDiff } from './diff.ts';
import { publishBadge, uploadHtml } from './extras.ts';
import { configAt, getEvent, isProtectedSource, loadConfig, sha } from './github.ts';
import { failureMessage, publishSummary, stickyComment, writeChecks } from './publish.ts';
import { compute } from './report.ts';
import type { Report } from './report.ts';
import type { Config } from './config.ts';
import type { Event, GitHub } from './github.ts';
import { retention, upload } from './upload.ts';
import pkg from '../package.json' with { type: 'json' };

/** Reports whether any flag can take coverage from the baseline when its job did not upload. */
function carriesForward(config: Config) {
  return config.defaultCarryforward || [...config.flags.values()].some((flag) => flag.carryforward);
}

/** Selects the merge base or the first parent of a push that uses carryforward. */
async function findBaselineStart(api: GitHub, event: Event, base: string | undefined, config: Config) {
  if (!base && event.event === 'push' && carriesForward(config)) {
    const { data } = await api.rest.repos.getCommit({ ...event.repo, ref: event.commit, per_page: 1 });
    if (data.parents[0]) return sha(data.parents[0].sha);
  }
  return base;
}

/** Detects head policy edits without using the head file to make trusted coverage decisions. */
async function changedPolicy(api: GitHub, event: Event, fromBase: boolean, text: string) {
  if (event.pull && fromBase) {
    try {
      return (await configAt(api, event.repo, event.commit, getInput('config'))).text !== text;
    } catch {
      warning('Could not compare the PR configuration with the trusted configuration.');
    }
  }
  return false;
}

/** Uploads the coverage report and any eligible provenance or HTML artifacts. */
async function publishArtifacts(
  api: GitHub,
  event: Event,
  namespace: Names,
  report: Report,
  {
    config,
    text,
    token,
    workspace,
    baselineSha,
  }: {
    config: Config;
    text: string;
    token: string;
    workspace: string;
    baselineSha?: string;
  },
) {
  let htmlId: number | undefined;
  const name = reportArtifactName(namespace, event.commit, event.attempt);
  const { id, digest } = await putArtifact(
    name,
    new Map<string, Buffer | string>([
      [
        'report.json.gz',
        gz({
          schema,
          commit: event.commit,
          flags: Object.fromEntries([...report.flags].map(([flag, files]) => [flag, serialize(files)])),
        }),
      ],
      [
        'summary.json',
        JSON.stringify({
          project: report.project,
          patch: report.patch,
          delta: report.delta,
          flags: Object.fromEntries(report.flagTotals),
          components: Object.fromEntries(report.componentTotals),
          missing_required_flags: report.incomplete,
          files: Object.fromEntries(
            [...report.files].map(([path, lines]) => [path, totals(new Map([[path, lines]])).percent]),
          ),
        }),
      ],
      [
        'meta.json',
        JSON.stringify({
          schema,
          sha: event.commit,
          event: event.event,
          run_id: event.runId,
          run_attempt: event.attempt,
          workflow: event.workflow,
          config_sha256: createHash('sha256').update(text).digest('hex'),
          mustard_version: pkg.version,
          carryforward: Object.fromEntries(report.carried.map((flag) => [flag, baselineSha])),
        }),
      ],
    ]),
    retention(),
  );
  // An incomplete report could still be read as a baseline under attestations: off,
  // so findBaseline also rejects reports missing a required flag.
  if (
    !report.incomplete.length &&
    event.branch &&
    isProtectedSource(event, config.baseline.branches) &&
    (await protectedBranch(api, event, event.branch))
  ) {
    await signReport(api, event, name, digest, token, config, retention());
  }
  if (config.html && event.mode === 'report') {
    const { id } = await uploadHtml(report, config, event, namespace, event.fork ? undefined : workspace);
    htmlId = id;
  }
  return { reportId: id, htmlId };
}

/** Suppresses a report if its PR changed target, changed head, or closed while it was running. */
async function pullIsCurrent(api: GitHub, event: Event) {
  if (!event.pull) return true;
  const { data: current } = await api.rest.pulls.get({ ...event.repo, pull_number: event.pull.number });
  // GitHub rewrites base.sha asynchronously as the base branch moves, so
  // comparing it would silently skip required checks for an unchanged head.
  // A retargeted PR still needs results from the new base branch.
  if (
    current.head.sha !== event.commit ||
    current.base.ref !== event.pull.base.ref ||
    current.state !== 'open'
  ) {
    info('The pull request changed while Mustard was reporting.');
    return false;
  }
  return true;
}

/** Enables badges only for default-branch pushes. */
function shouldPublishBadge(config: Config, event: Event) {
  return config.badge.enabled && event.event === 'push' && event.branch === event.defaultBranch;
}

/** Dispatches the action with a validated mode and runner workspace. */
async function main() {
  const mode = getInput('mode') || 'report';
  if (mode !== 'upload' && mode !== 'report' && mode !== 'comment')
    throw new Error('mode must be upload, report, or comment');
  const namespace = names(getInput('name'));
  const token = getInput('github-token', { required: true });
  setSecret(token);
  const api = getOctokit(token, { request: { timeout: 30_000 } });
  const workspace = realpathSync(process.env.GITHUB_WORKSPACE ?? process.cwd());
  if (mode === 'upload') return upload(api, namespace, workspace);
  return reportCoverage(api, mode, namespace, token, workspace);
}

/** Computes and publishes coverage using the validated GitHub event and policy. */
async function reportCoverage(
  api: GitHub,
  mode: Event['mode'],
  namespace: Names,
  token: string,
  workspace: string,
) {
  const started = Date.now();
  const event = await getEvent(api, mode);
  if (!event) {
    info('No matching open fork PR for this workflow run and attempt.');
    return;
  }

  const { base, diff, complete } = await getDiff(api, event, token);
  const { config, text, fromBase } = await loadConfig(api, event, base);
  const uploads = await loadUploads(api, event, token, namespace, (checkout) =>
    checkoutDiff(api, event, token, checkout),
  );
  info(
    `Read ${uploads.size} coverage flag(s) and ${diff.size} changed file(s) in ${Math.round((Date.now() - started) / 1000)}s`,
  );
  // A run whose jobs were all skipped by path filters can still carry every flag forward.
  const wantsBaseline = uploads.size > 0 || carriesForward(config);
  const baselineStart = wantsBaseline ? await findBaselineStart(api, event, base, config) : undefined;
  const baseline = baselineStart
    ? await findBaseline(api, event, baselineStart, token, config, namespace)
    : undefined;
  const report = compute(uploads, diff, config, baseline?.flags, complete, !!base);

  const configChanged = await changedPolicy(api, event, fromBase, text);
  const { reportId, htmlId } = report.hasCoverage
    ? await publishArtifacts(api, event, namespace, report, {
        config,
        text,
        token,
        workspace,
        baselineSha: baseline?.sha,
      })
    : {};
  const display = {
    report,
    config,
    event,
    baseline,
    configChanged,
    completeDiff: complete,
    htmlId,
    reportId,
    outputRunId: context.runId,
    hasUploads: report.hasCoverage,
  };
  await publishSummary(display);
  if (event.base && (!event.fork || mode === 'comment')) {
    if (!(await pullIsCurrent(api, event))) return;
    await writeChecks(api, namespace, display);
    await stickyComment(api, namespace, display);
  }
  if (reportId && shouldPublishBadge(config, event)) await updateBadge(api, event, config, report, namespace);
  info(`Mustard finished in ${Math.round((Date.now() - started) / 1000)}s`);
  const failed = report.checks.filter((check) => check.conclusion === 'failure');
  if (getBooleanInput('fail-ci') && (failed.length || report.incomplete.length)) {
    setFailed(
      failureMessage(failed, report, namespace.check, { fromBase, hasConfig: !!text, configChanged }),
    );
  }
}

/** Publishes badges only from complete reports, keeping the last complete snapshot otherwise. */
async function updateBadge(api: GitHub, event: Event, config: Config, report: Report, namespace: Names) {
  // The badge branch holds one snapshot, so a partial publish would also drop
  // badges for the suites that did report.
  if (report.incomplete.length) info('Skipping the badge because required coverage flags are missing.');
  else await publishBadge(api, event, config, report, namespace);
}

main().catch((error) =>
  setFailed(error instanceof Error ? error.message : 'Mustard failed with an unexpected error'),
);
