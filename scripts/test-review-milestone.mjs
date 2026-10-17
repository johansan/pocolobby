import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { installCodexStub, withCodexStub } from './codex-stub.mjs';

const exec = promisify(execFile);
const source = path.dirname(fileURLToPath(import.meta.url));
const alive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the fixture worker');
}
// The codex CLI is stubbed; it reads the prompt from stdin after -.
const stub = `const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args.at(-1) !== '-') { console.error('Prompt must be read from stdin'); process.exit(2); }
const prompt = fs.readFileSync(0, 'utf8');
const report = /^Report: (.+)$/m.exec(prompt)[1];
fs.appendFileSync(process.env.REVIEW_STUB_ROOT + '/calls', JSON.stringify({cwd: process.cwd(), head: cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), args, promptHead: prompt.split('\\n')[0]}) + '\\n');
const finish = () => {
  if (process.env.REVIEW_STUB_MODE === 'fail') process.exit(7);
  if (process.env.REVIEW_STUB_MODE !== 'no-report') fs.writeFileSync(report, 'Fixture completed report\\n');
  fs.writeFileSync(/^Artifacts: (.+)$/m.exec(prompt)[1] + '/evidence.md', 'Fixture evidence\\n');
  process.exit(0);
};
const timer = setInterval(() => {
  if (!fs.existsSync(process.env.REVIEW_STUB_ROOT + '/hold')) { clearInterval(timer); finish(); }
}, 25);
`;
let stubs;
before(async () => {
  stubs = await mkdtemp(path.join(tmpdir(), 'pocolobby-review-codex-'));
  await installCodexStub(stubs, stub);
});
after(() => rm(stubs, { recursive: true, force: true, maxRetries: 10 }));

