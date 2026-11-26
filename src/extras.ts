import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { putArtifact } from './artifacts.ts';
import type { Names } from './artifacts.ts';
import { maxBytes, safePath, status, totals } from './coverage.ts';
import type { Line } from './coverage.ts';
import type { Config } from './config.ts';
import { existsIn } from './paths.ts';
import { escapeHtml } from './publish.ts';
import { formatPercent } from './report.ts';
import type { Report } from './report.ts';
import { statusCode } from './github.ts';
import type { Event, GitHub } from './github.ts';
import { retention } from './upload.ts';

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:70rem}
a{color:#175faa}li{margin:.3rem 0}details{margin:1rem 0}summary{cursor:pointer}
pre{overflow:auto;padding:1rem;background:#f6f8fa;line-height:1.5}
.hit{background:#dcfce7}.partial{background:#fef3c7}.miss{background:#fee2e2}
</style><main><h1>${escapeHtml(title)}</h1>${body}</main></html>`;
}

/** Loads source text only from a safe checkout path that fits the HTML report’s remaining budget. */
function sourceLines(workspace: string | undefined, path: string, room: number): string[] | undefined {
  if (!workspace || !existsIn(workspace, path)) return;
  const file = resolve(workspace, path);
  if (statSync(file).size <= Math.min(room, 200_000)) return readFileSync(file, 'utf8').split(/\r?\n/);
}

/** Formats source and coverage lines until the report exhausts its remaining byte budget. */
function renderSourceRows(
  path: string,
  lines: Map<number, Line>,
  workspace: string | undefined,
  remaining: number,
) {
  const source = sourceLines(workspace, path, remaining);
  const display = new Set(lines.keys());
  if (source) for (let index = 1; index <= source.length; index++) display.add(index);
  const rows: string[] = [];
  for (const number of [...display].sort((a, b) => a - b)) {
    const line = lines.get(number);
    const coverage = line ? status(line) : '';
    const text = source?.[number - 1] ?? coverage;
    const row = `<span class="${coverage}">${number}  ${escapeHtml(text)}</span>`;
    remaining -= Buffer.byteLength(row);
    if (remaining <= 0) break;
    rows.push(row);
  }
  return { rows, remaining };
}

/** Uploads a bounded HTML report, including checked-out source when the caller provides a trusted workspace. */
export async function uploadHtml(
  report: Report,
  config: Config,
  event: Event,
  namespace: Names,
  workspace?: string,
) {
  const parts: string[] = [];
  let remaining = 12 * 1024 * 1024;
  for (const [path, lines] of report.files) {
    if (remaining <= 0) break;
    const fileTotals = totals(new Map([[path, lines]]));
    const file = renderSourceRows(path, lines, workspace, remaining);
    remaining = file.remaining;
    parts.push(
      `<details><summary>${escapeHtml(path)} · ${formatPercent(fileTotals.percent, config)}</summary><pre>${file.rows.join('\n')}</pre></details>`,
    );
  }
  if (remaining <= 0)
    parts.push('<p>Some files or lines were omitted because the report reached its size limit.</p>');
  const html = page(
    'Mustard coverage',
    `<p>Project coverage ${formatPercent(report.project.percent, config)}</p>${parts.join('')}`,
  );
  if (Buffer.byteLength(html) > maxBytes) throw new Error('HTML coverage report exceeds size limit');
  const attempt = event.attempt === 1 ? '' : `-attempt-${event.attempt}`;
  return putArtifact(
    `${namespace.artifact}-html-${event.commit}${attempt}`,
    new Map([['index.html', html]]),
    retention(),
  );
}

/** Renders both a Shields-compatible payload and an SVG for one coverage total. */
function badge(label: string, value: number, config: Config) {
  const message = formatPercent(value, config);
  const [low, high] = config.range;
  const color =
    value >= high ? 'brightgreen' : value >= (low + high) / 2 ? 'green' : value >= low ? 'orange' : 'red';
  const fill = { brightgreen: '#367c00', green: '#427328', orange: '#985709', red: '#a52b31' }[color];
  const left = Math.max(72, label.length * 8 + 16);
  const width = left + 78;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22" role="img" aria-label="${escapeHtml(label)}: ${message}"><rect width="${left}" height="22" fill="#454545"/><rect x="${left}" width="78" height="22" fill="${fill}"/><g fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11"><text x="${left / 2}" y="15">${escapeHtml(label)}</text><text x="${left + 39}" y="15">${message}</text></g></svg>`;
  return { json: JSON.stringify({ schemaVersion: 1, label, message, color }), svg };
}

/** Rejects badge branches belonging to the repository or another publisher. */
async function confirmBadgeBranch(
  api: GitHub,
  event: Event,
  config: Config,
  branch: string,
  message: string,
) {
  if (
    !safePath(branch) ||
    !/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(branch) ||
    branch === event.defaultBranch ||
    config.baseline.branches.includes(branch)
  )
    throw new Error('Badge branch must be separate from trusted branches');
  try {
    const { data } = await api.rest.repos.getBranch({ ...event.repo, branch });
    if (data.protected || data.name === event.defaultBranch)
      throw new Error('Badge branch cannot be protected or the default branch');
    const { data: tip } = await api.rest.git.getCommit({ ...event.repo, commit_sha: data.commit.sha });
    if (tip.parents.length || tip.message !== message) {
      throw new Error('Badge branch already has unrelated history');
    }
  } catch (error) {
    if (statusCode(error) !== 404) throw error;
  }
}

function badgeEntries(report: Report, config: Config) {
  const project = badge('coverage', report.project.percent, config);
  const tree = [
    { path: 'badge.json', content: project.json },
    { path: 'badge.svg', content: project.svg },
  ];
  for (const name of config.badge.flags) {
    const stats = report.flagTotals.get(name);
    if (!stats) continue;
    const { json, svg } = badge(name, stats.percent, config);
    tree.push({ path: `flags/${name}.json`, content: json }, { path: `flags/${name}.svg`, content: svg });
  }
  for (const id of config.badge.components) {
    const component = report.componentTotals.get(id);
    if (!component) continue;
    const { json, svg } = badge(id, component.project.percent, config);
    tree.push(
      { path: `components/${id}.json`, content: json },
      { path: `components/${id}.svg`, content: svg },
    );
  }
  return tree;
}

/** Writes the configured badges to their own root commit after confirming the default-branch run is current. */
export async function publishBadge(
  api: GitHub,
  event: Event,
  config: Config,
  report: Report,
  namespace: Names,
) {
  const namespaced = namespace.check !== 'mustard';
  const branch = namespaced
    ? `${config.badge.branch}-${namespace.artifact.slice('mustard-'.length)}`
    : config.badge.branch;
  const message = namespaced
    ? `Publish Mustard coverage badges for ${namespace.check}`
    : 'Publish Mustard coverage badges';
  await confirmBadgeBranch(api, event, config, branch, message);
  const tree = badgeEntries(report, config);
  try {
    const { data: branchTip } = await api.rest.repos.getBranch({
      ...event.repo,
      branch: event.defaultBranch,
    });
    if (branchTip.commit.sha !== event.commit) return;
    const { data: root } = await api.rest.git.createTree({
      ...event.repo,
      tree: tree.map((entry) => ({ ...entry, mode: '100644', type: 'blob' })),
    });
    const { data: commit } = await api.rest.git.createCommit({
      ...event.repo,
      tree: root.sha,
      parents: [],
      message,
    });
    try {
      await api.rest.git.updateRef({ ...event.repo, ref: `heads/${branch}`, sha: commit.sha, force: true });
    } catch (error) {
      if (![404, 422].includes(statusCode(error) ?? 0)) throw error;
      await api.rest.git.createRef({ ...event.repo, ref: `refs/heads/${branch}`, sha: commit.sha });
    }
  } catch (error) {
    if (statusCode(error) === 403)
      throw new Error('GitHub refused to publish the badge branch. Grant contents: write to this job.', {
        cause: error,
      });
    throw error;
  }
}
