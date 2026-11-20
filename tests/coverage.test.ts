import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCoverage } from '../src/parsers.ts';
import { deserialize, mergeFiles, mergeLine, serialize, totals } from '../src/coverage.ts';
import type { Files, FlagFiles } from '../src/coverage.ts';
import { readConfig } from '../src/config.ts';
import { compute, formatPercent } from '../src/report.ts';
import type { Diff } from '../src/report.ts';
import { normalizePath } from '../src/paths.ts';

function fixture(name: string) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

test('detects coverage formats and preserves partial branches', () => {
  const cases = [
    ['coverage.xml', 'example.py', 1],
    ['lcov.info', 'src/example.ts', 1],
    ['coverage.json', 'src/example.py', 1],
    ['jacoco.xml', 'org/example/Main.java', 2],
  ] as const;
  for (const [file, expected, hits] of cases) {
    const paths = parseCoverage(fixture(file));
    assert.deepEqual(serialize(paths), { [expected]: { lines: { 2: [hits, 1, 2], 4: [0] } } }, file);
  }
  const go = parseCoverage(fixture('coverage.out'));
  assert.deepEqual(serialize(go), {
    'example.org/m/src/example.go': { lines: { 2: [3], 3: [3], 4: [3], 5: [0] } },
  });
});

test('rejects XML entities and limits expanded Go blocks', () => {
  assert.throws(
    () =>
      parseCoverage(
        '<!DOCTYPE coverage [<!ENTITY e "secret">]><coverage><packages/></coverage>',
        'cobertura',
      ),
    /entity declarations/,
  );
  assert.throws(() => parseCoverage('mode: count\na.go:1.2,1000002.3 1 0'), /line limit/);
  assert.throws(() => parseCoverage('SF:src/a\nDA:1,invalid\n'), /Invalid coverage count/);
});

test('normalizes paths and passes Cobertura sources to the resolver', () => {
  assert.equal(
    normalizePath('C:\\agent\\work\\repo\\src\\a.ts', 'C:\\agent\\work\\repo', '', []),
    'src/a.ts',
  );
  assert.equal(
    normalizePath('site-packages/pkg/a.py', '/workspace', '', [['site-packages/pkg/', 'src/pkg/']]),
    'src/pkg/a.py',
  );
  assert.equal(normalizePath('/workspace/project/pkg/a.py', '/workspace', 'project', []), 'pkg/a.py');
  assert.equal(normalizePath('/dist/module/file.go', '/workspace', '/dist/module', []), 'file.go');
  const xml = parseCoverage(fixture('coverage.xml'), 'auto', (file, sources) => `${sources?.[0]}/${file}`);
  assert.equal(xml.has('/home/runner/work/example/example/src/example.py'), true);
});

test('validates normalized paths and counts and merges branch totals', () => {
  assert.throws(() => deserialize({ '../danger': { lines: { 1: [1] } } }), /Invalid coverage path/);
  assert.throws(() => deserialize({ foo: { lines: { 1: [1, 2, 1] } } }), /Invalid coverage count/);
  assert.throws(() => deserialize({ foo: { lines: { '01': [1] } } }), /Noncanonical/);
  const source = deserialize(JSON.parse('{"__proto__":{"lines":{"1":[1]}}}'));
  assert.equal(source.get('__proto__')?.get(1)?.[0], 1);
  assert.deepEqual(mergeLine([2, 1, 3], [4, 2, 2]), [6, 3, 3]);
  assert.deepEqual(mergeLine([Number.MAX_SAFE_INTEGER], [4]), [Number.MAX_SAFE_INTEGER]);
  assert.equal(totals(mergeFiles(new Map(), source)).percent, 100);
});

const changes: Diff = new Map([
  ['src/new.ts', { oldPath: 'src/old.ts', lines: new Set([1, 2, 3, 50]) }],
  ['tools/deleted.ts', { deleted: true, lines: new Set() }],
  ['docs/example.md', { lines: new Set([1]) }],
]);