async function fixture(t, mode = 'complete') {
  // The launcher names paths from its own resolved location.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pocolobby-review-test-')));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, '.review'));
  await copyFile(
    path.join(source, 'review-milestone.mjs'),
    path.join(root, 'scripts/review-milestone.mjs'),
  );
  await copyFile(path.join(source, 'codex.mjs'), path.join(root, 'scripts/codex.mjs'));
  // CLAUDE.md is the process snapshot; AGENTS.md is the reviewer prompt.
  await writeFile(path.join(root, 'CLAUDE.md'), 'Fixture process instructions\n');
  await writeFile(path.join(root, 'AGENTS.md'), 'Fixture reviewer instructions\n');
  await writeFile(path.join(root, '.gitignore'), '.review/\nhold\ncalls\n');
  git('init', '-q');
  git('config', 'user.name', 'Review fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-qm', 'Create fixture');
  const base = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'change'), 'Reviewed change\n');
  git('add', 'change');
  git('commit', '-qm', 'Add reviewed change');
  const head = git('rev-parse', 'HEAD');
  const env = {
    ...withCodexStub(process.env, stubs),
    REVIEW_STUB_ROOT: root,
    REVIEW_STUB_MODE: mode,
  };
  delete env.REVIEW_MODEL;
  delete env.REVIEW_EFFORT;
  const run = (...args) =>
    exec(process.execPath, [path.join(root, 'scripts/review-milestone.mjs'), ...args], {
      cwd: root,
      env,
    });
  const key = (scope) => `${scope}-${base}-${head}`;
  const directory = (scope) => path.join(root, '.review/runs', key(scope));
  const status = async (scope) =>
    readFile(path.join(directory(scope), 'status'), 'utf8').catch(() => '');
  const recorded = async (scope, name) =>
    (await readFile(path.join(directory(scope), name), 'utf8')).trim();
  const calls = async () =>
    (await readFile(path.join(root, 'calls'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  t.after(async () => {
    for (const name of await readdir(path.join(root, '.review/runs')).catch(() => [])) {
      for (const file of ['pid', 'reviewer-pid']) {
        const pid = await readFile(path.join(root, '.review/runs', name, file), 'utf8').catch(
          () => '',
        );
        if (pid && alive(pid)) {
          try {
            process.kill(Number(pid), 'SIGTERM');
          } catch {
            /* The reviewer may have just exited. */
          }
        }
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });
  return { root, git, base, head, env, run, key, directory, status, recorded, calls };
}
const argument = (call, flag) => call.args[call.args.indexOf(flag) + 1];

test('pins refs, isolates worktrees and atomically deduplicates concurrent launches', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'hold'), 'hold');
  await Promise.all([
    f.run('launch', 'model', f.base, 'HEAD', 'architecture'),
    f.run('launch', 'same-range', f.base, 'HEAD', 'architecture'),
  ]);
  f.git('commit', '--allow-empty', '-qm', 'Move the builder HEAD');
  await until(async () => (await f.calls()).length > 0);
  const calls = await f.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].head, f.head);
  assert.notEqual(calls[0].cwd, f.root);
  // Live web search is a top-level codex flag, so it precedes the exec subcommand.
  assert.deepEqual(calls[0].args.slice(0, 2), ['--search', 'exec']);
  assert.ok(
    !calls[0].args.includes('--model') &&
      !calls[0].args.some((arg) => arg.startsWith('model_reasoning_effort')),
    'the model and effort are the ones Codex CLI is configured with',
  );
  assert.ok(
    !calls[0].args.some((arg) => arg.includes('service_tier')),
    'fast mode follows the account’s Codex setting',
  );
  assert.ok(calls[0].args.includes('approval_policy=never'));
  assert.equal(argument(calls[0], '--sandbox'), 'workspace-write');
  assert.equal(argument(calls[0], '--add-dir'), f.directory('architecture'));
  assert.equal(calls[0].args.at(-1), '-');
  assert.equal(calls[0].promptHead, 'Fixture reviewer instructions');
  assert.equal(await f.recorded('architecture', 'model'), '');
  assert.equal(await f.recorded('architecture', 'effort'), '');
  await assert.rejects(f.run('cleanup', f.key('architecture')), /still live/);
  const prompt = await readFile(path.join(f.directory('architecture'), 'prompt.md'), 'utf8');
  assert.match(prompt, /^Fixture reviewer instructions/);
  assert.ok(
    prompt.includes(
      `Current process instructions: ${path.join(f.directory('architecture'), 'process.md')}\n`,
    ),
  );
  assert.equal(
    await readFile(path.join(f.directory('architecture'), 'process.md'), 'utf8'),
    'Fixture process instructions\n',
  );
  await assert.rejects(f.run('retry', f.key('architecture')), /still live/);
  await rm(path.join(f.root, 'hold'));
  await until(async () => (await f.status('architecture')).trim() === 'completed');
  await assert.rejects(readFile(path.join(calls[0].cwd, '.git')), { code: 'ENOENT' });
  await assert.rejects(f.run('retry', f.key('architecture')), /Completed reviews/);
  await f.run('launch', 'second', f.base, f.head, 'milestone');
  await until(async () => (await f.status('milestone')).trim() === 'completed');
  await assert.rejects(
    f.run('launch', 'ui', f.base, f.head, 'interaction'),
    /Unknown review scope/,
  );
  const allCalls = await f.calls();
  assert.notEqual(allCalls[0].cwd, allCalls[1].cwd);
  assert.match((await f.run('status')).stdout, /completed/);
});

test('a launch honors model and effort overrides, and a retry keeps them', async (t) => {
  const f = await fixture(t, 'fail');
  f.env.REVIEW_MODEL = 'gpt-test';
  f.env.REVIEW_EFFORT = 'medium';
  await f.run('launch', 'override', f.base, f.head, 'milestone');
  await until(async () => (await f.status('milestone')).trim() === 'failed');
  const [call] = await f.calls();
  assert.equal(argument(call, '--model'), 'gpt-test');
  assert.ok(call.args.includes('model_reasoning_effort=medium'));
  assert.equal(await f.recorded('milestone', 'model'), 'gpt-test');
  assert.equal(await f.recorded('milestone', 'effort'), 'medium');
  // A later environment does not change a recorded run.
  f.env.REVIEW_MODEL = 'other';
  f.env.REVIEW_EFFORT = 'low';
  await until(
    async () => !alive(await readFile(path.join(f.directory('milestone'), 'pid'), 'utf8')),
  );
  f.env.REVIEW_STUB_MODE = 'complete';
  await f.run('retry', f.key('milestone'));
  await until(async () => (await f.status('milestone')).trim() === 'completed');
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.equal(argument(calls[1], '--model'), 'gpt-test');
  assert.ok(calls[1].args.includes('model_reasoning_effort=medium'));
});

