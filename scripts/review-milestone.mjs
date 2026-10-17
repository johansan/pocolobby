#!/usr/bin/env node
// See the builder instructions in CLAUDE.md and the reviewer prompt in AGENTS.md.
// launch <id> <base> <head> <architecture|milestone|fix> [focus]
// status / retry <key> / cleanup <key>. No polling daemon or automatic retries.
// The reviewer's model, reasoning effort and fast mode follow the Codex configuration.
// REVIEW_MODEL and REVIEW_EFFORT override the model and reasoning effort for one
// launch; a retry keeps the launch's overrides.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive, codexOptions } from './codex.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const dir = path.join(root, '.review');
const scopes = ['architecture', 'milestone', 'fix'];

class LauncherError extends Error {}
const fail = (message) => {
  throw new LauncherError(message);
};
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};
const nonEmpty = (file) => {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
};
const paths = (key) => ({
  run: path.join(dir, 'runs', key),
  worktree: path.join(dir, 'worktrees', key),
});

function validKey(key) {
  if (!key) fail('Missing review key');
  if (!/^[a-z0-9-]+$/.test(key)) fail('Invalid review key');
  return key;
}

function writeStatus(run, state) {
  const temporary = path.join(run, `status.tmp.${process.pid}`);
  fs.writeFileSync(temporary, `${state}\n`);
  fs.renameSync(temporary, path.join(run, 'status'));
}

const live = (run) => ['pid', 'reviewer-pid'].some((file) => alive(read(path.join(run, file))));

function cleanupWorktree(worktree) {
  if (fs.existsSync(path.join(worktree, '.git'))) git('worktree', 'remove', '--force', worktree);
}

async function start(key) {
  const { run } = paths(key);
  const lock = path.join(run, 'start.lock');
  try {
    fs.mkdirSync(lock);
  } catch {
    fail('A launch is already in progress');
  }
  try {
    if (live(run)) fail('Review worker or reviewer is still live');
    const attempt = Number(read(path.join(run, 'attempt')) || 0) + 1;
    fs.writeFileSync(path.join(run, 'attempt'), `${attempt}\n`);
    writeStatus(run, 'starting');
    // A detached process survives the calling terminal's teardown.
    const log = fs.openSync(path.join(run, `attempt-${attempt}.log`), 'w');
    try {
      const worker = spawn(process.execPath, [script, 'worker', key], {
        detached: true,
        stdio: ['ignore', log, log],
        windowsHide: true,
      });
      await new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.once('spawn', resolve);
      });
      fs.writeFileSync(path.join(run, 'pid'), `${worker.pid}\n`);
      worker.unref();
    } finally {
      fs.closeSync(log);
    }
    console.log(`Review ${key} launched; result: ${path.join(run, 'result.md')}`);
  } finally {
    fs.rmdirSync(lock);
  }
}

async function launch(args) {
  if (args.length < 4 || args.length > 5)
    fail('launch requires id, base, head, scope and optional focus');
  const [id, baseRef, headRef, scope, focus] = args;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail('Invalid review id');
  const base = git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`);
  const head = git('rev-parse', '--verify', '--end-of-options', `${headRef}^{commit}`);
  if (!scopes.includes(scope)) fail(`Unknown review scope: ${scope}`);
  try {
    git('merge-base', '--is-ancestor', base, head);
  } catch {
    fail('Base must be an ancestor of head');
  }
  const model = process.env.REVIEW_MODEL ?? '';
  const effort = process.env.REVIEW_EFFORT ?? '';
  codexOptions(model, effort, fail, 'review');
  const key = `${scope}-${base}-${head}`;
  const { run, worktree } = paths(key);
  try {
    fs.mkdirSync(run);
  } catch {
    console.log(`Review already recorded: ${key}; use status to inspect it`);
    return;
  }
  fs.mkdirSync(path.join(run, 'artifacts'));
  for (const [name, value] of Object.entries({ id, base, head, model, effort }))
    fs.writeFileSync(path.join(run, name), `${value}\n`);
  fs.copyFileSync(path.join(root, 'CLAUDE.md'), path.join(run, 'process.md'));
  fs.writeFileSync(
    path.join(run, 'prompt.md'),
    [
      fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
      `\n## This run\n\nReview ID: ${id}\nBase: ${base}\nHead: ${head}\nScope: ${scope}\n`,
      `Worktree: ${worktree}\nArtifacts: ${path.join(run, 'artifacts')}\nReport: ${path.join(run, 'result.md')}\n`,
      `Current process instructions: ${path.join(run, 'process.md')}\nFocus: ${focus ?? 'Review this scope against the applicable requirements.'}\n`,
      '\nUse that process snapshot if the reviewed commit has older workflow instructions.\n',
    ].join(''),
  );
  await start(key);
}

