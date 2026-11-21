#!/usr/bin/env node
/**
 * `npm test`: every `test:*` script in package.json, several at once.
 *
 * They used to run one after another, about 150 seconds on this box, and almost none
 * of that was work: overlay-test is 50 seconds of wall clock for 7 of CPU, the broker's
 * 19 for 1, status-test's 15 for under 1. They are waiting on real timers. Run side by
 * side, the whole suite costs about what its slowest file does.
 *
 * Safe to do because the files already isolate themselves: each makes its own
 * `mkdtemp` directory, and every server they boot listens on a port the kernel hands
 * out. (Three used to count upward from a fixed number, which is the one thing a
 * parallel run breaks; they ask for a free port now.)
 *
 * The list is the package's own `test:*` scripts, so a new test file is in `npm test`
 * the moment it has a script — there is no second list to forget. Slowest first,
 * from the last run's timings, so the long ones are not started last.
 *
 * Output: one line per file that passed, and the whole output of any that failed,
 * which is all anyone reads from a green run and exactly what a red one needs.
 *
 *   npm test                       everything
 *   npm test -- overlay broker     only scripts whose name contains one of these
 *   TEST_JOBS=1 npm test           one at a time, the old behaviour
 *   TEST_VERBOSE=1 npm test        print every file's output, not only failures'
 */
import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { availableParallelism } from 'os';
import { dirname, join } from 'path';

const root = join(import.meta.dirname, '..');
const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/*
 * How many at once. Not "all of them": this is a production box with live sessions
 * on it, and a few of these files boot a server, a jsdom or a git repository each.
 * Twice the cores, because the files spend most of their time asleep — and capped,
 * because a sleep-timed check run beside twenty-seven others is a check that flakes.
 */
const JOBS = Math.max(1, Number(process.env.TEST_JOBS) || Math.min(8, availableParallelism() * 2));
const VERBOSE = Boolean(process.env.TEST_VERBOSE);

const filters = process.argv.slice(2);
let names = Object.keys(scripts).filter((n) => n.startsWith('test:'));
if (filters.length) names = names.filter((n) => filters.some((f) => n.includes(f)));
if (!names.length) {
  console.error(`no test scripts match ${filters.join(', ')}`);
  process.exit(1);
}

// Last run's durations, kept under node_modules: gitignored, present wherever the
// suite can run at all, and nothing is lost if it is missing.
const timingsFile = join(root, 'node_modules', '.cache', 'triplec-test-timings.json');
let timings = {};
try {
  timings = JSON.parse(readFileSync(timingsFile, 'utf8'));
} catch {}
names.sort((a, b) => (timings[b] ?? 1e9) - (timings[a] ?? 1e9));

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    // The script's own command, through a shell, as npm would — without npm's own
    // startup per file, which is a third of a second each.
    const child = spawn('sh', ['-c', scripts[name]], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code, signal) => {
      resolve({ name, code: signal ? 1 : code, signal, output, seconds: (Date.now() - started) / 1000 });
    });
  });
}

const started = Date.now();
const queue = [...names];
const results = [];
async function worker() {
  while (queue.length) {
    const result = await run(queue.shift());
    results.push(result);
    const passed = result.code === 0;
    const mark = passed ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${result.name.padEnd(18)} ${result.seconds.toFixed(1).padStart(5)}s`);
    if (!passed || VERBOSE) {
      console.log(result.output.replace(/^/gm, `  │ `).trimEnd());
      if (result.signal) console.log(`  │ killed by ${result.signal}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, names.length) }, worker));

// Only a full run's timings are worth keeping; a filtered one would forget the rest.
if (!filters.length) {
  try {
    mkdirSync(dirname(timingsFile), { recursive: true });
    writeFileSync(timingsFile, JSON.stringify(Object.fromEntries(results.map((r) => [r.name, r.seconds]))));
  } catch {}
}

const failed = results.filter((r) => r.code !== 0);
const wall = ((Date.now() - started) / 1000).toFixed(1);
const serial = results.reduce((s, r) => s + r.seconds, 0).toFixed(0);
if (failed.length) {
  console.log(`\n${failed.length} of ${results.length} test files FAILED in ${wall}s: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${results.length} test files passed in ${wall}s (${serial}s of them, ${JOBS} at a time)`);
