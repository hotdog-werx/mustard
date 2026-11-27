import picomatch from 'picomatch';
import { parseDocument } from 'yaml';
import { integer, record, slug } from './coverage.ts';

export type Conclusion = 'success' | 'failure' | 'neutral';
export type Fix = [from: string, to: string];
export type Gate = {
  name: string;
  target: number | 'auto';
  threshold: number;
  informational: boolean;
  noBaseline: Conclusion;
  paths: string[];
  flags: string[];
};
type Flag = { paths: string[]; carryforward: boolean; status: boolean; required: boolean };
type Component = {
  id: string;
  name: string;
  paths: string[];
  gates: Array<Gate & { type: 'project' | 'patch' }>;
};

function choice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!choices.includes(value as T)) throw new Error(`Expected one of ${choices.join(', ')}`);
  return value as T;
}

function object(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : record(value);
}

function bool(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Expected a boolean in Mustard config');
  return value;
}

function string(value: unknown, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error('Expected a string in Mustard config');
  return value;
}

function list(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length > 4096)) {
    throw new Error('Expected an array of strings in Mustard config');
  }
  return value;
}

function percent(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed =
    typeof value === 'string' && /^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(value)
      ? Number(value.replace(/%$/, ''))
      : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('Expected a coverage percentage between 0 and 100');
  }
  return parsed;
}

function bounded(value: unknown, fallback: number, max: number) {
  return value === undefined ? fallback : integer(value, 0, max);
}

// Codecov path patterns are globs, regular expressions, or plain folder/file
// paths. A plain path matches itself and everything below it.
/** Compiles one path filter while preserving the distinction between folder prefixes, globs, and regular expressions. */
function pathMatcher(pattern: string): (path: string) => boolean {
  const anchored = pattern.startsWith('^') || pattern.endsWith('$');
  const globStar = /(^|[^.])\*/.test(pattern);
  if (anchored || (!globStar && /\.\*|\.\+|\\[.dws]/.test(pattern))) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern.startsWith('^') ? pattern : `^(?:${pattern})`);
    } catch {
      throw new Error(`Invalid path regular expression ${JSON.stringify(pattern)} in Mustard config`);
    }
    return (path) => regex.test(path);
  }
  const trimmed = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!trimmed) return () => true;
  if (picomatch.scan(trimmed).isGlob) return picomatch(trimmed, { dot: true });
  return (path) => path === trimmed || path.startsWith(`${trimmed}/`);
}

/** Combines path filters with OR and uses the supplied default when the list is empty. */
export function matches(globs: string[], defaultMatch = true): (path: string) => boolean {
  if (!globs.length) return () => defaultMatch;
  const matchers = globs.map(pathMatcher);
  return (path) => matchers.some((match) => match(path));
}

/** Parses a source-to-destination prefix rewrite, including rules containing Windows drive letters. */
export function parseFix(rule: string): Fix {
  const index = rule.includes('::')
    ? rule.indexOf('::')
    : rule.indexOf(':', /^[A-Za-z]:[/\\]/.test(rule) ? 2 : 0);
  if (index < 1) throw new Error('Expected a path rewrite of the form from:to or from::to');
  return [rule.slice(0, index), rule.slice(index + (rule.slice(index, index + 2) === '::' ? 2 : 1))];
}

/** Validates a single coverage rule and applies the defaults for project or patch checks. */
export function gate(name: string, value: unknown, type: 'project' | 'patch'): Gate {
  const rule = value === true ? {} : object(value);
  const target =
    rule.target === 'auto' || (type === 'project' && rule.target === undefined)
      ? 'auto'
      : percent(rule.target, 100);
  return {
    name,
    target,
    threshold: percent(rule.threshold, 0),
    informational: bool(rule.informational),
    paths: list(rule.paths),
    flags: list(rule.flags).map(slug),
    noBaseline: choice(rule.if_no_baseline, ['neutral', 'success', 'failure'] as const, 'neutral'),
  };
}

