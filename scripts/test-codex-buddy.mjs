import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { installCodexStub, withCodexStub } from './codex-stub.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
// The codex CLI is stubbed: it records each call, names its conversation as the CLI does, and writes its reply.
const stub = `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.at(-1) !== '-') { console.error('Message must be read from stdin'); process.exit(2); }
const message = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.BUDDY_STUB_ROOT + '/calls', JSON.stringify({ cwd: process.cwd(), args, message }) + '\\n');
if (process.env.BUDDY_STUB_MODE === 'fail') { console.error('Fixture failure'); process.exit(7); }
const resumed = args.includes('resume');
console.error('OpenAI Codex fixture');
console.error('session id: ' + (resumed ? args[args.indexOf('resume') + 1] : 'conversation-' + Date.now()));
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'Reply to: ' + message.trim().split('\\n').at(-1) + '\\n');
`;

let stubs;
before(async () => {
  stubs = await mkdtemp(path.join(tmpdir(), 'pocolobby-buddy-codex-'));
  await installCodexStub(stubs, stub);
});
after(() => rm(stubs, { recursive: true, force: true, maxRetries: 10 }));

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pocolobby-buddy-test-')));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'bin'));
  await copyFile(path.join(source, 'codex-buddy.mjs'), path.join(root, 'scripts/codex-buddy.mjs'));
  await copyFile(path.join(source, 'codex.mjs'), path.join(root, 'scripts/codex.mjs'));
  const env = { ...withCodexStub(process.env, stubs), BUDDY_STUB_ROOT: root };
  delete env.BUDDY_MODEL;
  delete env.BUDDY_EFFORT;
  const run = (args, input = '') =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'scripts/codex-buddy.mjs'), ...args], {
        cwd: path.join(root, 'bin'),
        env,
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.on('close', (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)),
      );
      child.stdin.on('error', () => {
        /* A refused ask exits before reading its message. */
      });
      child.stdin.end(input);
    });
  const calls = async () =>
    (await readFile(path.join(root, 'calls'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  const buddy = (name) => readFile(path.join(root, '.review/buddy', name), 'utf8').catch(() => '');
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
  return { root, env, run, calls, buddy };
}
const argument = (call, flag) => call.args[call.args.indexOf(flag) + 1];

test('the first ask starts a read-only conversation in the checkout, and later asks resume it', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.run(['ask'], 'Should the postcard replace the welcome screen?\n'),
    'Reply to: Should the postcard replace the welcome screen?\n',
  );
  const [first] = await f.calls();
  assert.equal(first.cwd, f.root, 'the buddy reads the live checkout, wherever the ask comes from');
  assert.deepEqual(
    first.args.slice(0, 2),
    ['--search', 'exec'],
    'live web search precedes the exec subcommand',
  );
  assert.ok(
    !first.args.includes('--model') &&
      !first.args.some((arg) => arg.startsWith('model_reasoning_effort')),
    'the model and effort are the ones Codex CLI is configured with',
  );
  assert.equal(argument(first, '--sandbox'), 'read-only', 'the buddy never writes to the checkout');
  assert.ok(
    !first.args.some((arg) => arg.includes('service_tier')),
    'fast mode follows the account’s Codex setting',
  );
  assert.match(
    first.message,
    /^Development buddy session\. Follow the Development buddy section of AGENTS\.md\.\n\nShould the postcard/,
  );
  const session = (await f.buddy('session')).trim();
  assert.match(session, /^conversation-\d+$/);

  assert.equal(
    await f.run(['ask'], 'And its keyboard path?'),
    'Reply to: And its keyboard path?\n',
  );
  const second = (await f.calls())[1];
  assert.deepEqual(
    second.args.slice(0, 4),
    ['--search', 'exec', 'resume', session],
    'the same conversation goes on',
  );
  assert.ok(second.args.includes('sandbox_mode="read-only"'));
  assert.ok(
    !second.args.includes('--model'),
    'a resumed conversation follows the Codex configuration too',
  );
  assert.equal(
    second.message,
    'And its keyboard path?',
    'a resumed conversation gets the message alone',
  );
  const transcript = await f.buddy('transcript.md');
  assert.match(transcript, new RegExp(`# Conversation ${session}, started`));
  assert.match(
    transcript,
    /## Claude Code, .*\n\nShould the postcard replace the welcome screen\?\n[\s\S]*## Codex, .*\n\nReply to: Should the postcard/,
  );
  assert.match(transcript, /And its keyboard path\?[\s\S]*Reply to: And its keyboard path\?/);

  assert.match(await f.run(['new']), /fresh conversation/);
  await f.run(['ask'], 'A new plan.');
  const third = (await f.calls())[2];
  assert.ok(!third.args.includes('resume'), 'after new, the next ask starts over');
  assert.notEqual((await f.buddy('session')).trim(), session);
  assert.match(await f.buddy('transcript.md'), new RegExp(`# Conversation ${session} ended`));
  assert.equal(
    (await f.run(['transcript'])).trim(),
    path.join(f.root, '.review/buddy/transcript.md'),
  );
});

