import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import test from 'node:test';
import { commandOnPath, launchScript, pocolobbyVersion, stableLaunchPaths } from '../src/launch.js';

async function temporary<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-launch-'));
  try {
    // process.execPath is already resolved, so compare against resolved fixtures too.
    return await fn(await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function file(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '');
  return path;
}

// A directory alias such as mise's `node/26 -> ./26.10.0`. Windows uses a junction,
// which needs no symlink privilege but requires an absolute target.
async function alias(target: string, path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  if (process.platform === 'win32') await symlink(target, path, 'junction');
  else await symlink(relative(dirname(path), target), path);
}

const node = process.platform === 'win32' ? 'node.exe' : 'node';

async function install(root: string, version: string) {
  return {
    execPath: await file(join(root, version, 'bin', node)),
    script: await file(join(root, version, 'lib/node_modules/pocolobby/dist/cli.js')),
  };
}

test('MCP launch paths follow a major-version alias on PATH across a Node upgrade', async () => {
  await temporary(async (directory) => {
    const installs = join(directory, 'mise/installs/node');
    const running = await install(installs, '26.10.0');
    await alias(join(installs, '26.10.0'), join(installs, '26'));
    const launch = stableLaunchPaths({
      ...running,
      version: '26.10.0',
      searchPath: [join(installs, '26.10.0/bin'), join(installs, '26/bin')].join(delimiter),
    });
    assert.deepEqual(launch, {
      command: join(installs, '26/bin', node),
      script: join(installs, '26/lib/node_modules/pocolobby/dist/cli.js'),
      versionPinned: false,
    });

    // The version manager installs 26.11.0, moves its alias, and removes 26.10.0. Once
    // PocoLobby is reinstalled under the new Node, the same configuration starts it.
    const upgraded = await install(installs, '26.11.0');
    await alias(join(installs, '26.11.0'), join(installs, '26'));
    await rm(join(installs, '26.10.0'), { recursive: true });
    assert.equal(await realpath(launch.command), upgraded.execPath);
    assert.equal(await realpath(launch.script), upgraded.script);
  });
});

test('MCP launch paths skip a shim on PATH and use the sibling major alias', async () => {
  await temporary(async (directory) => {
    const versions = join(directory, 'versions');
    const running = await install(versions, 'v26.10.0');
    await alias(join(versions, 'v26.10.0'), join(versions, 'v26'));
    // A shim is a different executable that picks a Node at launch; never embed it.
    const shims = dirname(await file(join(directory, 'shims', node)));
    const launch = stableLaunchPaths({
      ...running,
      version: '26.10.0',
      searchPath: ['relative/bin', '', shims].join(delimiter),
    });
    assert.equal(launch.command, join(versions, 'v26/bin', node));
    assert.equal(launch.script, join(versions, 'v26/lib/node_modules/pocolobby/dist/cli.js'));
    assert.equal(launch.versionPinned, false);
  });
});

test(
  'MCP launch paths use a Homebrew-style PATH symlink and keep a shared package path',
  { skip: process.platform === 'win32' && 'file symlinks need a privilege on Windows' },
  async () => {
    await temporary(async (directory) => {
      const execPath = await file(join(directory, 'Cellar/node/26.10.0/bin/node'));
      await mkdir(join(directory, 'bin'));
      await symlink('../Cellar/node/26.10.0/bin/node', join(directory, 'bin/node'));
      const script = await file(join(directory, 'lib/node_modules/pocolobby/dist/cli.js'));
      const launch = stableLaunchPaths({
        execPath,
        script,
        version: '26.10.0',
        searchPath: join(directory, 'bin'),
      });
      assert.deepEqual(launch, {
        command: join(directory, 'bin/node'),
        script,
        versionPinned: false,
      });
    });
  },
);

test('MCP launch paths fall back to the running files and report a version-pinned path', async () => {
  await temporary(async (directory) => {
    const pinned = await install(join(directory, 'nvm/versions/node'), 'v26.10.0');
    assert.deepEqual(
      stableLaunchPaths({
        ...pinned,
        version: '26.10.0',
        searchPath: dirname(pinned.execPath),
      }),
      { command: pinned.execPath, script: pinned.script, versionPinned: true },
    );

    // An unpacked Node.js archive keeps its versioned folder name.
    const archive = await file(join(directory, 'node-v26.10.0-win-x64', node));
    const shared = await file(join(directory, 'npm/node_modules/pocolobby/dist/cli.js'));
    assert.deepEqual(stableLaunchPaths({ execPath: archive, script: shared, version: '26.10.0' }), {
      command: archive,
      script: shared,
      versionPinned: true,
    });

    // An installer's fixed location and a separate package prefix survive upgrades as is.
    const execPath = await file(join(directory, 'nodejs', node));
    const script = await file(join(directory, 'prefix/node_modules/pocolobby/dist/cli.js'));
    assert.deepEqual(stableLaunchPaths({ execPath, script, version: '26.10.0' }), {
      command: execPath,
      script,
      versionPinned: false,
    });
  });
});

test('the pocolobby on PATH is traced to its module and release, including npm Windows shims', async () => {
  await temporary(async (directory) => {
    // npm on Windows: shims in the prefix, the package under its node_modules.
    const prefix = join(directory, 'AppData', 'Roaming', 'npm');
    await file(join(prefix, 'pocolobby.cmd'));
    const shimmed = await file(join(prefix, 'node_modules', 'pocolobby', 'dist', 'bin.js'));
    await writeFile(
      join(prefix, 'node_modules', 'pocolobby', 'package.json'),
      '{"name":"pocolobby","version":"0.1.1"}',
    );
    const found = commandOnPath(`${join(directory, 'empty')};${prefix}`, 'win32');
    assert.deepEqual(found, { path: join(prefix, 'pocolobby.cmd'), module: shimmed });
    assert.equal(pocolobbyVersion(found!.module!), '0.1.1');
    // npm on macOS and Linux: a symlink to the bin module.
    const global = join(directory, 'lib', 'node_modules', 'pocolobby');
    const module = await file(join(global, 'dist', 'bin.js'));
    await writeFile(join(global, 'package.json'), '{"name":"pocolobby","version":"0.2.0"}');
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await symlink(module, join(bin, 'pocolobby'));
    const posix = commandOnPath(bin, 'linux');
    assert.equal(posix?.path, join(bin, 'pocolobby'));
    assert.equal(await realpath(posix!.module!), await realpath(module));
    assert.equal(pocolobbyVersion(posix!.module!), '0.2.0');
    // Another package's manifest stops the search.
    const other = await file(join(directory, 'other', 'dist', 'cli.js'));
    await writeFile(join(directory, 'other', 'package.json'), '{"name":"something-else"}');
    assert.equal(pocolobbyVersion(other), null);
    assert.equal(commandOnPath(join(directory, 'empty'), 'linux'), null);
    // npm install --prefix on Windows: shims in node_modules/.bin.
    const local = join(directory, 'local', 'node_modules');
    await file(join(local, '.bin', 'pocolobby.cmd'));
    const localModule = await file(join(local, 'pocolobby', 'dist', 'bin.js'));
    assert.equal(commandOnPath(join(local, '.bin'), 'win32')?.module, localModule);
  });
});

const session = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('a launcher resumes the conversation with the channel, its MCP file and its profile', () => {
  const script = launchScript({
    sessionId: session,
    mcpConfig: '/Users/gonk/.pocolobby/gonk.mcp.json',
    profile: '/Users/gonk/.claude-gonk',
    flags: ['--remote-control', '--permission-mode', 'bypassPermissions', '--effort', 'medium'],
    home: '/Users/gonk',
    windows: false,
  });
  const lines = script.split('\n');
  assert.equal(lines[0], '#!/usr/bin/env bash');
  assert.ok(lines.includes(`SESSION_ID="${session}"`));
  assert.ok(lines.includes('cd "$(dirname "${BASH_SOURCE[0]}")"'));
  assert.ok(lines.includes('export CLAUDE_CONFIG_DIR="$HOME/.claude-gonk"'));
  assert.ok(lines.includes('export MCP_PROTOCOL_NEGOTIATION=legacy'));
  assert.deepEqual(lines.slice(lines.indexOf('exec claude --resume "$SESSION_ID" \\') + 1, -1), [
    '  --remote-control \\',
    '  --permission-mode bypassPermissions \\',
    '  --effort medium \\',
    '  --mcp-config "$HOME/.pocolobby/gonk.mcp.json" \\',
    '  --dangerously-load-development-channels server:pocolobby \\',
    '  -- "Read POCOLOBBY.md in this checkout and follow its startup steps."',
  ]);
  // An agent in the default profile stays there, whatever the owner's shell exports.
  const plain = launchScript({
    sessionId: session,
    mcpConfig: '/Users/gonk/.pocolobby/gonk.mcp.json',
    flags: [],
    home: '/Users/gonk',
    windows: false,
  }).split('\n');
  assert.ok(plain.includes('unset CLAUDE_CONFIG_DIR'));
  assert.ok(!plain.some((line) => line.includes('CLAUDE_CONFIG_DIR=')));
});

test('a launcher quotes paths and options literally, and hands Windows paths to claude.exe', () => {
  const posix = launchScript({
    sessionId: session,
    mcpConfig: "/srv/agents/it's $HOME/a.mcp.json",
    flags: ['--append-system-prompt', 'Say "hi" `now` $USER'],
    home: '/home/luke',
    windows: false,
  });
  assert.match(posix, /--mcp-config '\/srv\/agents\/it'\\''s \$HOME\/a\.mcp\.json' \\/u);
  assert.match(posix, /--append-system-prompt 'Say "hi" `now` \$USER' \\/u);
  const windows = launchScript({
    sessionId: session,
    mcpConfig: 'C:\\Users\\vader\\.pocolobby\\vader.mcp.json',
    flags: [],
    home: 'C:\\Users\\vader',
    windows: true,
  });
  assert.match(
    windows,
    /--mcp-config "\$\(cygpath -w "\$HOME\/\.pocolobby\/vader\.mcp\.json"\)" \\/u,
  );
  assert.throws(
    () =>
      launchScript({
        sessionId: 'not-a-session"; rm -rf ~',
        mcpConfig: '/x.mcp.json',
        flags: [],
        home: '/',
        windows: false,
      }),
    /UUID/u,
  );
});
