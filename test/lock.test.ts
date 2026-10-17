import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireDatabaseLock } from '../src/lock.js';

test('lock rejects a second in-process owner and recovers a previous container PID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-lock-'));
  const database = join(directory, 'state.db');
  try {
    await writeFile(
      `${database}.lock`,
      JSON.stringify({ pid: process.pid, identity: 'previous-container-start', nonce: 'old' }),
    );
    const release = acquireDatabaseLock(database);
    assert.throws(() => acquireDatabaseLock(database), /already in use/);
    const lock = JSON.parse(await readFile(`${database}.lock`, 'utf8')) as { nonce: string };
    assert.notEqual(lock.nonce, 'old');
    release();
    acquireDatabaseLock(database)();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('live process lock is respected, while SIGKILL leaves a reclaimable lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-lock-child-'));
  const database = join(directory, 'state.db');
  const source = `import {acquireDatabaseLock} from './src/lock.ts'; acquireDatabaseLock(process.argv[1]); process.stdout.write('locked\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source, database],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child lock timeout')), 5000);
      child.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.throws(() => acquireDatabaseLock(database), /in use/);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    acquireDatabaseLock(database)();
  } finally {
    child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