test('screenshots go with the message as images, by absolute path, spaces and all', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'bin/shots'));
  await writeFile(path.join(f.root, 'bin/shots/first launch.png'), 'png');
  await writeFile(path.join(f.root, 'returning.png'), 'png');
  await f.run(
    ['ask', 'shots/first launch.png', path.join(f.root, 'returning.png')],
    'How do these read?',
  );
  const [call] = await f.calls();
  const images = call.args.flatMap((arg, index) =>
    arg === '--image' ? [call.args[index + 1]] : [],
  );
  assert.deepEqual(
    images,
    [path.join(f.root, 'bin/shots/first launch.png'), path.join(f.root, 'returning.png')],
    'a relative path is the asker’s, not the checkout’s',
  );
  assert.equal(call.args.at(-1), '-', 'the message still comes on stdin');
  await f.run(['ask', 'shots/first launch.png'], 'And now?');
  assert.ok(
    (await f.calls())[1].args.includes('--image'),
    'a resumed conversation takes images too',
  );
  assert.match(await f.buddy('transcript.md'), /Image: .*first launch\.png/);
  await assert.rejects(f.run(['ask', 'missing.png'], 'Hello'), /No such image/);
});

test('a failed ask leaves the conversation and transcript as they were and releases the lock', async (t) => {
  const f = await fixture(t);
  await f.run(['ask'], 'First.');
  const session = await f.buddy('session'),
    transcript = await f.buddy('transcript.md');
  f.env.BUDDY_STUB_MODE = 'fail';
  await assert.rejects(f.run(['ask'], 'Second.'), /did not reply \(exit 7\)/);
  assert.equal(await f.buddy('session'), session);
  assert.equal(
    await f.buddy('transcript.md'),
    transcript,
    'an exchange without a reply is not recorded',
  );
  delete f.env.BUDDY_STUB_MODE;
  assert.equal(
    await f.run(['ask'], 'Third.'),
    'Reply to: Third.\n',
    'the lock went with the failed ask',
  );

  await f.run(['new']);
  f.env.BUDDY_STUB_MODE = 'fail';
  await assert.rejects(f.run(['ask'], 'Fresh.'), /did not reply/);
  assert.equal(await f.buddy('session'), '', 'a conversation that never replied is not kept');
});

test('one ask at a time; a lock left by an asker that has gone is taken over', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.review/buddy/lock'), { recursive: true });
  await writeFile(path.join(f.root, '.review/buddy/lock/pid'), `${process.pid}\n`);
  await assert.rejects(f.run(['ask'], 'Blocked.'), /Another ask is in progress/);
  assert.deepEqual(await f.calls(), []);
  const gone = await new Promise((resolve) => {
    const child = execFile(process.execPath, ['-e', '']);
    child.on('exit', () => resolve(child.pid));
  });
  await writeFile(path.join(f.root, '.review/buddy/lock/pid'), `${gone}\n`);
  // A wrapper killed mid-ask leaves its Codex running: that still holds the lock.
  await writeFile(path.join(f.root, '.review/buddy/lock/child'), `${process.pid}\n`);
  await assert.rejects(f.run(['ask'], 'Still blocked.'), /Another ask is in progress/);
  await writeFile(path.join(f.root, '.review/buddy/lock/child'), `${gone}\n`);
  assert.equal(await f.run(['ask'], 'Taken over.'), 'Reply to: Taken over.\n');
});

test('an empty message, an invalid model or effort and an unknown command are refused before Codex runs', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(['ask'], ' \n'), /message is empty/);
  f.env.BUDDY_MODEL = 'bad model';
  await assert.rejects(f.run(['ask'], 'Hello'), /Invalid buddy model/);
  delete f.env.BUDDY_MODEL;
  f.env.BUDDY_EFFORT = 'very high';
  await assert.rejects(f.run(['ask'], 'Hello'), /Invalid reasoning effort/);
  delete f.env.BUDDY_EFFORT;
  await assert.rejects(f.run(['chat']), /Usage/);
  assert.deepEqual(await f.calls(), []);
  f.env.BUDDY_MODEL = 'gpt-test';
  f.env.BUDDY_EFFORT = 'medium';
  await f.run(['ask'], 'Quick one.');
  const [call] = await f.calls();
  assert.equal(argument(call, '--model'), 'gpt-test', 'an override applies to one ask');
  assert.ok(call.args.includes('model_reasoning_effort=medium'));
});
