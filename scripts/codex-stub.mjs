// A fake codex CLI for the launcher tests, put where the launchers look for codex.
// Windows starts only real executables without a shell, so there the stub is a Node
// single executable application; elsewhere it is a script with a Node shebang.
import { execFileSync } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Write `source`, CommonJS run by Node, as an executable named codex in `directory`. */
export async function installCodexStub(directory, source) {
  if (process.platform !== 'win32') {
    const stub = path.join(directory, 'codex');
    await writeFile(stub, `#!/usr/bin/env node\n${source}`);
    await chmod(stub, 0o755);
    return;
  }
  await writeFile(path.join(directory, 'stub.cjs'), source);
  await writeFile(
    path.join(directory, 'sea.json'),
    JSON.stringify({ main: 'stub.cjs', output: 'codex.exe', disableExperimentalSEAWarning: true }),
  );
  try {
    execFileSync(process.execPath, ['--build-sea', 'sea.json'], { cwd: directory, stdio: 'pipe' });
  } catch (error) {
    throw new Error('Building the codex stub on Windows needs a Node with --build-sea', {
      cause: error,
    });
  }
}

/** The environment with `directory` first on PATH, under the one PATH key Windows children see. */
export function withCodexStub(env, directory) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const result = Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toUpperCase() !== 'PATH'),
  );
  result.PATH = `${directory}${path.delimiter}${env[key] ?? ''}`;
  return result;
}