/** Expands a check kind’s shorthand settings into named coverage rules. */
function gates(value: unknown, type: 'project' | 'patch'): Gate[] {
  if (value === false) return [];
  const entries = Object.entries(value === true ? {} : object(value));
  if (value === undefined || value === true) return [gate(type, {}, type)];
  return entries
    .filter(([, rule]) => rule !== false)
    .map(([name, rule]) => gate(name === 'default' ? type : `${type}/${slug(name)}`, rule, type));
}

/** Combines Codecov-style flag defaults with Mustard’s per-flag overrides. */
function flagConfig(root: Record<string, unknown>): Map<string, Flag> {
  const management = object(root.flag_management);
  const defaults = object(management.default_rules);
  const flags = new Map<string, Flag>();
  const individual = management.individual_flags ?? [];
  if (!Array.isArray(individual)) throw new Error('flag_management.individual_flags must be an array');
  for (const raw of individual) {
    const rule = object(raw);
    const name = slug(rule.name);
    flags.set(name, {
      paths: list(rule.paths),
      carryforward: bool(rule.carryforward, bool(defaults.carryforward)),
      status: bool(rule.status),
      required: bool(rule.required),
    });
  }
  for (const [name, raw] of Object.entries(object(root.flags))) {
    const rule = object(raw);
    const existing = flags.get(name);
    flags.set(slug(name), {
      paths: rule.paths === undefined ? (existing?.paths ?? []) : list(rule.paths),
      carryforward: bool(rule.carryforward, existing?.carryforward ?? bool(defaults.carryforward)),
      status: bool(rule.status, existing?.status),
      required: bool(rule.required, existing?.required),
    });
  }
  return flags;
}

/** Builds component definitions and their optional project and patch checks. */
function components(root: Record<string, unknown>): Component[] {
  const management = object(root.component_management);
  const entries = management.individual_components ?? [];
  if (!Array.isArray(entries)) throw new Error('individual_components must be an array');
  const ids = new Set<string>();
  return entries.map((raw) => {
    const entry = object(raw);
    const id = slug(entry.component_id);
    if (ids.has(id)) throw new Error('Duplicate component ID');
    ids.add(id);
    const statuses = entry.statuses ?? [];
    if (!Array.isArray(statuses) || statuses.length > 2) throw new Error('Invalid component statuses');
    const seen = new Set<string>();
    return {
      id,
      name: string(entry.name, id),
      paths: list(entry.paths),
      gates: statuses.map((value) => {
        const rule = object(value);
        const type = choice(rule.type, ['project', 'patch'] as const, 'project');
        if (seen.has(type)) throw new Error('Duplicate component status type');
        seen.add(type);
        const name = statuses.length === 1 ? `component/${id}` : `component/${id}/${type}`;
        return { ...gate(name, rule, type), type };
      }),
    };
  });
}

const recognized: Record<string, string[]> = {
  '': [
    'coverage',
    'ignore',
    'fixes',
    'flags',
    'flag_management',
    'component_management',
    'comment',
    'annotations',
    'baseline',
    'config',
    'badge',
    'html',
    'require_uploads',
    'indirect_changes',
    'attestations',
  ],
  coverage: ['precision', 'round', 'range', 'status'],
  'coverage.status': ['project', 'patch'],
  'coverage.status.*.*': ['target', 'threshold', 'informational', 'if_no_baseline', 'paths', 'flags'],
  'flags.*': ['paths', 'carryforward', 'status', 'required'],
  flag_management: ['default_rules', 'individual_flags'],
  'flag_management.default_rules': ['carryforward'],
  'flag_management.individual_flags.*': ['name', 'paths', 'carryforward', 'status', 'required'],
  component_management: ['individual_components'],
  'component_management.individual_components.*': ['component_id', 'name', 'paths', 'statuses'],
  'component_management.individual_components.*.statuses.*': [
    'target',
    'threshold',
    'informational',
    'if_no_baseline',
    'paths',
    'flags',
    'type',
  ],
  comment: [
    'behavior',
    'require_changes',
    'only_on_failure',
    'show_carryforward_flags',
    'indirect_changes',
    'max_files',
    'layout',
  ],
  annotations: ['enabled', 'max'],
  baseline: ['max_walk', 'max-walk', 'required', 'attestations', 'trusted_branches', 'allow_self_hosted'],
  config: ['source'],
  badge: ['enabled', 'branch', 'flags', 'components'],
  html: ['enabled'],
};

