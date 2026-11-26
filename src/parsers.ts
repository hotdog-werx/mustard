import { SaxesParser } from 'saxes';
import type { SaxesTagPlain } from 'saxes';
import { integer, maxBytes, maxFiles, maxLines, mergeLine, record } from './coverage.ts';
import type { Files, Line } from './coverage.ts';

const formats = ['cobertura', 'lcov', 'coveragepy-json', 'go', 'jacoco'] as const;
type Format = (typeof formats)[number];
type Add = (file: string, number: unknown, hits: unknown, covered?: number, total?: number) => void;
type Counts = [hits: number, covered: number, total: number];

/** Recognizes a supported coverage format from its file contents. */
function detect(text: string): Format {
  if (/^\s*[{]/.test(text)) return 'coveragepy-json';
  if (/^mode:\s*(set|count|atomic)\s*$/m.test(text.slice(0, 100))) return 'go';
  if (/^(?:TN:.*\r?\n)*SF:/m.test(text)) return 'lcov';
  const root = /^\s*(?:(?:<\?.*?\?>|<!--.*?-->|<!DOCTYPE[^>]*>)\s*)*<(coverage|report)\b/s.exec(text)?.[1];
  if (root) return root === 'coverage' ? 'cobertura' : 'jacoco';
  throw new Error('Could not detect coverage format. Set the format input explicitly.');
}

/** Reads the branch totals encoded in a Cobertura line’s condition coverage. */
function readCoberturaLine(attributes: SaxesTagPlain['attributes']): Line {
  const branches = /\((\d+)\/(\d+)\)/.exec(attributes['condition-coverage'] ?? '');
  return [integer(attributes.hits), Number(branches?.[1] ?? 0), Number(branches?.[2] ?? 0)];
}

/** Parses Cobertura and JaCoCo without external resources and resolves Cobertura filenames against their declared sources. */
function xml(
  text: string,
  format: 'cobertura' | 'jacoco',
  add: Add,
  normalize: (path: string, sources?: string[]) => string,
) {
  const parser = new SaxesParser();
  const stack: string[] = [];
  const sources: string[] = [];
  let source = '';
  let filename = '';
  let packageName: string | undefined;
  const sourceFileRows: Array<[string, string, Line]> = [];
  let packages = false;
  function readCoberturaTag({ name, attributes: a }: SaxesTagPlain, parent: string | undefined) {
    if (name === 'packages' && parent === 'coverage') packages = true;
    if (name === 'source' && parent === 'sources') source = '';
    if (name === 'class' && parent === 'classes') filename = a.filename ?? '';
    if (name !== 'line' || !filename || stack.at(-3) !== 'class' || parent !== 'lines') return;
    if (sourceFileRows.length >= maxLines) throw new Error('Too many coverage lines');
    sourceFileRows.push([filename, a.number, readCoberturaLine(a)]);
  }

  function readJacocoTag({ name, attributes: a }: SaxesTagPlain, parent: string | undefined) {
    if (name === 'package') packageName = a.name;
    if (name === 'sourcefile') filename = [packageName, a.name].filter(Boolean).join('/');
    if (name === 'line' && parent === 'sourcefile') {
      const ci = integer(a.ci);
      const mi = integer(a.mi);
      const cb = integer(a.cb);
      const mb = integer(a.mb);
      if (ci || mi || cb || mb) add(filename, a.nr, ci, cb, cb + mb);
    }
  }

  parser.on('doctype', (declaration) => {
    // Coverage.py and JaCoCo emit external DOCTYPE declarations. Saxes never
    // loads external resources. Disallow internal subsets and entity declarations.
    if (declaration.includes('[') || /<!ENTITY/i.test(declaration)) {
      throw new Error('Coverage XML entity declarations are forbidden');
    }
  });
  parser.on('text', (value) => {
    if (stack.at(-1) === 'source') source += value;
  });
  parser.on('opentag', (tag) => {
    const { name } = tag;
    const parent = stack.at(-1);
    if (!stack.length && name !== (format === 'cobertura' ? 'coverage' : 'report')) {
      throw new Error('Unexpected coverage XML root');
    }
    stack.push(name);
    if (stack.length > 64) throw new Error('Coverage XML exceeds maximum depth');
    if (format === 'cobertura') readCoberturaTag(tag, parent);
    else readJacocoTag(tag, parent);
  });
  parser.on('closetag', (tag) => {
    if (tag.name === 'source' && source.trim()) sources.push(source.trim());
    if (tag.name === 'class' || tag.name === 'sourcefile') filename = '';
    stack.pop();
  });
  parser.write(text).close();
  if (format === 'cobertura' && !packages) throw new Error('Cobertura XML has no packages element');
  const resolved = new Map<string, string>();
  for (const [file, number, line] of sourceFileRows) {
    let path = resolved.get(file);
    if (!path) {
      path = normalize(file, sources);
      resolved.set(file, path);
    }
    add(path, number, line[0], line[1], line[2]);
  }
}

/** Accumulates hit counts and records branches that were never reached. */
function addLcovCount(counts: Counts, kind: string, second: string, third?: string, fourth?: string) {
  if (kind === 'DA') {
    counts[0] = mergeLine(counts, [integer(second)])[0];
    return;
  }
  integer(second);
  if (!third || fourth === undefined) throw new Error('Invalid LCOV branch record');
  counts[1] += fourth !== '-' && integer(fourth) > 0 ? 1 : 0;
  counts[2]++;
}

/** Collects LCOV hit and branch records per source file before passing them to the normalizer. */
function lcov(text: string, add: Add) {
  let path = '';
  const lines = new Map<number, Counts>();
  function flush() {
    for (const [number, line] of lines) add(path, number, line[0], line[1], line[2]);
    lines.clear();
  }
  for (const { 0: row } of text.matchAll(/[^\r\n]+/g)) {
    if (row.startsWith('SF:')) {
      flush();
      path = row.slice(3);
    }
    if (row === 'end_of_record') {
      flush();
      path = '';
    }
    const entry = /^(DA|BRDA):(.*)$/.exec(row);
    if (!entry) continue;
    if (!path) throw new Error('LCOV line data outside a source record');
    const [line, second, third, fourth] = entry[2].split(',');
    const number = integer(line, 1);
    const counts = lines.get(number) ?? [0, 0, 0];
    addLcovCount(counts, entry[1], second, third, fourth);
    lines.set(number, counts);
    if (lines.size > maxLines) throw new Error('Too many LCOV lines');
  }
  flush();
}

/** Initializes coverage.py line counts before branch arcs are added. */
function coveragePyLines(file: Record<string, unknown>) {
  const lines = new Map<number, Counts>();
  for (const [key, hit] of [
    ['missing_lines', 0],
    ['executed_lines', 1],
  ] as const) {
    const numbers = file[key];
    if (!Array.isArray(numbers)) throw new Error('Invalid coverage.py line array');
    for (const number of numbers) lines.set(integer(number, 1), [hit, 0, 0]);
  }
  return lines;
}

/** Adds arcs only to lines that coverage.py marked executable. */
function addCoveragePyBranches(file: Record<string, unknown>, lines: Map<number, Counts>) {
  for (const [key, hit] of [
    ['missing_branches', 0],
    ['executed_branches', 1],
  ] as const) {
    const arcs = file[key] ?? [];
    if (!Array.isArray(arcs)) throw new Error('Invalid coverage.py branch array');
    for (const arc of arcs) {
      if (!Array.isArray(arc) || arc.length !== 2 || !Number.isSafeInteger(arc[1])) {
        throw new Error('Invalid coverage.py branch arc');
      }
      const line = lines.get(integer(arc[0], 1));
      if (!line) continue;
      line[1] += hit;
      line[2]++;
    }
  }
}

/** Combines executed and missing lines with branch arcs from coverage.py JSON. */
function coveragePy(text: string, add: Add) {
  const data = record(JSON.parse(text));
  integer(record(data.meta).format, 1);
  for (const [path, raw] of Object.entries(record(data.files))) {
    const file = record(raw);
    const lines = coveragePyLines(file);
    addCoveragePyBranches(file, lines);
    for (const [number, line] of lines) add(path, number, line[0], line[1], line[2]);
  }
}

/** Expands Go coverprofile blocks to individual line records within a fixed budget. */
function go(text: string, add: Add) {
  const entries = text.matchAll(/[^\r\n]+/g);
  if (!/^mode: (set|count|atomic)$/.test(entries.next().value?.[0] ?? '')) {
    throw new Error('Invalid Go coverage mode');
  }
  let expanded = 0;
  for (const { 0: row } of entries) {
    const match = /^(.+):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/.exec(row);
    if (!match) throw new Error('Invalid Go coverprofile record');
    const start = integer(match[2], 1);
    const end = integer(match[4], start) - (match[5] === '1' && Number(match[4]) > start ? 1 : 0);
    expanded += end - start + 1;
    if (expanded > maxLines) throw new Error('Go block expansion exceeds the line limit');
    for (let number = start; number <= end; number++) add(match[1], number, match[7]);
  }
}

/** Normalizes a supported report into per-file line coverage and validates all counts and input limits. */
export function parseCoverage(
  text: string,
  requested = 'auto',
  resolve: (path: string, sources?: string[]) => string = (path) => path,
): Files {
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Coverage input exceeds the size limit');
  text = text.replace(/^\uFEFF/, '');
  const format = requested === 'auto' ? detect(text) : requested;
  if (!formats.some((candidate) => candidate === format)) throw new Error('Unsupported coverage format');
  const files: Files = new Map();
  let rows = 0;
  const add: Add = (rawFile, rawNumber, rawHits, covered = 0, total = 0) => {
    if (++rows > maxLines) throw new Error('Coverage contains too many line records');
    const file = format === 'cobertura' ? rawFile : resolve(rawFile);
    const number = integer(rawNumber, 1, 2_147_483_647);
    const hits = integer(rawHits);
    integer(total);
    integer(covered, 0, total);
    const lines = files.get(file) ?? new Map<number, Line>();
    const next: Line = total ? [hits, covered, total] : [hits];
    const previous = lines.get(number);
    lines.set(number, previous ? mergeLine(previous, next) : next);
    files.set(file, lines);
    if (files.size > maxFiles) throw new Error('Coverage contains too many files');
  };
  if (format === 'lcov') lcov(text, add);
  else if (format === 'coveragepy-json') coveragePy(text, add);
  else if (format === 'go') go(text, add);
  else xml(text, format as 'cobertura' | 'jacoco', add, resolve);
  return files;
}