async function worker(key) {
  validKey(key);
  const { run, worktree } = paths(key);
  let reviewer;
  let stopped = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      stopped = true;
      reviewer?.kill(signal);
    });
  }
  let code = 0;
  try {
    writeStatus(run, 'running');
    // An override recorded at launch holds for a retry; without one, Codex CLI's configuration decides.
    const overrides = codexOptions(
      read(path.join(run, 'model')),
      read(path.join(run, 'effort')),
      fail,
      'review',
    );
    const head = read(path.join(run, 'head'));
    if (!fs.existsSync(path.join(worktree, '.git')))
      git('worktree', 'add', '--detach', worktree, head);
    const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim();
    if (checkedOut !== head) fail('Worktree no longer matches pinned head');
    if (stopped) fail('Review stopped before the reviewer started');
    // The run directory must stay writable for the report; the worktree is
    // disposable, so workspace-write needs no approvals.
    const prompt = fs.openSync(path.join(run, 'prompt.md'), 'r');
    try {
      reviewer = spawn(
        'codex',
        [
          '--search',
          'exec',
          ...overrides,
          '-c',
          'approval_policy=never',
          '--sandbox',
          'workspace-write',
          '--add-dir',
          run,
          '--output-last-message',
          path.join(run, 'last-message.md'),
          '-',
        ],
        { cwd: worktree, stdio: [prompt, 'inherit', 'inherit'], windowsHide: true },
      );
      await new Promise((resolve, reject) => {
        reviewer.once('error', reject);
        reviewer.once('spawn', resolve);
      });
    } finally {
      fs.closeSync(prompt);
    }
    fs.writeFileSync(path.join(run, 'reviewer-pid'), `${reviewer.pid}\n`);
    const exit = await new Promise((resolve) =>
      reviewer.once('exit', (status, signal) => resolve(status ?? signal)),
    );
    if (stopped) {
      code = 143;
      return;
    }
    if (exit !== 0) {
      console.error(`Reviewer exited with ${exit}`);
      code = typeof exit === 'number' ? exit : 1;
      return;
    }
    if (!nonEmpty(path.join(run, 'result.md'))) fail('Reviewer exited without a report');
    if (!nonEmpty(path.join(run, 'artifacts', 'evidence.md')))
      fail('Reviewer exited without separate evidence');
  } catch (error) {
    console.error(error instanceof LauncherError ? error.message : error);
    code = 1;
  } finally {
    try {
      cleanupWorktree(worktree);
    } catch (error) {
      console.error(error.message);
      code = 1;
    }
    writeStatus(run, code === 0 && nonEmpty(path.join(run, 'result.md')) ? 'completed' : 'failed');
    process.exitCode = code;
  }
}

function status() {
  const runs = path.join(dir, 'runs');
  const keys = fs.existsSync(runs) ? fs.readdirSync(runs).sort() : [];
  for (const key of keys) {
    const run = path.join(runs, key);
    if (!fs.statSync(run).isDirectory()) continue;
    let state = read(path.join(run, 'status')) || 'setup-failed';
    if (
      (state === 'starting' || state === 'running') &&
      fs.existsSync(path.join(run, 'pid')) &&
      !live(run)
    )
      state = 'interrupted';
    console.log(`${key}\t${state}\t${path.join(run, 'result.md')}`);
  }
}

async function retry(key) {
  const { run } = paths(validKey(key));
  if (!fs.existsSync(path.join(run, 'prompt.md'))) fail('Review has no saved prompt');
  if (read(path.join(run, 'status')) === 'completed') fail('Completed reviews cannot be retried');
  if (live(run)) fail('Review worker or reviewer is still live');
  if (nonEmpty(path.join(run, 'result.md'))) fail('A report exists; inspect it before retrying');
  // Reports and attempt logs survive; a cleaned source worktree is recreated.
  await start(key);
}

function cleanup(key) {
  const { run, worktree } = paths(validKey(key));
  if (!fs.existsSync(path.join(run, 'prompt.md'))) fail('Unknown review run');
  if (live(run)) fail('Review worker or reviewer is still live');
  cleanupWorktree(worktree);
}

const [command, ...rest] = process.argv.slice(2);
try {
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'worktrees'), { recursive: true });
  if (command === 'launch') await launch(rest);
  else if (command === 'worker') await worker(rest[0]);
  else if (command === 'status') status();
  else if (command === 'retry') await retry(rest[0]);
  else if (command === 'cleanup') cleanup(rest[0]);
  else
    fail(
      'usage: node scripts/review-milestone.mjs launch <id> <base> <head> <scope> [focus] | status | retry <key> | cleanup <key>',
    );
} catch (error) {
  if (!(error instanceof LauncherError) && error.status === undefined) throw error;
  if (error instanceof LauncherError) console.error(error.message);
  process.exitCode = 1;
}
