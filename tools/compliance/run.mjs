#!/usr/bin/env node
// Runs Fastmail's JMAP-TestSuite against the dev server and compares the
// outcome with the recorded baseline.
//
//   pnpm compliance                 everything
//   pnpm compliance t/Mailbox       some directories or files of the suite
//   pnpm compliance --update        record the outcome as the new baseline
//   pnpm compliance --verbose t/Mailbox/get/basic.t   show a file's own output
//
// Needs Docker (the suite is Perl with many dependencies) and a built dev
// server; `nx run @mailless/source:compliance` takes care of the build.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const baselinePath = join(here, 'baseline.json');
const resultsPath = join(here, 'results.json');
const IMAGE = 'mailless-compliance';

const args = process.argv.slice(2);
const update = args.includes('--update');
const verbose = args.includes('--verbose');
const paths = args.filter((arg) => !arg.startsWith('--'));

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      // Captured output includes the diagnostics, which are only of use when something breaks.
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      ...options.spawn,
    });
    let output = '';
    let diagnostics = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (diagnostics += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output, diagnostics }));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startDevServer(port, token) {
  const child = spawn('node', [join(root, 'apps/dev-server/dist/main.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      MAILLESS_DEV_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (chunk) => (log += chunk));
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.on('error', reject);
    child.on('exit', (code) =>
      reject(new Error(`The dev server stopped (exit ${code}).\n${log}`)),
    );
  });
  return { stop: () => child.kill(), errors: () => log };
}

/** What became of one test file: `pass`, `fail`, or `skip` when none of it ran. */
function statusOf(file) {
  if (file.broken || file.failed.length > 0) return 'fail';
  if (file.passed.length === 0) return 'skip';
  return 'pass';
}

function summarise(files) {
  const areas = new Map();
  for (const [path, file] of Object.entries(files)) {
    const parts = path.split('/');
    const area = parts.length > 2 ? parts[1] : '(top level)';
    const row = areas.get(area) ?? {
      files: 0,
      pass: 0,
      fail: 0,
      skip: 0,
      testsPassed: 0,
      testsFailed: 0,
    };
    row.files += 1;
    row[statusOf(file)] += 1;
    row.testsPassed += file.passed.length;
    row.testsFailed += file.failed.length;
    areas.set(area, row);
  }
  return areas;
}

function printSummary(files) {
  const areas = summarise(files);
  const names = [...areas.keys()].sort();
  const width = Math.max(...names.map((name) => name.length), 5);
  const line = (cells) =>
    console.log(
      cells[0].padEnd(width) +
        cells
          .slice(1)
          .map((cell) => String(cell).padStart(10))
          .join(''),
    );
  line(['Area', 'files', 'pass', 'fail', 'skip', 'tests ok', 'failed']);
  const total = [0, 0, 0, 0, 0, 0];
  for (const name of names) {
    const row = areas.get(name);
    const cells = [
      row.files,
      row.pass,
      row.fail,
      row.skip,
      row.testsPassed,
      row.testsFailed,
    ];
    cells.forEach((cell, index) => (total[index] += cell));
    line([name, ...cells]);
  }
  line(['Total', ...total]);
}

/** The part of an outcome worth recording: everything that is not a plain pass. */
function toBaseline(files) {
  const baseline = {};
  for (const path of Object.keys(files).sort()) {
    const file = files[path];
    const status = statusOf(file);
    if (status === 'pass') continue;
    baseline[path] =
      status === 'skip'
        ? {
            status,
            reason:
              file.skipAll ??
              file.skipReason ??
              [...new Set(file.skipped.map((skip) => skip.reason))].join('; '),
          }
        : {
            status,
            failed: [...file.failed].sort(),
            ...(file.broken ? { broken: true } : {}),
          };
  }
  return baseline;
}

function compare(baseline, files) {
  const regressions = [];
  const fixes = [];
  for (const [path, file] of Object.entries(files)) {
    const known = baseline[path];
    const knownFailures = new Set(known?.failed ?? []);
    for (const name of file.failed) {
      if (!knownFailures.has(name)) regressions.push(`${path}: ${name}`);
    }
    if (file.broken && !known?.broken) {
      regressions.push(`${path}: the file did not run to completion`);
    }
    if (statusOf(file) === 'skip' && known?.status !== 'skip') {
      regressions.push(`${path}: now skipped`);
    }
    const failedNow = new Set(file.failed);
    for (const name of knownFailures) {
      if (!failedNow.has(name)) fixes.push(`${path}: ${name}`);
    }
    if (known?.status === 'skip' && statusOf(file) !== 'skip') {
      fixes.push(`${path}: no longer skipped`);
    }
  }
  return { regressions, fixes };
}

const build = await run('docker', ['build', '--quiet', '-t', IMAGE, here], {
  capture: true,
});
if (build.code !== 0) {
  console.error(build.diagnostics);
  console.error('Could not build the test suite image. Is Docker running?');
  process.exit(1);
}

const port = await freePort();
const token = randomBytes(18).toString('hex');
const config = mkdtempSync(join(tmpdir(), 'mailless-compliance-'));
writeFileSync(
  join(config, 'adapter.json'),
  JSON.stringify({
    adapter: 'Mailless',
    base_uri: `http://127.0.0.1:${port}`,
    token,
  }),
);

const server = await startDevServer(port, token);
let outcome;
try {
  const docker = [
    'run',
    '--rm',
    // The dev server listens on this machine's loopback address only.
    '--network',
    'host',
    '-v',
    `${config}:/config:ro`,
    '-e',
    'JMAP_SERVER_ADAPTER_FILE=/config/adapter.json',
  ];
  if (verbose) {
    const result = await run('docker', [
      ...docker,
      '--entrypoint',
      'prove',
      IMAGE,
      '-Ilib',
      '-r',
      '-v',
      ...(paths.length > 0 ? paths : ['t']),
    ]);
    process.exit(result.code ?? 1);
  }
  outcome = await run('docker', [...docker, IMAGE, ...paths], {
    capture: true,
  });
} finally {
  server.stop();
  rmSync(config, { recursive: true, force: true });
}

let files;
try {
  ({ files } = JSON.parse(outcome.output));
} catch {
  console.error(
    'The test suite did not report results:\n',
    outcome.output,
    outcome.diagnostics.split('\n').slice(-40).join('\n'),
  );
  process.exit(1);
}
if (server.errors().trim()) {
  console.error(
    'The dev server logged errors during the run:\n' +
      server.errors().split('\n').slice(0, 40).join('\n'),
  );
}

printSummary(files);

const isFullRun = paths.length === 0;
if (isFullRun) writeFileSync(resultsPath, JSON.stringify({ files }, null, 1));

if (update) {
  if (!isFullRun) {
    console.error('\nThe baseline is only recorded from a full run.');
    process.exit(1);
  }
  writeFileSync(
    baselinePath,
    `${JSON.stringify(toBaseline(files), null, 2)}\n`,
  );
  console.log(`\nBaseline recorded in ${baselinePath}`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch {
  console.log('\nNo baseline yet. Record one with `pnpm compliance --update`.');
  process.exit(0);
}
const { regressions, fixes } = compare(baseline, files);
if (fixes.length > 0) {
  console.log(`\nNow passing (${fixes.length}), run with --update to record:`);
  for (const fix of fixes) console.log(`  ${fix}`);
}
if (regressions.length > 0) {
  console.error(`\nNo longer passing (${regressions.length}):`);
  for (const regression of regressions) console.error(`  ${regression}`);
  process.exit(1);
}
console.log('\nNothing that passed before fails now.');
