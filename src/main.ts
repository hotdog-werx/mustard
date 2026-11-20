import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { getBooleanInput, getInput, info, setFailed, setSecret, warning } from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { gz, loadUploads, names, putArtifact, reportArtifactName } from './artifacts.ts';
import { findBaseline, protectedBranch, signReport } from './baseline.ts';
import { schema, serialize, totals } from './coverage.ts';
import { getDiff } from './diff.ts';
import { publishBadge, uploadHtml } from './extras.ts';
import { configAt, getEvent, isProtectedSource, loadConfig, sha } from './github.ts';
import { failureMessage, publishSummary, stickyComment, writeChecks } from './publish.ts';
import { compute } from './report.ts';
import { retention, upload } from './upload.ts';
import pkg from '../package.json' with { type: 'json' };

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
  const started = Date.now();
  const event = await getEvent(api, mode);
  if (!event) {
    info('No matching open fork PR for this workflow run and attempt.');
    return;
  }

  const { base, diff, complete } = await getDiff(api, event, token);
  const { config, text, fromBase } = await loadConfig(api, event, base);
  const uploads = await loadUploads(api, event, token, namespace);
  info(
    `Read ${uploads.size} coverage flag(s) and ${diff.size} changed file(s) in ${Math.round((Date.now() - started) / 1000)}s`,
  );
  let baselineStart = base;
  if (
    !baselineStart &&
    event.event === 'push' &&
    uploads.size &&
    (config.defaultCarryforward || [...config.flags.values()].some((flag) => flag.carryforward))
  ) {
    const { data } = await api.rest.repos.getCommit({ ...event.repo, ref: event.commit, per_page: 1 });
    if (data.parents[0]) baselineStart = sha(data.parents[0].sha);
  }
  const baseline =
    baselineStart && uploads.size
      ? await findBaseline(api, event, baselineStart, token, config, namespace)
      : undefined;
  const report = compute(uploads, diff, config, baseline?.flags, complete, !!base);

  let configChanged = false;
  if (event.pull && fromBase) {
    try {
      configChanged = (await configAt(api, event.repo, event.commit, getInput('config'))).text !== text;
    } catch {
      warning('Could not compare the PR configuration with the trusted configuration.');
    }
  }
  let reportId: number | undefined;
  let htmlId: number | undefined;
  if (uploads.size) {
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
            carryforward: Object.fromEntries(report.carried.map((flag) => [flag, baseline?.sha])),
          }),
        ],
      ]),
      retention(),
    );
    reportId = id;
    if (
      event.branch &&
      isProtectedSource(event, config.baseline.branches) &&
      (await protectedBranch(api, event, event.branch))
    ) {
      await signReport(api, event, name, digest, token, config, retention());
    }
    if (config.html && mode === 'report') {
      const { id } = await uploadHtml(report, config, event, namespace, event.fork ? undefined : workspace);
      htmlId = id;
    }
  }
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
    hasUploads: !!uploads.size,
  };
  await publishSummary(display);
  if (event.base && (!event.fork || mode === 'comment')) {
    if (event.pull) {
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
        return;
      }
    }
    await writeChecks(api, namespace, display);
    await stickyComment(api, namespace, display);
  }
  if (reportId && config.badge.enabled && event.event === 'push' && event.branch === event.defaultBranch) {
    await publishBadge(api, event, config, report, namespace);
  }
  info(`Mustard finished in ${Math.round((Date.now() - started) / 1000)}s`);
  const failed = report.checks.filter((check) => check.conclusion === 'failure');
  if (getBooleanInput('fail-ci') && failed.length) {
    setFailed(
      failureMessage(failed, report, namespace.check, { fromBase, hasConfig: !!text, configChanged }),
    );
  }
}

main().catch((error) =>
  setFailed(error instanceof Error ? error.message : 'Mustard failed with an unexpected error'),
);
