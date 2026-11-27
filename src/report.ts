import { assertBudget, mergeFiles, status, totals } from './coverage.ts';
import type { Files, FlagFiles, Line } from './coverage.ts';
import { gate, matches } from './config.ts';
import type { Conclusion, Config, Gate } from './config.ts';

export type Change = { oldPath?: string; lines: Set<number>; deleted?: boolean };
export type Diff = Map<string, Change>;
export type Check = { name: string; conclusion: Conclusion; message: string };
export type Annotation = {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'warning' | 'failure';
  message: string;
};

/** Filters a coverage map by repository path without changing its line counts. */
export function view(files: Files, globs: string[]): Files {
  const include = matches(globs);
  return new Map([...files].filter(([path]) => include(path)));
}

/** Merges the requested coverage flags into a single view without modifying the input maps. */
function union(byFlag: FlagFiles, flags: string[] = []): Files {
  const result: Files = new Map();
  for (const [flag, files] of byFlag) {
    if (!flags.length || flags.includes(flag)) mergeFiles(result, files);
  }
  return result;
}

/** Selects only measured lines that changed on the new side of the diff. */
function patchFiles(files: Files, diff: Diff): Files {
  const result: Files = new Map();
  for (const [path, change] of diff) {
    if (change.deleted) continue;
    const lines = new Map([...(files.get(path) ?? [])].filter(([line]) => change.lines.has(line)));
    if (lines.size) result.set(path, lines);
  }
  return result;
}

/** Resolves automatic targets against the baseline for project checks. */
function minimumCoverage(rule: Gate, kind: 'project' | 'patch', baseline: Files | undefined): number {
  const target =
    rule.target !== 'auto' ? rule.target : kind === 'project' && baseline ? totals(baseline).percent : 100;
  return Math.max(0, target - rule.threshold);
}

/** Lists flag names for check messages, which GitHub renders as plain text. */
export function flagList(names: string[]): string {
  return names.join(', ');
}

/** Explains a gate that cannot be measured because its required or selected uploads are absent. */
function unavailable(
  hasUploads: boolean,
  absent: string[],
  config: Config,
): [Conclusion, string] | undefined {
  if (absent.length)
    return ['failure', `Incomplete: required flag(s) ${flagList(absent)} did not report for this attempt.`];
  if (!hasUploads)
    return [config.uploads ? 'failure' : 'neutral', 'No coverage uploads found for this attempt.'];
}

/** Evaluates one coverage gate, including no-upload, no-baseline, and incomplete-diff cases. */
function check(
  rule: Gate,
  measured: Files,
  baseline: Files | undefined,
  config: Config,
  kind: 'project' | 'patch',
  { hasUploads, completeDiff, absent }: { hasUploads: boolean; completeDiff: boolean; absent: string[] },
): Check {
  const make = (conclusion: Conclusion, message: string) => ({
    name: rule.name,
    conclusion: rule.informational ? ('neutral' as const) : conclusion,
    message,
  });
  const missing = unavailable(hasUploads, absent, config);
  if (missing) return make(...missing);
  if (kind === 'patch' && !completeDiff) return make('failure', 'The complete PR diff was unavailable.');
  const actual = totals(measured);
  if (kind === 'patch' && !actual.total) return make('success', 'No coverable lines changed.');
  // An empty selection is 100% by arithmetic, which would let a mistyped path
  // filter pass forever. Treat it as a configuration error instead.
  if (!actual.total) return make('failure', 'No coverable lines matched this check’s paths and flags.');
  if (rule.target === 'auto' && !baseline && kind === 'project') {
    return make(config.baseline.required ? 'failure' : rule.noBaseline, 'No baseline available.');
  }
  // A patch has no earlier equivalent, so an explicit auto target means full coverage.
  const minimum = minimumCoverage(rule, kind, baseline);
  return make(
    actual.percent >= minimum ? 'success' : 'failure',
    `${formatPercent(actual.percent, config)} coverage, minimum ${formatPercent(minimum, config)}.`,
  );
}

