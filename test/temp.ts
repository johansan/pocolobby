/**
 * Temporary folders for tests, removed once every test in the file has finished. A test's after
 * hooks run in the order they were registered, so a folder removed in one would go before the
 * database or server opened in it later closes, which Windows refuses (EBUSY, EPERM) where macOS
 * and Linux allow it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const folders: string[] = [];
after(() => {
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A new folder in the system's temporary directory, such as pocolobby-browser-Ab12Cd. */
export function temporaryFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}