const current = deserialize({
  'src/new.ts': { lines: { 1: [1], 2: [1, 1, 2], 3: [0] } },
  'src/indirect.ts': { lines: { 1: [0] } },
  'docs/example.md': { lines: { 1: [0] } },
});

const previous = deserialize({
  'src/old.ts': { lines: { 1: [1], 2: [1], 3: [1] } },
  'src/indirect.ts': { lines: { 1: [1] } },
});

const views = (files: Files): FlagFiles => new Map([['default', files]]);

test('requires full patch coverage and keeps project auto neutral with no baseline', () => {
  const config = readConfig('ignore: [docs/**]');
  const report = compute(views(current), changes, config);
  assert.deepEqual(
    report.checks.map((check) => check.conclusion),
    ['neutral', 'failure'],
  );
  assert.deepEqual([report.patch.hit, report.patch.partial, report.patch.miss], [1, 1, 1]);
  assert.deepEqual(
    report.annotations.map((entry) => entry.start_line),
    [2, 3],
  );
  assert.equal(formatPercent(report.patch.percent, config), '33.33%');
});

test('compares renamed files to baseline and reports indirect changes', () => {
  const config = readConfig(`
ignore: [docs/**]
coverage:
  status:
    project:
      default: { target: 25%, threshold: 0% }
    patch:
      default: { target: 30%, informational: true }
annotations: { max: 1 }
`);
  const report = compute(views(current), changes, config, views(previous));
  assert.deepEqual(
    report.checks.map((check) => check.conclusion),
    ['success', 'neutral'],
  );
  assert.equal(report.delta, -75);
  assert.equal(report.changed[0].path, 'src/new.ts');
  assert.equal(report.changed[0].delta, 100 / 3 - 100);
  assert.equal(report.indirect[0].path, 'src/indirect.ts');
  assert.equal(report.omittedAnnotations, 1);
});

test('carryforward, component filters, named checks, and missing flags', () => {
  const warnings: string[] = [];
  const cfg = readConfig(
    `
codecov: { require_ci_to_pass: true }
flags:
  api: { paths: [src/**], carryforward: true, status: true }
  mobile: { paths: [apps/mobile/**] }
coverage:
  status:
    project:
      default: { target: auto, threshold: 1% }
      api: { target: 100%, flags: [api] }
component_management:
  individual_components:
    - component_id: core
      paths: [src/**]
      statuses:
        - {type: patch, target: 20%}
`,
    (warning) => warnings.push(warning),
  );
  const baseline = new Map([
    ...views(previous),
    [
      'api',
      deserialize({
        'src/api.ts': { lines: { 1: [1] } },
        'apps/other.ts': { lines: { 1: [0] } },
      }),
    ],
  ]);
  const report = compute(views(current), changes, cfg, baseline);
  assert.equal(warnings.length, 1);
  assert.deepEqual(report.carried, ['api']);
  assert.deepEqual(report.missing, ['mobile']);
  assert.equal(report.flags.get('api')?.has('apps/other.ts'), false);
  assert.equal(report.checks.find((check) => check.name === 'project/api')?.conclusion, 'success');
  assert.equal(report.checks.find((check) => check.name === 'component/core')?.conclusion, 'success');
});

test('handles absent uploads, incomplete diffs, and non-coverable changes', () => {
  const missing = compute(new Map(), changes, readConfig('require_uploads: true'));
  assert.deepEqual(
    missing.checks.map((check) => check.conclusion),
    ['failure', 'failure'],
  );
  assert.equal(compute(views(current), new Map(), readConfig()).checks[1].conclusion, 'success');
  assert.equal(
    compute(views(current), new Map(), readConfig(), undefined, false).checks[1].conclusion,
    'failure',
  );
  assert.equal(
    compute(views(current), changes, readConfig('baseline: {required: true}')).checks[0].conclusion,
    'failure',
  );
  assert.throws(() => readConfig('ignore: &a [*a]'));
  assert.throws(() => readConfig('coverage: {status: {patch: {default: {target: 101%}}}}'));
});

