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

export function view(files: Files, globs: string[]): Files {
  const include = matches(globs);
  return new Map([...files].filter(([path]) => include(path)));
}

function union(byFlag: FlagFiles, flags: string[] = []): Files {
  const result: Files = new Map();
  for (const [flag, files] of byFlag) {
    if (!flags.length || flags.includes(flag)) mergeFiles(result, files);
  }
  return result;
}

function patchFiles(files: Files, diff: Diff): Files {
  const result: Files = new Map();
  for (const [path, change] of diff) {
    if (change.deleted) continue;
    const lines = new Map([...(files.get(path) ?? [])].filter(([line]) => change.lines.has(line)));
    if (lines.size) result.set(path, lines);
  }
  return result;
}

function check(
  rule: Gate,
  measured: Files,
  baseline: Files | undefined,
  config: Config,
  kind: 'project' | 'patch',
  hasUploads: boolean,
  completeDiff: boolean,
): Check {
  const make = (conclusion: Conclusion, message: string) => ({
    name: rule.name,
    conclusion: rule.informational ? ('neutral' as const) : conclusion,
    message,
  });
  if (!hasUploads)
    return make(config.uploads ? 'failure' : 'neutral', 'No coverage uploads found for this attempt.');
  if (kind === 'patch' && !completeDiff) return make('failure', 'The complete PR diff was unavailable.');
  const actual = totals(measured);
  if (kind === 'patch' && !actual.total) return make('success', 'No coverable lines changed.');
  if (rule.target === 'auto' && !baseline && kind === 'project') {
    return make(config.baseline.required ? 'failure' : rule.noBaseline, 'No baseline available.');
  }
  // A patch has no earlier equivalent, so an explicit auto target means full coverage.
  const target =
    rule.target !== 'auto' ? rule.target : kind === 'project' && baseline ? totals(baseline).percent : 100;
  const minimum = Math.max(0, target - rule.threshold);
  return make(
    actual.percent >= minimum ? 'success' : 'failure',
    `${formatPercent(actual.percent, config)} coverage, minimum ${formatPercent(minimum, config)}.`,
  );
}

export function formatPercent(value: number, config: Config): string {
  const scale = 10 ** config.precision;
  const round = { down: Math.floor, up: Math.ceil, nearest: Math.round }[config.round];
  const scaled = value * scale;
  const stabilized = Math.abs(scaled - Math.round(scaled)) < 1e-8 ? Math.round(scaled) : scaled;
  return `${(round(stabilized) / scale).toFixed(config.precision)}%`;
}

export function compute(
  uploads: FlagFiles,
  diff: Diff,
  config: Config,
  baseline?: FlagFiles,
  completeDiff = true,
  hasPatch = true,
) {
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
  const expected = new Set(config.flags.keys());
  if (config.defaultCarryforward) {
    for (const name of baselineFlags.keys()) expected.add(name);
  }
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
  const files = union(flags);
  const previous = baseline ? union(baselineFlags) : undefined;
  const patch = patchFiles(files, diff);
  const project = totals(files);
  const oldProject = previous ? totals(previous) : undefined;
  const delta = oldProject ? project.percent - oldProject.percent : undefined;
  const changed = [...diff]
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
  const evaluate = (rule: Gate, kind: 'project' | 'patch', componentPaths: string[] = []) => {
    const selection = view(view(union(flags, rule.flags), rule.paths), componentPaths);
    const prior = baseline
      ? view(view(union(baselineFlags, rule.flags), rule.paths), componentPaths)
      : undefined;
    const hasUploads = rule.flags.length
      ? rule.flags.some((name) => flags.has(name)) && uploads.size > 0
      : uploads.size > 0;
    return check(
      rule,
      kind === 'patch' ? patchFiles(selection, diff) : selection,
      prior,
      config,
      kind,
      hasUploads,
      completeDiff,
    );
  };
  const projectChecks = config.project.map((rule) => evaluate(rule, 'project'));
  const primary = projectChecks.find((result) => result.name === 'project');
  const defaultRule = config.project.find((rule) => rule.name === 'project');
  if (config.indirectFail && primary && indirect.length && uploads.size) {
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
  const patchTotal = totals(patch);
  const patchGate = patchChecks.find((result) => result.name === 'patch');
  const annotations: Annotation[] = [];
  if (config.annotations.enabled && patchGate) {
    for (const [path, lines] of patch) {
      for (const [number, line] of lines) {
        const kind = status(line);
        if (kind === 'hit' || annotations.length >= config.annotations.max) continue;
        annotations.push({
          path,
          start_line: number,
          end_line: number,
          annotation_level: patchGate.conclusion === 'failure' ? 'failure' : 'warning',
          message:
            kind === 'partial'
              ? 'Changed line has incomplete branch coverage.'
              : 'Changed line is uncovered.',
        });
      }
    }
  }
  return {
    files,
    flags,
    carried,
    missing,
    project,
    delta,
    patch: patchTotal,
    changed,
    indirect,
    annotations,
    omittedAnnotations:
      config.annotations.enabled && patchGate ? patchTotal.total - patchTotal.hit - annotations.length : 0,
    checks: [...projectChecks, ...patchChecks, ...flagChecks, ...componentChecks],
    flagTotals: new Map([...flags].map(([name, data]) => [name, totals(data)])),
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

function filePercent(path: string, lines: Map<number, Line>): number {
  return totals(new Map([[path, lines]])).percent;
}

export type Report = ReturnType<typeof compute>;