test('launch refuses an invalid model or effort before recording a run', async (t) => {
  const f = await fixture(t);
  f.env.REVIEW_EFFORT = 'very high';
  await assert.rejects(f.run('launch', 'effort', f.base, f.head, 'fix'), /reasoning effort/);
  delete f.env.REVIEW_EFFORT;
  f.env.REVIEW_MODEL = 'bad model';
  await assert.rejects(f.run('launch', 'model', f.base, f.head, 'fix'), /review model/);
  assert.deepEqual(await readdir(path.join(f.root, '.review/runs')), []);
});

test('records failure and permits an explicit retry after the worker exits', async (t) => {
  const f = await fixture(t, 'fail');
  await f.run('launch', 'failure', f.base, f.head, 'fix');
  await until(async () => (await f.status('fix')).trim() === 'failed');
  await assert.rejects(readFile(path.join(f.root, '.review/worktrees', f.key('fix'), '.git')), {
    code: 'ENOENT',
  });
  await until(async () => !alive(await readFile(path.join(f.directory('fix'), 'pid'), 'utf8')));
  f.env.REVIEW_STUB_MODE = 'complete';
  await writeFile(path.join(f.root, 'hold'), 'hold');
  const retries = await Promise.allSettled([
    f.run('retry', f.key('fix')),
    f.run('retry', f.key('fix')),
  ]);
  assert.equal(retries.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(retries.filter((result) => result.status === 'rejected').length, 1);
  await rm(path.join(f.root, 'hold'));
  await until(async () => (await f.status('fix')).trim() === 'completed');
  assert.equal((await readFile(path.join(f.directory('fix'), 'attempt'), 'utf8')).trim(), '2');
  assert.ok((await readdir(f.directory('fix'))).includes('attempt-1.log'));
  assert.ok((await readdir(f.directory('fix'))).includes('attempt-2.log'));
});

test('a successful CLI exit without a report remains a failed review', async (t) => {
  const f = await fixture(t, 'no-report');
  await f.run('launch', 'missing-report', f.base, f.head, 'milestone');
  await until(async () => (await f.status('milestone')).trim() === 'failed');
  assert.match(
    await readFile(path.join(f.directory('milestone'), 'attempt-1.log'), 'utf8'),
    /without a report/,
  );
  await assert.rejects(f.run('launch', 'bad-ref', f.base, 'does-not-exist', 'milestone'));
  assert.equal((await readdir(path.join(f.root, '.review/runs'))).length, 1);
});

test('a surviving reviewer prevents retry after its wrapper is killed', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'hold'), 'hold');
  await f.run('launch', 'interrupted', f.base, f.head, 'architecture');
  await until(async () => (await f.calls()).length > 0);
  const pid = Number(await readFile(path.join(f.directory('architecture'), 'pid'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await until(async () => !alive(pid));
  if (process.platform === 'win32') {
    // Windows ends the reviewer with its wrapper: Node starts children in a job object that closes with their parent.
    await until(
      async () =>
        !alive(await readFile(path.join(f.directory('architecture'), 'reviewer-pid'), 'utf8')),
    );
    assert.match((await f.run('status')).stdout, /interrupted/);
    await f.run('cleanup', f.key('architecture'));
    await rm(path.join(f.root, 'hold'));
    await f.run('retry', f.key('architecture'));
    await until(async () => (await f.status('architecture')).trim() === 'completed');
    return;
  }
  await assert.rejects(f.run('retry', f.key('architecture')), /still live/);
  await rm(path.join(f.root, 'hold'));
  await until(
    async () =>
      !alive(await readFile(path.join(f.directory('architecture'), 'reviewer-pid'), 'utf8')),
  );
  assert.match((await f.run('status')).stdout, /interrupted/);
  await assert.rejects(f.run('retry', f.key('architecture')), /report exists/);
  await f.run('cleanup', f.key('architecture'));
  await assert.rejects(
    readFile(path.join(f.root, '.review/worktrees', f.key('architecture'), '.git')),
    { code: 'ENOENT' },
  );
});
