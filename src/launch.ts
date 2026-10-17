import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, win32 } from 'node:path';

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** The PocoLobby release a module belongs to, from its package's package.json. */
export function pocolobbyVersion(modulePath: string): string | null {
  let directory = dirname(modulePath);
  for (let depth = 0; depth < 4; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === 'pocolobby' && typeof manifest.version === 'string')
        return manifest.version;
      if (manifest.name !== undefined) return null;
    } catch {
      /* No manifest here; look in the parent. */
    }
    if (dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  return null;
}

/**
 * The installed PocoLobby package directory a module belongs to, after resolving symbolic links,
 * so that two paths into one install compare equal: a version manager's node/latest and
 * node/26.10.0 are the same directory.
 */
export function packageRoot(modulePath: string): string | null {
  let directory: string;
  try {
    directory = dirname(realpathSync(modulePath));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 4; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (manifest.name === 'pocolobby') return directory;
      if (manifest.name !== undefined) return null;
    } catch {
      /* No manifest here; look in the parent. */
    }
    if (dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  return null;
}

/**
 * The `pocolobby` a shell finds on this PATH, and the module it starts. npm links a POSIX
 * command to the package's bin module; on Windows it writes shims next to node_modules in the
 * prefix, which the version of `npm root -g` decides.
 */
export function commandOnPath(
  searchPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { path: string; module: string | null } | null {
  const names =
    platform === 'win32' ? ['pocolobby.cmd', 'pocolobby.ps1', 'pocolobby'] : ['pocolobby'];
  for (const directory of (searchPath ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (!isFile(candidate)) continue;
      const target = real(candidate);
      if (target && target !== candidate && /\.(c|m)?(j|t)s$/u.test(target))
        return { path: candidate, module: target };
      // A global prefix keeps node_modules beside its shims; a local one has them in .bin.
      const shimmed =
        basename(directory) === '.bin'
          ? join(dirname(directory), 'pocolobby', 'dist', 'bin.js')
          : join(directory, 'node_modules', 'pocolobby', 'dist', 'bin.js');
      return { path: candidate, module: isFile(shimmed) ? shimmed : null };
    }
  }
  return null;
}

export interface LaunchInput {
  /** The running Node executable, normally process.execPath. */
  execPath: string;
  /** The running CLI module. */
  script: string;
  /** The running Node version without a leading "v", normally process.versions.node. */
  version: string;
  /** The PATH value of the environment generating the configuration. */
  searchPath?: string | undefined;
}

export interface LaunchPaths {
  command: string;
  script: string;
  /** A path still names this exact Node version's directory and breaks when it is removed. */
  versionPinned: boolean;
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function same(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Version managers and Homebrew run Node from a directory named after its exact version,
// which disappears on upgrade. Prefer a stable symlink to the same executable: first a
// symlink on the user's PATH, then a major-version alias such as mise's `node/26`. Both
// must resolve to the running files, so a version-manager shim is never chosen.
export function stableLaunchPaths({
  execPath,
  script,
  version,
  searchPath,
}: LaunchInput): LaunchPaths {
  const realNode = real(execPath) ?? execPath;
  const versionNames = new Set([version, `v${version}`]);
  const command = pathAlias() ?? majorAlias() ?? execPath;
  const realScript = real(script) ?? script;
  const mappedScript = followAlias();
  // Also matches unpacked archives such as node-v24.11.0-win-x64.
  const versionPart = new RegExp(`(^|[^\\d.])v?${version.replaceAll('.', '\\.')}($|[^\\d.])`, 'u');
  const pinned = (path: string) => path.split(/[\\/]/u).some((part) => versionPart.test(part));
  return {
    command,
    script: mappedScript ?? script,
    versionPinned: pinned(command) || pinned(mappedScript ?? script),
  };

  function pathAlias(): string | undefined {
    for (const directory of (searchPath ?? '').split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      const candidate = join(directory, basename(execPath));
      if (!same(candidate, realNode) && same(real(candidate), realNode)) return candidate;
    }
    return undefined;
  }

  function majorAlias(): string | undefined {
    const major = version.split('.')[0]!;
    let directory = dirname(realNode);
    while (!versionNames.has(basename(directory))) {
      if (dirname(directory) === directory) return undefined;
      directory = dirname(directory);
    }
    for (const alias of [major, `v${major}`]) {
      const candidate = join(dirname(directory), alias);
      if (same(real(candidate), directory)) return join(candidate, relative(directory, realNode));
    }
    return undefined;
  }

  // A package installed inside the versioned Node directory (a global install under mise
  // or nvm) moves with it. Reach it through the same alias as the executable.
  function followAlias(): string | undefined {
    let stableRoot = command;
    let realRoot = realNode;
    while (
      basename(stableRoot) === basename(realRoot) &&
      dirname(stableRoot) !== stableRoot &&
      dirname(realRoot) !== realRoot
    ) {
      stableRoot = dirname(stableRoot);
      realRoot = dirname(realRoot);
    }
    if (same(stableRoot, realRoot)) return undefined;
    const inside = relative(realRoot, realScript);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return undefined;
    const candidate = join(stableRoot, inside);
    return same(real(candidate), realScript) ? candidate : undefined;
  }
}

export interface LaunchScriptInput {
  /** The conversation's local ID, which `claude --resume` takes. */
  sessionId: string;
  /** The agent's generated MCP configuration, an absolute path. */
  mcpConfig: string;
  /** The agent's own Claude profile folder (CLAUDE_CONFIG_DIR), if it has one. */
  profile?: string;
  /** Further Claude options, such as --remote-control or --effort medium. */
  flags: string[];
  home: string;
  /** Windows, where Git Bash runs the script and claude.exe needs Windows paths. */
  windows: boolean;
}

/** A word bash passes through unchanged, quoted only when it needs to be. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./=:,@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A path for the script: under the home directory it is written from $HOME, so the script
 * reads the same for every user, and on Windows it goes through cygpath for claude.exe.
 */
function shellPath(path: string, home: string, windows: boolean): string {
  const paths = windows ? win32 : posix;
  const inside = paths.relative(home, path);
  if (!inside || inside.startsWith('..') || paths.isAbsolute(inside)) return shellWord(path);
  const fromHome = `"$HOME/${inside
    .split(paths.sep)
    .join('/')
    .replace(/["$`\\]/gu, '\\$&')}"`;
  return windows ? `"$(cygpath -w ${fromHome})"` : fromHome;
}

/**
 * The `launch-agent` script (0.5.2): it resumes the agent's conversation from its checkout with
 * the PocoLobby channel, so the owner relaunches any agent the same way. It holds no credential.
 */
export function launchScript(input: LaunchScriptInput): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.sessionId))
    throw new Error("The session ID must be the conversation's local ID, a UUID.");
  const flags: string[][] = [];
  for (const flag of input.flags) {
    if (flag.startsWith('-') || !flags.length) flags.push([flag]);
    else flags.at(-1)!.push(flag);
  }
  return [
    '#!/usr/bin/env bash',
    "# Relaunches this checkout's PocoLobby agent: the same Claude conversation, with the PocoLobby",
    '# channel. Run it as ./launch-agent from anywhere. `pocolobby launch-script` wrote it; to change',
    "# it, delete it and run that again in the conversation. SESSION_ID is the conversation's local",
    '# ID (echo "$CLAUDE_CODE_SESSION_ID" in its shell). No credential lives here: the MCP config',
    '# names the credential file by its path.',
    'set -euo pipefail',
    '',
    `SESSION_ID="${input.sessionId}"`,
    '',
    'cd "$(dirname "${BASH_SOURCE[0]}")"',
    // The conversation lives in this profile, whatever the shell that runs the script exports.
    input.profile
      ? `export CLAUDE_CONFIG_DIR=${shellPath(input.profile, input.home, input.windows)}`
      : 'unset CLAUDE_CONFIG_DIR',
    'export MCP_PROTOCOL_NEGOTIATION=legacy',
    'exec claude --resume "$SESSION_ID" \\',
    ...flags.map((group) => `  ${group.map(shellWord).join(' ')} \\`),
    `  --mcp-config ${shellPath(input.mcpConfig, input.home, input.windows)} \\`,
    '  --dangerously-load-development-channels server:pocolobby \\',
    '  -- "Read POCOLOBBY.md in this checkout and follow its startup steps."',
    '',
  ].join('\n');
}