/** Formats a percentage using the repository’s configured rounding and precision. */
export function formatPercent(value: number, config: Config): string {
  const scale = 10 ** config.precision;
  const round = { down: Math.floor, up: Math.ceil, nearest: Math.round }[config.round];
  const scaled = value * scale;
  const stabilized = Math.abs(scaled - Math.round(scaled)) < 1e-8 ? Math.round(scaled) : scaled;
  return `${(round(stabilized) / scale).toFixed(config.precision)}%`;
}

/** Applies path filters to both snapshots and fills eligible missing flags from the baseline. */
function prepareFlags(uploads: FlagFiles, baseline: FlagFiles | undefined, config: Config) {
  const ignored = matches(config.ignore, false);
  const filter = (files: Files, paths: string[]) =>
    new Map([...view(files, paths)].filter(([path]) => !ignored(path)));
  const flags: FlagFiles = new Map();
  const baselineFlags: FlagFiles = new Map();
  const carried: string[] = [];
  const missing: string[] = [];
  for (const [name, files] of uploads) flags.set(name, filter(files, config.flags.get(name)?.paths ?? []));
  for (const [name, files] of baseline ?? [])
    baselineFlags.set(name, filter(files, config.flags.get(name)?.paths ?? []));
  const expected = new Set([
    ...config.flags.keys(),
    ...(config.defaultCarryforward ? baselineFlags.keys() : []),
  ]);
  for (const name of expected) {
    if (flags.has(name)) continue;
    const carryforward = config.flags.get(name)?.carryforward ?? config.defaultCarryforward;
    const previous = baselineFlags.get(name);
    if (carryforward && previous) {
      flags.set(name, previous);
      carried.push(name);
    } else missing.push(name);
  }
  assertBudget(flags.values());
  // Carried-forward coverage satisfies a required flag; only a flag with no data makes the run incomplete.
  const incomplete = missing.filter((name) => config.flags.get(name)?.required);
  return { flags, baselineFlags, carried, missing, incomplete };
}

/** Describes measured patches and compares renamed files to their previous paths. */
function changedFiles(diff: Diff, files: Files, patch: Files, previous: Files | undefined) {
  return [...diff]
    .map(([path, change]) => {
      const current = files.get(path);
      const before = previous?.get(change.oldPath ?? path);
      const currentPatch = patch.get(path);
      return {
        path,
        patch: currentPatch ? totals(new Map([[path, currentPatch]])) : undefined,
        delta: current && before ? filePercent(path, current) - filePercent(path, before) : undefined,
        uncovered: currentPatch
          ? [...currentPatch]
              .filter(([, line]) => status(line) !== 'hit')
              .map(([n]) => n)
              .sort((a, b) => a - b)
          : [],
      };
    })
    .filter((row) => row.patch || row.delta !== undefined);
}

/** Finds coverage changes in files that are outside the PR diff. */
function indirectChanges(diff: Diff, files: Files, previous: Files | undefined) {
  const indirect = [];
  const renamed = new Set([...diff.values()].map((value) => value.oldPath));
  if (previous) {
    for (const [path, before] of previous) {
      const current = files.get(path);
      if (!current || diff.has(path) || renamed.has(path)) continue;
      const change = filePercent(path, current) - filePercent(path, before);
      if (change !== 0) indirect.push({ path, delta: change });
    }
  }
  return indirect;
}

