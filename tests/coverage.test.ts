import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCoverage } from '../src/parsers.ts';
import { deserialize, maxLines, mergeFiles, mergeLine, serialize, totals } from '../src/coverage.ts';
import type { Files, FlagFiles } from '../src/coverage.ts';
import { matches, readConfig } from '../src/config.ts';
import { pathResolver } from '../src/upload.ts';
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

test('keeps unreached LCOV branches in the coverage denominator', () => {
  const data = 'SF:src/a.ts\nDA:4,2\nBRDA:4,0,0,2\nBRDA:4,0,1,-\nend_of_record\n';
  assert.deepEqual(totals(parseCoverage(data)), { hit: 0, partial: 1, miss: 0, total: 1, percent: 0 });
  for (const truncated of ['BRDA:4,0', 'BRDA:4,0,1']) {
    assert.throws(() => parseCoverage(`SF:src/a.ts\n${truncated}\n`), /Invalid LCOV branch record/);
  }
});

test('reads line-only coverage.py reports and validates the shape of line and branch arrays', () => {
  const lineOnly = { executed_lines: [2], missing_lines: [3] };
  const report = (file: object) => JSON.stringify({ meta: { format: 3 }, files: { 'src/example.py': file } });
  assert.deepEqual(serialize(parseCoverage(report(lineOnly))), {
    'src/example.py': { lines: { 2: [1], 3: [0] } },
  });
  assert.throws(
    () => parseCoverage(report({ ...lineOnly, executed_lines: '2' })),
    /Invalid coverage.py line array/,
  );
  assert.throws(
    () => parseCoverage(report({ ...lineOnly, executed_branches: { 2: [3] } })),
    /Invalid coverage.py branch array/,
  );
});

test('JaCoCo handles the default package and ignores non-executable line entries', () => {
  const xml = `<report><package name=""><sourcefile name="Main.java">
    <line nr="3" mi="0" ci="0" mb="0" cb="0"/>
    <line nr="4" mi="0" ci="2" mb="0" cb="0"/>
  </sourcefile></package></report>`;
  assert.deepEqual(serialize(parseCoverage(xml)), { 'Main.java': { lines: { 4: [2] } } });
});

test('Cobertura rejects oversized input and does not attribute unnamed classes to a neighboring file', () => {
  const xml = (classes: string) =>
    `<coverage><packages><package><classes>${classes}</classes></package></packages></coverage>`;
  const measured = '<class filename="main.py"><lines><line number="1" hits="1"/></lines></class>';
  const unnamed = '<class><lines><line number="2" hits="0"/></lines></class>';
  assert.deepEqual(serialize(parseCoverage(xml(measured + unnamed))), {
    'main.py': { lines: { 1: [1] } },
  });
  const repeated = '<line number="1" hits="1"/>'.repeat(maxLines + 1);
  assert.throws(
    () => parseCoverage(xml(`<class filename="main.py"><lines>${repeated}</lines></class>`)),
    /Too many coverage lines/,
  );
});

test('coverage.py branch arcs do not make otherwise unmeasured lines coverable', () => {
  const data = JSON.stringify({
    meta: { format: 3 },
    files: {
      'src/example.py': {
        executed_lines: [2],
        missing_lines: [],
        executed_branches: [[2, -1]],
        missing_branches: [[5, 6]],
      },
    },
  });
  assert.deepEqual(totals(parseCoverage(data)), { hit: 1, partial: 0, miss: 0, total: 1, percent: 100 });
});

test('normalizes paths and passes Cobertura sources to the resolver', () => {
  assert.equal(
    normalizePath('C:\\agent\\work\\repo\\src\\a.ts', 'C:\\agent\\work\\repo', '', []),
    'src/a.ts',
  );
  // Windows tools disagree on drive-letter case; POSIX paths stay case-sensitive.
  assert.equal(
    normalizePath('d:\\a\\releez\\releez\\src\\cli.py', 'D:\\a\\releez\\releez', '', []),
    'src/cli.py',
  );
  assert.equal(normalizePath('/Workspace/src/a.py', '/workspace', '', []), '/Workspace/src/a.py');
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
  for (const invalid of [1, [1, 0], ['1']]) {
    assert.throws(() => deserialize({ foo: { lines: { 1: invalid } } }), /Invalid normalized line data/);
  }
  assert.deepEqual(serialize(deserialize({ foo: { lines: { 1: [1, 0, 0] } } })), {
    foo: { lines: { 1: [1] } },
  });
  const source = deserialize(JSON.parse('{"__proto__":{"lines":{"1":[1]}}}'));
  assert.equal(source.get('__proto__')?.get(1)?.[0], 1);
  assert.deepEqual(mergeLine([2, 1, 3], [4, 2, 2]), [6, 3, 3]);
  assert.deepEqual(mergeLine([Number.MAX_SAFE_INTEGER], [4]), [Number.MAX_SAFE_INTEGER]);
  assert.equal(totals(mergeFiles(new Map(), source)).percent, 100);
});

