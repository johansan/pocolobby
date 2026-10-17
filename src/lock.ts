import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const heldLocks = new Set<string>();

function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${startTicks}`;
    }
    if (process.platform !== 'win32') {
      return (
        // lstart prints local time, so fix the zone and locale: a broker and a backup started
        // from shells in different zones must see the same identity.
        execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
        }).trim() || undefined
      );
    }
  } catch {
    /* An unavailable identity must not be treated as proof that a process is dead. */
  }
  return undefined;
}

/** Friendly process ownership check; SQLite's exclusive lock is the final writer guard. */
export function acquireDatabaseLock(database: string): () => void {
  if (database === ':memory:') return () => {};
  const path = `${resolve(database)}.lock`;
  if (heldLocks.has(path)) throw new Error('Database is already in use by this process.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const value = JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), nonce });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, value);
      } catch (error) {
        // An empty lock (a full disk) would block every later start until removed by hand.
        closeSync(fd);
        unlinkSync(path);
        throw error;
      }
      closeSync(fd);
      heldLocks.add(path);
      return () => {
        heldLocks.delete(path);
        try {
          if (readFileSync(path, 'utf8') === value) unlinkSync(path);
        } catch {
          /* Already released. */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid: number; identity?: string };
      let previous: string;
      try {
        previous = readFileSync(path, 'utf8');
        owner = JSON.parse(previous) as { pid: number; identity?: string };
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid PID');
      } catch {
        throw new Error(
          `Cannot read database lock ${path}. Check that no broker is running before removing it.`,
        );
      }
      // Container restarts often reuse PID 1. A PID alone is not process identity.
      if (owner.pid !== process.pid) {
        try {
          process.kill(owner.pid, 0);
          const current = owner.identity ? processIdentity(owner.pid) : undefined;
          if (!current || current === owner.identity)
            throw new Error(`Database is in use by process ${owner.pid}. Stop the broker first.`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      try {
        if (readFileSync(path, 'utf8') === previous) unlinkSync(path);
      } catch {
        /* Contending recovery: retry exclusive create. */
      }
    }
  }
  throw new Error('Another process is acquiring the database. Try again.');
}
