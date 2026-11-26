export type Line = [hits: number, covered?: number, total?: number];
export type Files = Map<string, Map<number, Line>>;
export type FlagFiles = Map<string, Files>;
export const schema = 'mustard.coverage/v1';
export const maxBytes = 32 * 1024 * 1024;
export const maxFiles = 20_000;
export const maxLines = 1_000_000;

/** Checks that decoded input is a non-null, non-array object before callers read its fields. */
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as Record<string, unknown>;
}

/** Accepts safe integers and decimal strings within the requested inclusive bounds. */
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const result = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error('Invalid coverage count or line number');
  }
  return result;
}

/** Validates an identifier shared by coverage flags, shards, namespaces, and artifact names. */
export function slug(name: unknown): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(
      'Names must be 1–64 letters, digits, hyphens or underscores and start with a letter or digit',
    );
  }
  return name;
}

/** Checks that a path is a bounded, normalized repository-relative path without traversal segments. */
export function safePath(path: string): boolean {
  return (
    path.length <= 4096 &&
    !/[\\\p{Cc}]/u.test(path) &&
    !/^[A-Za-z]:/.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

/** Combines hit counts and caps combined branch counts at the largest reported branch total. */
export function mergeLine(left: Line, right: Line): Line {
  const hits = Math.min(left[0] + right[0], Number.MAX_SAFE_INTEGER);
  const total = Math.max(left[2] ?? 0, right[2] ?? 0);
  return total ? [hits, Math.min(total, (left[1] ?? 0) + (right[1] ?? 0)), total] : [hits];
}

/** Merges source lines into the target map in place and returns the target. */
export function mergeFiles(target: Files, source: Files): Files {
  for (const [path, incoming] of source) {
    const lines = target.get(path) ?? new Map<number, Line>();
    for (const [number, line] of incoming) {
      const previous = lines.get(number);
      lines.set(number, previous ? mergeLine(previous, line) : line);
    }
    target.set(path, lines);
  }
  return target;
}

/** Applies the shared file and line budgets across all supplied coverage maps. */
export function assertBudget(views: Iterable<Files>): void {
  let paths = 0;
  let count = 0;
  for (const files of views) {
    paths += files.size;
    for (const lines of files.values()) count += lines.size;
  }
  if (paths > maxFiles || count > maxLines) throw new Error('Coverage exceeds the file or line limit');
}

/** Converts normalized coverage maps to the JSON shape used in artifacts. */
export function serialize(files: Files) {
  return Object.fromEntries([...files].map(([path, lines]) => [path, { lines: Object.fromEntries(lines) }]));
}

/** Validates one normalized line record from an artifact. */
function deserializeLine(number: string, tuple: unknown): [number, Line] {
  if (
    !Array.isArray(tuple) ||
    ![1, 3].includes(tuple.length) ||
    tuple.some((value) => typeof value !== 'number')
  )
    throw new Error('Invalid normalized line data');
  const line = integer(number, 1, 2_147_483_647);
  if (String(line) !== number) throw new Error('Noncanonical line number');
  const hits = integer(tuple[0]);
  if (tuple.length === 1) return [line, [hits]];
  const total = integer(tuple[2]);
  const covered = integer(tuple[1], 0, total);
  return [line, total ? [hits, covered, total] : [hits]];
}

/** Validates the artifact JSON shape and converts canonical line numbers and coverage tuples to maps. */
export function deserialize(value: unknown): Files {
  const files: Files = new Map();
  let count = 0;
  for (const [path, item] of Object.entries(record(value))) {
    if (!safePath(path) || files.size >= maxFiles) throw new Error('Invalid coverage path or too many files');
    const lines = new Map<number, Line>();
    for (const [number, tuple] of Object.entries(record(record(item).lines))) {
      if (++count > maxLines) throw new Error('Invalid normalized line data');
      const [line, coverage] = deserializeLine(number, tuple);
      lines.set(line, coverage);
    }
    files.set(path, lines);
  }
  return files;
}

/** Distinguishes missed lines, lines with incomplete branch coverage, and fully covered lines. */
export function status(line: Line): 'hit' | 'partial' | 'miss' {
  if (line[0] === 0) return 'miss';
  return (line[1] ?? 0) < (line[2] ?? 0) ? 'partial' : 'hit';
}

export type Totals = { hit: number; partial: number; miss: number; total: number; percent: number };

/** Counts coverage states and computes the percentage of fully covered lines. */
export function totals(files: Files): Totals {
  const result = { hit: 0, partial: 0, miss: 0, total: 0, percent: 100 };
  for (const lines of files.values()) {
    for (const line of lines.values()) {
      result[status(line)]++;
      result.total++;
    }
  }
  if (result.total) result.percent = (100 * result.hit) / result.total;
  return result;
}