test('applies the normalized line limit across multiple files', () => {
  const hit = [1];
  const lines = Object.fromEntries(Array.from({ length: maxLines / 2 + 1 }, (_, i) => [i + 1, hit]));
  assert.throws(
    () => deserialize({ 'src/a.ts': { lines }, 'src/b.ts': { lines } }),
    /Invalid normalized line data/,
  );
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

test('disabling annotations leaves the failing patch verdict and coverage totals intact', () => {
  const report = compute(views(current), changes, readConfig('annotations: {enabled: false}'));
  assert.equal(report.checks.find(({ name }) => name === 'patch')?.conclusion, 'failure');
  assert.deepEqual([report.patch.partial, report.patch.miss], [1, 2]);
  assert.deepEqual(report.annotations, []);
  assert.equal(report.omittedAnnotations, 0);
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

test("resolves the same relative Cobertura filename against each report's own sources", (t) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'mustard-sources-')));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const name of ['a', 'b']) {
    mkdirSync(join(workspace, `packages/${name}/src`), { recursive: true });
    writeFileSync(join(workspace, `packages/${name}/src/util.py`), 'pass\n');
  }
  const { normalize } = pathResolver(workspace, '', []);
  const report = (name: string) =>
    `<coverage><sources><source>${workspace}/packages/${name}/src</source></sources><packages><package><classes><class filename="util.py"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`;
  assert.deepEqual([...parseCoverage(report('a'), 'auto', normalize).keys()], ['packages/a/src/util.py']);
  assert.deepEqual([...parseCoverage(report('b'), 'auto', normalize).keys()], ['packages/b/src/util.py']);
});

test('matches Codecov folder, glob, and regular-expression paths', () => {
  const cases: Array<[string, string[], string[]]> = [
    ['src/', ['src/a.ts', 'src/deep/b.ts'], ['srcs/a.ts', 'lib/src/a.ts']],
    ['tests', ['tests/x.py', 'tests'], ['tests_util.py', 'src/tests/x.py']],
    ['./src/api', ['src/api/v1.ts'], ['src/apis.ts']],
    ['**/*.pb.go', ['a/b.pb.go'], ['a/b.go']],
    ['**/*.test.*', ['a/b.test.ts'], ['a/b.spec.ts']],
    ['src/**/.*', ['src/deep/.generated'], ['src/deep/generated']],
    ['src/*.*', ['src/file.ts'], ['src/deep/file.ts', 'src/file']],
    ['^src/.*\\.ts$', ['src/a.ts'], ['src/a.tsx', 'lib/src/a.ts']],
    ['[a-z]+/test_.*', ['pkg/test_one.rb'], ['pkg/one.rb', 'PKG/test_one.rb']],
  ];
  for (const [pattern, hits, misses] of cases) {
    const match = matches([pattern]);
    for (const path of hits) assert.equal(match(path), true, `${pattern} should match ${path}`);
    for (const path of misses) assert.equal(match(path), false, `${pattern} should not match ${path}`);
  }
  assert.throws(() => matches(['^src/(']), /Invalid path regular expression/);
});

test('a project gate whose paths select no coverable lines fails instead of reporting 100%', () => {
  const uploads: FlagFiles = new Map([['default', new Map([['src/a.ts', new Map([[1, [1]]])]])]]);
  const config = readConfig(`
ignore: [tests]
coverage: {status: {project: {default: {target: 80}, api: {target: 80, paths: [src/apii/]}}}}
component_management:
  individual_components:
    - component_id: typo
      paths: [lib/]
      statuses: [{type: project, target: 90}]
`);
  const result = compute(uploads, new Map(), config);
  const conclusion = (name: string) => result.checks.find((check) => check.name === name)?.conclusion;
  assert.equal(conclusion('project'), 'success');
  assert.equal(conclusion('project/api'), 'failure');
  assert.equal(conclusion('component/typo'), 'failure');
  assert.match(
    result.checks.find((check) => check.name === 'project/api')?.message ?? '',
    /No coverable lines/,
  );
  const ignored = compute(
    new Map([
      [
        'default',
        new Map([
          ['tests/t.py', new Map([[1, [0]]])],
          ['src/a.ts', new Map([[1, [1]]])],
        ]),
      ],
    ]),
    new Map(),
    config,
  );
  assert.deepEqual([...ignored.files.keys()], ['src/a.ts']);
});