test('rejects malformed reports with a format-specific error', () => {
  const cases: [string, string, RegExp][] = [
    ['unrecognized coverage', 'auto', /Could not detect coverage format/],
    ['<report/>', 'cobertura', /Unexpected coverage XML root/],
    ['<coverage/>', 'cobertura', /no packages element/],
    ['DA:1,1', 'lcov', /outside a source record/],
    [
      '{ "meta": {"format": 3}, "files": {"a.py": {"missing_lines": [1], "executed_lines": [2], "executed_branches": [[2]]}} }',
      'coveragepy-json',
      /Invalid coverage.py branch arc/,
    ],
    ['mode: unsupported', 'go', /Invalid Go coverage mode/],
    ['mode: count\nmalformed', 'go', /Invalid Go coverprofile record/],
  ];
  for (const [report, format, message] of cases) assert.throws(() => parseCoverage(report, format), message);
});

test('applies Codecov path fixes and flag defaults while allowing individual overrides', () => {
  const config = readConfig(`
fixes:
  - 'build/::src/'
  - 'C:\\checkout:src'
flag_management:
  default_rules: {carryforward: true}
  individual_flags:
    - {name: backend, paths: ['src/backend/**']}
    - {name: frontend, carryforward: false}
flags:
  backend: {status: true}
coverage:
  status: {project: true, patch: false}
comment: {layout: 'header, files'}
`);
  assert.deepEqual(config.fixes, [
    ['build/', 'src/'],
    ['C:\\checkout', 'src'],
  ]);
  assert.deepEqual(config.flags.get('backend'), {
    paths: ['src/backend/**'],
    carryforward: true,
    status: true,
  });
  assert.equal(config.flags.get('frontend')?.carryforward, false);
  assert.deepEqual(
    config.project.map(({ name }) => name),
    ['project'],
  );
  assert.deepEqual(config.patch, []);
  assert.deepEqual([...(config.comment.layout ?? [])], ['header', 'files']);
});

test('rejects invalid or ambiguous coverage configuration', () => {
  const cases: Array<[string, RegExp]> = [
    ['coverage: {round: sideways}', /Expected one of/],
    ['require_uploads: nobody', /Expected a boolean/],
    ['comment: {layout: [header]}', /Expected a string/],
    ['ignore: [{source: anything}]', /Expected an array of strings/],
    ['fixes: [missing-delimiter]', /Expected a path rewrite/],
    ['coverage: {range: 80}', /Expected a string/],
    ['coverage: {range: "80%"}', /formatted as 70/],
    ['coverage: {range: "100...70"}', /must increase/],
    ['comment: {behavior: [', /Invalid Mustard YAML/],
    [
      'component_management: {individual_components: [{component_id: client}, {component_id: client}]}',
      /Duplicate component ID/,
    ],
    [
      'component_management: {individual_components: [{component_id: client, statuses: [{type: patch}, {type: patch}]}]}',
      /Duplicate component status type/,
    ],
  ];
  for (const [yaml, message] of cases) assert.throws(() => readConfig(yaml), message);
});

test('a strict indirect-diff policy fails project coverage despite meeting the numerical target', () => {
  const config = readConfig(`
ignore: [docs/**]
coverage: {status: {project: {default: {target: 20}}}}
indirect_changes: fail
flag_management: {default_rules: {carryforward: true}}
`);
  const baseline: FlagFiles = new Map([
    ...views(previous),
    ['existing', deserialize({ 'src/existing.ts': { lines: { 1: [1] } } })],
  ]);
  const report = compute(views(current), changes, config, baseline);
  assert.deepEqual(report.carried, ['existing']);
  assert.equal(report.checks[0].conclusion, 'failure');
  assert.match(report.checks[0].message, /outside the diff/);
});
