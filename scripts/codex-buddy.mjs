#!/usr/bin/env node
// The development buddy: one standing Codex conversation the builder consults on decisions.
// See "Development buddy" in CLAUDE.md and AGENTS.md.
// ask [image ...]  send the message on stdin, with any screenshots, and print the reply,
//                   starting a conversation if none stands
// new     end the standing conversation; the next ask starts a fresh one
// transcript  print where every exchange is kept
// The buddy reads the live checkout without writing to it. Its model, reasoning effort and
// fast mode follow the Codex configuration; BUDDY_MODEL and BUDDY_EFFORT override one ask.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { alive, codexOptions } from './codex.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.review', 'buddy');
const transcript = path.join(dir, 'transcript.md');
const file = (name) => path.join(dir, name);

class BuddyError extends Error {}
const fail = (message) => {
  throw new BuddyError(message);
};
const read = (name) => {
  try {
    return fs.readFileSync(file(name), 'utf8');
  } catch {
    return '';
  }
};
const pad = (number) => String(number).padStart(2, '0');
function stamp() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// One exchange at a time; a lock whose asker and Codex child have both gone is taken over.
function lock() {
  const lockDirectory = file('lock');
  try {
    fs.mkdirSync(lockDirectory);
  } catch {
    // A lock whose pid is not written yet is being taken right now; only an old one is abandoned.
    const pid = read('lock/pid').trim();
    const young =
      Date.now() - (fs.statSync(lockDirectory, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 10_000;
    if (alive(pid) || alive(read('lock/child').trim()) || (!pid && young))
      fail('Another ask is in progress');
    fs.rmSync(lockDirectory, { recursive: true, force: true });
    try {
      fs.mkdirSync(lockDirectory);
    } catch {
      fail('Another ask is in progress');
    }
  }
  fs.writeFileSync(path.join(lockDirectory, 'pid'), `${process.pid}\n`);
  return () => fs.rmSync(lockDirectory, { recursive: true, force: true });
}

function codex(args, input) {
  const stdin = fs.openSync(input, 'r');
  const log = fs.openSync(file('last.log'), 'w');
  try {
    const child = spawn('codex', args, { cwd: root, stdio: [stdin, log, log], windowsHide: true });
    // The child holds the lock too: a wrapper killed mid-ask must not let a second ask run beside
    // its Codex. An interrupted wrapper takes its Codex with it.
    if (child.pid) fs.writeFileSync(file('lock/child'), `${child.pid}\n`);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.once(signal, () => {
        child.kill(signal);
        process.exit(130);
      });
    return new Promise((resolve) => {
      child.once('error', (error) => {
        fs.appendFileSync(file('last.log'), `${error.message}\n`);
        resolve(127);
      });
      child.once('exit', (code, signal) => resolve(code ?? signal));
    });
  } finally {
    fs.closeSync(stdin);
    fs.closeSync(log);
  }
}

async function ask(images) {
  // Each screenshot goes with the message as an image the model can see.
  const imageArgs = images.flatMap((image) => {
    if (!fs.statSync(image, { throwIfNoEntry: false })?.isFile()) fail(`No such image: ${image}`);
    return ['--image', path.resolve(image)];
  });
  const overrides = codexOptions(
    process.env.BUDDY_MODEL ?? '',
    process.env.BUDDY_EFFORT ?? '',
    fail,
    'buddy',
  );
  const unlock = lock();
  try {
    const message = fs.readFileSync(0, 'utf8');
    fs.writeFileSync(file('message.md'), message);
    if (!message.trim()) fail('The message is empty');
    fs.rmSync(file('reply.md'), { force: true });
    const session = read('session').trim();
    const reply = ['--output-last-message', file('reply.md'), '-'];
    let status;
    if (!session) {
      fs.writeFileSync(
        file('prompt.md'),
        `Development buddy session. Follow the Development buddy section of AGENTS.md.\n\n${message}`,
      );
      status = await codex(
        [
          '--search',
          'exec',
          ...overrides,
          '-c',
          'approval_policy=never',
          '--sandbox',
          'read-only',
          ...imageArgs,
          ...reply,
        ],
        file('prompt.md'),
      );
      if (status === 0) {
        const started = /^session id: *(.*)$/m.exec(read('last.log'))?.[1]?.trim();
        if (!started) fail(`Codex did not name the new conversation; see ${file('last.log')}`);
        fs.writeFileSync(file('session'), `${started}\n`);
        fs.appendFileSync(transcript, `\n# Conversation ${started}, started ${stamp()}\n`);
      }
    } else {
      status = await codex(
        [
          '--search',
          'exec',
          'resume',
          session,
          ...overrides,
          '-c',
          'approval_policy=never',
          '-c',
          'sandbox_mode="read-only"',
          ...imageArgs,
          ...reply,
        ],
        file('message.md'),
      );
    }
    const answer = read('reply.md');
    if (status !== 0 || !answer) {
      process.stderr.write(`${read('last.log').split('\n').slice(-21).join('\n')}`);
      fail(`The buddy did not reply (exit ${status}); the conversation stands as it was`);
    }
    const shown = imageArgs
      .filter((_, index) => index % 2 === 1)
      .map((image) => `\n\nImage: ${image}`)
      .join('');
    fs.appendFileSync(
      transcript,
      `\n## Claude Code, ${stamp()}\n\n${message}${shown}\n\n## Codex, ${stamp()}\n\n${answer}\n`,
    );
    process.stdout.write(answer);
  } finally {
    unlock();
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  fs.mkdirSync(dir, { recursive: true });
  if (command === 'ask') await ask(rest);
  else if (command === 'new') {
    const session = read('session').trim();
    if (session) fs.appendFileSync(transcript, `\n# Conversation ${session} ended ${stamp()}\n`);
    fs.rmSync(file('session'), { force: true });
    console.log('The next ask starts a fresh conversation.');
  } else if (command === 'transcript') console.log(transcript);
  else fail('Usage: node scripts/codex-buddy.mjs ask [image ...] < message | new | transcript');
} catch (error) {
  if (!(error instanceof BuddyError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
