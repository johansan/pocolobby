import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface LobbyConfig {
  url: string;
  token: string;
}

export function validateConfig(input: unknown): LobbyConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Configuration must contain url and token.');
  }
  const data = input as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => key !== 'url' && key !== 'token') ||
    typeof data.url !== 'string' ||
    typeof data.token !== 'string' ||
    !/^[A-Za-z0-9_-]{32,512}$/u.test(data.token)
  ) {
    throw new Error('Configuration must contain a URL and a token of 32–512 URL-safe characters.');
  }
  let url: URL;
  try {
    url = new URL(data.url);
  } catch {
    throw new Error('Configuration URL is invalid.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'Use an HTTPS origin, or loopback HTTP, without a path, credentials, query, or fragment.',
    );
  }
  return { url: url.toString().replace(/\/$/u, ''), token: data.token };
}

/**
 * Which file a configuration came from: its resolved path, device and inode. The bridge refuses
 * to attach that file under any name or link.
 */
export interface ConfigIdentity {
  path: string;
  dev: number;
  ino: number;
}

export async function readConfig(path: string): Promise<LobbyConfig> {
  return (await loadConfig(path)).config;
}

/** The configuration and the identity of the file it was read from. */
export async function loadConfig(
  path: string,
): Promise<{ config: LobbyConfig; identity: ConfigIdentity }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) {
      throw new Error('Configuration must be a regular file smaller than 64 KiB.');
    }
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o077) !== 0) {
        throw new Error('Configuration contains credentials; restrict its permissions to 0600.');
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error('Configuration must be owned by the current user.');
      }
    }
    let value: unknown;
    try {
      value = JSON.parse(await handle.readFile('utf8'));
    } catch {
      throw new Error('Configuration is not valid JSON.');
    }
    return {
      config: validateConfig(value),
      identity: { path: await realpath(path), dev: stat.dev, ino: stat.ino },
    };
  } finally {
    await handle.close();
  }
}

/** Reserve before provisioning/rotating remotely so an existing file cannot lose a new token. */
export async function reserveConfig(path: string): Promise<{
  write: (config: LobbyConfig) => Promise<void>;
  abort: () => Promise<void>;
}> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const reserved = await handle.stat();
  let closed = false;
  let committed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  return {
    async write(config) {
      if (closed) throw new Error('Credential destination is already closed.');
      const validated = validateConfig(config);
      try {
        await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
        await handle.sync();
        committed = true;
      } finally {
        await close();
      }
    },
    async abort() {
      await close();
      if (committed) return;
      const current = await lstat(destination).catch(() => null);
      if (current?.ino === reserved.ino && current.dev === reserved.dev) {
        await unlink(destination);
      }
    },
  };
}

export async function writeConfigExclusive(path: string, config: LobbyConfig): Promise<void> {
  const reserved = await reserveConfig(path);
  try {
    await reserved.write(config);
  } catch (error) {
    await reserved.abort();
    throw error;
  }
}

/**
 * Point a credential file at another address of the same broker (0.5.2), keeping its token and
 * permissions. The replacement is written beside it and renamed over it, so a crash leaves one
 * whole file or the other.
 */
export async function setConfigUrl(path: string, url: string): Promise<LobbyConfig> {
  const { config } = await loadConfig(path);
  const updated = validateConfig({ ...config, url });
  const destination = resolve(path);
  const replacement = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(
    replacement,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    try {
      await handle.writeFile(`${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(replacement, destination);
  } catch (error) {
    await unlink(replacement).catch(() => undefined);
    throw error;
  }
  return updated;
}