/** Reports unsupported configuration keys without walking into arbitrary values. */
function warnKeys(value: unknown, warn: (message: string) => void, path = '', pattern = ''): void {
  if (value === null || typeof value !== 'object') return;
  const known = recognized[pattern];
  const wildcard = [
    'flags',
    'flag_management.individual_flags',
    'component_management.individual_components',
    'component_management.individual_components.*.statuses',
    'coverage.status',
    'coverage.status.*',
  ].includes(pattern);
  if (!known && !wildcard) return;
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (known && !known.includes(key)) {
      warn(`Ignoring unsupported config key ${JSON.stringify(next)}`);
      continue;
    }
    const segment = wildcard ? '*' : key;
    warnKeys(child, warn, next, pattern ? `${pattern}.${segment}` : segment);
  }
}

/** Parses Mustard or supported Codecov YAML, validates settings, and fills missing values with defaults. */
export function readConfig(text = '', warn: (message: string) => void = () => {}) {
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Coverage config exceeds 256 KiB');
  const doc = parseDocument(text, { strict: true });
  if (doc.errors.length) throw new Error(`Invalid Mustard YAML: ${doc.errors[0].message}`);
  const root = object(doc.toJS({ maxAliasCount: 0 }) ?? undefined);
  warnKeys(root, warn);
  const coverage = object(root.coverage);
  const status = object(coverage.status);
  const comment = object(root.comment);
  const annotations = object(root.annotations);
  const baseline = object(root.baseline);
  const badge = object(root.badge);
  const range = string(coverage.range, '70...100').split(/\s*(?:\.{3}|,|->)\s*/);
  if (range.length !== 2) throw new Error('Coverage range must be formatted as 70...100');
  const low = percent(range[0], 70);
  const high = percent(range[1], 100);
  if (low >= high) throw new Error('Coverage range must increase');
  const layout = string(comment.layout);
  return {
    project: gates(status.project, 'project'),
    patch: gates(status.patch, 'patch'),
    precision: bounded(coverage.precision, 2, 6),
    round: choice(coverage.round, ['up', 'down', 'nearest'] as const, 'down'),
    range: [low, high] as const,
    ignore: list(root.ignore),
    fixes: list(root.fixes).map(parseFix),
    flags: flagConfig(root),
    defaultCarryforward: bool(object(object(root.flag_management).default_rules).carryforward),
    components: components(root),
    comment: {
      behavior: choice(comment.behavior, ['default', 'once', 'new', 'off'] as const, 'default'),
      changes: bool(comment.require_changes),
      failure: bool(comment.only_on_failure),
      carryforward: bool(comment.show_carryforward_flags, true),
      indirect: bool(comment.indirect_changes, true),
      maxFiles: bounded(comment.max_files, 50, 500),
      layout: layout ? new Set(layout.split(',').map((item) => item.trim())) : undefined,
    },
    annotations: { enabled: bool(annotations.enabled, true), max: bounded(annotations.max, 200, 1000) },
    baseline: {
      maxWalk: bounded(baseline.max_walk ?? baseline['max-walk'], 20, 100),
      required: bool(baseline.required),
      attestations: choice(
        baseline.attestations ?? root.attestations,
        ['auto', 'required', 'off'] as const,
        'auto',
      ),
      branches: list(baseline.trusted_branches),
      selfHosted: bool(baseline.allow_self_hosted),
    },
    source: choice(object(root.config).source, ['base', 'head'] as const, 'base'),
    uploads: bool(root.require_uploads),
    indirectFail:
      choice(root.indirect_changes, ['informational', 'fail'] as const, 'informational') === 'fail',
    badge: {
      enabled: bool(badge.enabled),
      branch: string(badge.branch, 'mustard-badges'),
      flags: list(badge.flags).map(slug),
      components: list(badge.components).map(slug),
    },
    html: bool(object(root.html).enabled),
  };
}

export type Config = ReturnType<typeof readConfig>;