/** Evaluates project, patch, flag, and component checks against their selected coverage. */
function coverageChecks(
  flags: FlagFiles,
  baselineFlags: FlagFiles | undefined,
  diff: Diff,
  config: Config,
  {
    hasUploads,
    completeDiff,
    hasPatch,
    hasIndirectChanges,
    incomplete,
  }: {
    hasUploads: boolean;
    completeDiff: boolean;
    hasPatch: boolean;
    hasIndirectChanges: boolean;
    incomplete: string[];
  },
) {
  const evaluate = (rule: Gate, kind: 'project' | 'patch', componentPaths: string[] = []) => {
    const selection = view(view(union(flags, rule.flags), rule.paths), componentPaths);
    const prior = baselineFlags
      ? view(view(union(baselineFlags, rule.flags), rule.paths), componentPaths)
      : undefined;
    const hasSelectedUploads =
      hasUploads && (!rule.flags.length || rule.flags.some((name) => flags.has(name)));
    // A gate without a flag filter measures every suite, so any missing required suite makes it incomplete.
    const absent = incomplete.filter((name) => !rule.flags.length || rule.flags.includes(name));
    return check(rule, kind === 'patch' ? patchFiles(selection, diff) : selection, prior, config, kind, {
      hasUploads: hasSelectedUploads,
      completeDiff,
      absent,
    });
  };
  const projectChecks = config.project.map((rule) => evaluate(rule, 'project'));
  const primary = projectChecks.find((result) => result.name === 'project');
  const defaultRule = config.project.find((rule) => rule.name === 'project');
  if (config.indirectFail && primary && hasIndirectChanges && hasUploads && !incomplete.length) {
    primary.conclusion = defaultRule?.informational ? 'neutral' : 'failure';
    primary.message += ' Coverage changed in files outside the diff.';
  }
  const patchChecks = hasPatch ? config.patch.map((rule) => evaluate(rule, 'patch')) : [];
  const flagChecks = [...config.flags]
    .filter(([, flag]) => flag.status)
    .map(([name]) => evaluate({ ...gate(`flag/${name}`, {}, 'project'), flags: [name] }, 'project'));
  const componentChecks = config.components.flatMap((component) =>
    component.gates
      .filter((rule) => hasPatch || rule.type !== 'patch')
      .map((rule) => evaluate(rule, rule.type, component.paths)),
  );
  return [...projectChecks, ...patchChecks, ...flagChecks, ...componentChecks];
}

/** Builds a bounded list of annotations for the default patch check. */
function annotatePatch(patch: Files, patchGate: Check | undefined, maximum: number): Annotation[] {
  const annotations: Annotation[] = [];
  if (!patchGate) return annotations;
  const annotation_level = patchGate.conclusion === 'failure' ? 'failure' : 'warning';
  for (const [path, lines] of patch) {
    for (const [number, line] of lines) {
      const kind = status(line);
      if (kind === 'hit' || annotations.length >= maximum) continue;
      annotations.push({
        path,
        start_line: number,
        end_line: number,
        annotation_level,
        message:
          kind === 'partial' ? 'Changed line has incomplete branch coverage.' : 'Changed line is uncovered.',
      });
    }
  }
  return annotations;
}

/** Builds the project, patch, and component results, including baseline deltas and line annotations. */
export function compute(
  uploads: FlagFiles,
  diff: Diff,
  config: Config,
  baseline?: FlagFiles,
  completeDiff = true,
  hasPatch = true,
) {
  const { flags, baselineFlags, carried, missing, incomplete } = prepareFlags(uploads, baseline, config);
  const files = union(flags);
  const previous = baseline ? union(baselineFlags) : undefined;
  const patch = patchFiles(files, diff);
  const project = totals(files);
  const oldProject = previous ? totals(previous) : undefined;
  const delta = oldProject ? project.percent - oldProject.percent : undefined;
  const changed = changedFiles(diff, files, patch, previous);
  const indirect = indirectChanges(diff, files, previous);
  const checks = coverageChecks(flags, baseline ? baselineFlags : undefined, diff, config, {
    hasUploads: uploads.size > 0,
    completeDiff,
    hasPatch,
    hasIndirectChanges: indirect.length > 0,
    incomplete,
  });
  const patchTotal = totals(patch);
  const patchGate = config.annotations.enabled ? checks.find((result) => result.name === 'patch') : undefined;
  const annotations = annotatePatch(patch, patchGate, config.annotations.max);
  return {
    files,
    flags,
    carried,
    missing,
    incomplete,
    project,
    delta,
    patch: patchTotal,
    changed,
    indirect,
    annotations,
    omittedAnnotations: patchGate ? patchTotal.total - patchTotal.hit - annotations.length : 0,
    checks,
    flagTotals: new Map([...flags].map(([name, data]) => [name, totals(data)])),
    flagPatch: new Map([...flags].map(([name, data]) => [name, totals(patchFiles(data, diff))])),
    componentTotals: new Map(
      config.components.map((component) => [
        component.id,
        {
          name: component.name,
          project: totals(view(files, component.paths)),
          patch: totals(view(patch, component.paths)),
        },
      ]),
    ),
  };
}

/** Computes the fully covered percentage for a single file. */
function filePercent(path: string, lines: Map<number, Line>): number {
  return totals(new Map([[path, lines]])).percent;
}

export type Report = ReturnType<typeof compute>;
