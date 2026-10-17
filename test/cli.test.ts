import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runCli, serverSettings, type ConfigCheck } from '../src/cli.js';
import { readConfig, validateConfig, writeConfigExclusive } from '../src/config.js';
import { MINIMUM_NODE_MAJOR, unsupportedNodeMessage } from '../src/node-version.js';
import { PACKAGE_VERSION } from '../src/protocol.js';
import { fileSymlinks } from './temp.js';

const ownerToken = 'owner-token-'.padEnd(48, 'x');
const agentToken = 'agent-token-'.padEnd(48, 'y');

async function temporary<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-cli-'));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('init creates a protected credential without printing it or overwriting an existing file', async () => {
  await temporary(async (directory) => {
    const config = join(directory, 'owner.json');
    const output: string[] = [];
    await runCli(['init', '--config', config], { stdout: (line) => output.push(line) });
    const saved = await readConfig(config);
    assert.equal(saved.url, 'http://127.0.0.1:8787');
    assert.equal(saved.token.length, 43);
    assert.ok(!output.join('\n').includes(saved.token));
    if (process.platform !== 'win32') assert.equal((await lstat(config)).mode & 0o777, 0o600);
    await assert.rejects(runCli(['init', '--config', config], { stdout: () => undefined }), {
      code: 'EEXIST',
    });
    assert.equal((await readConfig(config)).token, saved.token);
  });
});

test('configuration rejects remote cleartext, unsafe permissions and symlinks', async () => {
  await temporary(async (directory) => {
    const config = join(directory, 'owner.json');
    await assert.rejects(
      writeConfigExclusive(config, { url: 'http://example.com', token: ownerToken }),
      /HTTPS/u,
    );
    await assert.rejects(lstat(config), { code: 'ENOENT' });
    await writeConfigExclusive(config, { url: 'https://lobby.example.com', token: ownerToken });
    if (process.platform !== 'win32') {
      await chmod(config, 0o644);
      await assert.rejects(readConfig(config), /0600/u);
      await chmod(config, 0o600);
      const alias = join(directory, 'alias.json');
      await symlink(config, alias);
      await assert.rejects(readConfig(alias));
    }
  });
});

test('agent provisioning reserves its credential file before mutating the server', async () => {
  await temporary(async (directory) => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${ownerToken}`);
      let body = '';
      for await (const part of req) body += String(part);
      requests.push({ method: req.method!, path: req.url!, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agent: { agent_id: 'backend' }, token: agentToken }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const config = join(directory, 'owner.json');
      const outputFile = join(directory, 'backend.json');
      await writeConfigExclusive(config, {
        url: `http://127.0.0.1:${address.port}`,
        token: ownerToken,
      });
      const output: string[] = [];
      const args = [
        'agent',
        'add',
        'backend',
        '--config',
        config,
        '--out',
        outputFile,
        '--broadcast',
        '--allow',
        'frontend',
      ];
      await runCli(args, { stdout: (line) => output.push(line) });
      assert.equal((await readConfig(outputFile)).token, agentToken);
      assert.deepEqual(requests, [
        {
          method: 'POST',
          // Without --lobby the broker takes its only lobby (0.8.3).
          path: '/v1/admin/agents',
          body: {
            agent_id: 'backend',
            manage_rooms: false,
            role: '',
            can_broadcast: true,
            allowed_recipients: ['frontend'],
          },
        },
      ]);
      assert.ok(!output.join('\n').includes(agentToken));
      await assert.rejects(runCli(args), { code: 'EEXIST' });
      assert.equal(requests.length, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('send preserves caller retry identity and outputs it even when the response is lost', async () => {
  await temporary(async (directory) => {
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer(async (req) => {
      let body = '';
      for await (const part of req) body += String(part);
      requestBody = JSON.parse(body) as Record<string, unknown>;
      req.socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const config = join(directory, 'owner.json');
      await writeConfigExclusive(config, {
        url: `http://127.0.0.1:${address.port}`,
        token: ownerToken,
      });
      const output: string[] = [];
      await assert.rejects(
        runCli(
          [
            'send',
            'backend',
            'Review the change',
            '--important',
            '--request-id',
            'retry-42',
            '--config',
            config,
          ],
          {
            stdout: (line) => output.push(line),
            stderr: (line) => output.push(line),
          },
        ),
      );
      assert.equal(requestBody?.client_request_id, 'retry-42');
      assert.equal(requestBody?.priority, 'important');
      // On stderr, before the request, so it survives a lost response and stdout stays JSON.
      assert.deepEqual(output, ['Request ID: retry-42']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('MCP configuration uses absolute Node and CLI paths without a shell shim or embedded token', async () => {
  await temporary(async (directory) => {
    const config = join(directory, 'backend profile.json');
    await writeConfigExclusive(config, { url: 'https://lobby.example.com', token: agentToken });
    const output: string[] = [];
    const notices: string[] = [];
    await runCli(['mcp-config', '--config', config], {
      stdout: (line) => output.push(line),
      stderr: (line) => notices.push(line),
    });
    const mcp = JSON.parse(output.join('')) as {
      mcpServers: { pocolobby: { command: string; args: string[] } };
    };
    const adapter = mcp.mcpServers.pocolobby;
    // The command may be a stable alias of the running Node (see launch.test.ts), but
    // never a shim: it must resolve to this very executable.
    assert(isAbsolute(adapter.command));
    assert.equal(await realpath(adapter.command), await realpath(process.execPath));
    assert(isAbsolute(adapter.args[0]!));
    // This unit test imports source through tsx. The installed-package smoke
    // test separately verifies dist/cli.js and actually launches this config.
    assert.equal(
      await realpath(adapter.args[0]!),
      await realpath(fileURLToPath(new URL('../src/cli.ts', import.meta.url))),
    );
    assert.deepEqual(adapter.args.slice(1), ['adapter', '--config', config]);
    // It names what Claude will start, and which release that is.
    const version = (
      JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
    assert.equal(
      notices[0],
      `pocolobby: the adapter runs ${adapter.command} ${adapter.args[0]} (PocoLobby ${version}).`,
    );
    for (const notice of notices.slice(1))
      assert.match(notice, /Run mcp-config again after upgrading/u);
    assert.ok(!notices.join('').includes(agentToken));
    assert.ok(!output.join('').includes(agentToken));
    assert.ok((await readFile(config, 'utf8')).includes(agentToken));
  });
});

test('check-config finds a stale install behind a generated MCP file and names its broker, never its token', async () => {
  await temporary(async (directory) => {
    const config = join(directory, 'agent.json');
    await writeConfigExclusive(config, { url: 'https://lobby.example.com', token: agentToken });
    const mcpFile = join(directory, 'agent.mcp.json');
    const generated: string[] = [];
    await runCli(['mcp-config', '--config', config], {
      stdout: (line) => generated.push(line),
      stderr: () => undefined,
    });
    await writeFile(mcpFile, generated.join('\n'));
    // A pocolobby on PATH from this same checkout, as npm links it.
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await symlink(fileURLToPath(new URL('../src/bin.ts', import.meta.url)), join(bin, 'pocolobby'));
    const version = (
      JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
    const check = async (file: string) => {
      const output: string[] = [];
      let failure: Error | undefined;
      await runCli(['check-config', '--mcp-config', file], {
        stdout: (line) => output.push(line),
        env: { PATH: bin },
      }).catch((error: Error) => {
        failure = error;
      });
      assert.ok(!output.join('').includes(agentToken));
      return { report: JSON.parse(output.join('\n')) as ConfigCheck, failure };
    };
    const healthy = await check(mcpFile);
    assert.equal(healthy.failure, undefined);
    assert.deepEqual(
      [
        healthy.report.command.exists,
        healthy.report.module.exists,
        healthy.report.module.version,
        healthy.report.credential_config,
        healthy.report.path_command?.version,
        healthy.report.problems,
      ],
      [
        true,
        true,
        version,
        { path: config, exists: true, broker_url: 'https://lobby.example.com' },
        version,
        [],
      ],
    );

    // Vader's case: the MCP file still starts an older install under another npm prefix.
    const old = join(directory, 'AppData', 'npm', 'node_modules', 'pocolobby');
    await mkdir(join(old, 'dist'), { recursive: true });
    await writeFile(join(old, 'package.json'), '{"name":"pocolobby","version":"0.1.1"}');
    await writeFile(join(old, 'dist', 'cli.js'), '');
    const mcp = JSON.parse(generated.join('\n')) as {
      mcpServers: { pocolobby: { command: string; args: string[] } };
    };
    const staleFile = join(directory, 'stale.mcp.json');
    mcp.mcpServers.pocolobby.args[0] = join(old, 'dist', 'cli.js');
    await writeFile(staleFile, JSON.stringify(mcp));
    const stale = await check(staleFile);
    assert.equal(stale.report.module.version, '0.1.1');
    assert.match(
      stale.failure!.message,
      new RegExp(
        `It starts PocoLobby 0\\.1\\.1, but pocolobby on PATH is ${version.replaceAll('.', '\\.')} .*same Node and npm prefix`,
      ),
    );

    // A removed Node or install cannot start at all.
    mcp.mcpServers.pocolobby.command = join(directory, 'node-v20', 'bin', 'node');
    mcp.mcpServers.pocolobby.args[0] = join(directory, 'missing', 'cli.js');
    await writeFile(staleFile, JSON.stringify(mcp));
    const missing = await check(staleFile);
    assert.deepEqual([missing.report.command.exists, missing.report.module.exists], [false, false]);
    assert.match(missing.failure!.message, /does not exist, so Claude cannot start the adapter/);
    if (process.platform !== 'win32') await chmod(config, 0o600);
  });
});

test('configuration rejects URL paths that could redirect credential-bearing requests', () => {
  for (const url of [
    'https://lobby.example/prefix',
    'https://lobby.example//evil.example',
    'https://lobby.example/%2f%2fevil.example',
  ]) {
    assert.throws(() => validateConfig({ url, token: ownerToken }), /origin/u);
  }
});

test(
  'CLI starts through a Unix symlink as it does through an installed npm bin',
  { skip: process.platform === 'win32' },
  async () => {
    await temporary(async (directory) => {
      const executable = join(directory, 'pocolobby.ts');
      await symlink(resolve('src/bin.ts'), executable);
      const result = spawnSync(process.execPath, ['--import', 'tsx', executable, '--help'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PocoLobby/u);
      assert.match(result.stdout, /agent rotate/u);
    });
  },
);

// Overrides the reported version after tsx has loaded, as an old Node would report it.
const nodeTwenty = `data:text/javascript,Object.defineProperty(process.versions,'node',{value:'20.11.0'})`;

test('the pocolobby command refuses an old Node before loading the CLI', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', nodeTwenty, resolve('src/bin.ts'), '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^pocolobby: PocoLobby needs Node\.js 24 or newer; this is v20\.11\.0 at /u,
  );
  assert.equal(result.stdout, '');
});

test('the minimum Node version matches package.json engines', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    engines: { node: string };
  };
  assert.equal(manifest.engines.node, `>=${MINIMUM_NODE_MAJOR}.0.0`);
  assert.equal(unsupportedNodeMessage(`${MINIMUM_NODE_MAJOR}.0.0`, process.execPath), undefined);
  assert.equal(unsupportedNodeMessage('26.10.0', process.execPath), undefined);
  assert.match(unsupportedNodeMessage('23.11.1', 'node') ?? '', /this is v23\.11\.1 at node\./u);
});

test('the adapter reports the package version, and the lockfile agrees', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
    version: string;
    packages: Record<string, { version: string }>;
  };
  assert.equal(PACKAGE_VERSION, manifest.version);
  assert.deepEqual(
    [lock.version, lock.packages['']!.version],
    [manifest.version, manifest.version],
  );
});

test('owner rotation sends valid JSON to the real broker and saves the replacement token', async () => {
  await temporary(async (directory) => {
    const { startServer } = await import('../src/server.js');
    const server = await startServer({
      database: join(directory, 'state.db'),
      adminToken: ownerToken,
      port: 0,
    });
    try {
      const config = join(directory, 'owner.json');
      const first = join(directory, 'first.json');
      const replacement = join(directory, 'replacement.json');
      await writeConfigExclusive(config, { url: server.url, token: ownerToken });
      await runCli(['lobby', 'create', 'my-team', '--config', config], { stdout: () => {} });
      const output: string[] = [];
      const io = { stdout: (line: string) => output.push(line) };
      await runCli(['agent', 'add', 'backend', '--config', config, '--out', first], io);
      await runCli(['agent', 'rotate', 'backend', '--config', config, '--out', replacement], io);
      const oldToken = (await readConfig(first)).token;
      const newToken = (await readConfig(replacement)).token;
      assert.notEqual(newToken, oldToken);
      assert.ok(!output.join('\n').includes(newToken));
      assert.ok(!output.join('\n').includes(oldToken));
    } finally {
      await server.close();
    }
  });
});

test('offline backup preserves data and refuses an active broker or existing destination', async () => {
  await temporary(async (directory) => {
    const { LobbyStore } = await import('../src/store.js');
    const { acquireDatabaseLock } = await import('../src/lock.js');
    const database = join(directory, 'state.db');
    const backup = join(directory, 'backup.db');
    const store = new LobbyStore(database);
    store.createLobby('my-team');
    store.provision({
      agent_id: 'backend',
      role: 'Keep this role',
      can_broadcast: false,
      allowed_recipients: null,
    });
    store.close();
    const release = acquireDatabaseLock(database);
    try {
      await assert.rejects(runCli(['backup', '--db', database, '--out', backup]), /in use/u);
    } finally {
      release();
    }
    await runCli(['backup', '--db', database, '--out', backup], { stdout: () => undefined });
    await assert.rejects(runCli(['backup', '--db', database, '--out', backup]), { code: 'EEXIST' });
    const restored = new LobbyStore(backup);
    assert.equal(restored.agent('backend').role, 'Keep this role');
    restored.close();
  });
});

test('owner CLI scopes same-named agents and room membership while agent credentials cannot administer', async () => {
  await temporary(async (directory) => {
    const { startServer } = await import('../src/server.js');
    const server = await startServer({
      database: join(directory, 'state.db'),
      adminToken: ownerToken,
      port: 0,
    });
    try {
      const owner = join(directory, 'owner.json');
      const coordinator = join(directory, 'coordinator.json');
      const backend = join(directory, 'backend.json');
      const otherBackend = join(directory, 'other-backend.json');
      await writeConfigExclusive(owner, { url: server.url, token: ownerToken });
      let output: string[] = [];
      const io = { stdout: (line: string) => output.push(line) };
      // With one lobby, owner commands need no --lobby (0.8.3).
      await runCli(['lobby', 'create', 'my-team', '--config', owner], io);
      await runCli(
        ['agent', 'add', 'coordinator', '--coordinator', '--config', owner, '--out', coordinator],
        io,
      );
      await runCli(['agent', 'add', 'backend', '--config', owner, '--out', backend], io);
      // With two, they name one.
      await runCli(['lobby', 'create', 'another', '--config', owner], io);
      await assert.rejects(runCli(['agents', '--config', owner], io), /lobby_required/u);
      await runCli(
        ['agent', 'add', 'backend', '--lobby', 'another', '--config', owner, '--out', otherBackend],
        io,
      );
      await runCli(['room', 'create', 'app', '--lobby', 'my-team', '--config', owner], io);
      await runCli(
        [
          'room',
          'members',
          'app',
          '--member',
          'coordinator',
          '--member',
          'backend',
          '--lobby',
          'my-team',
          '--config',
          owner,
        ],
        io,
      );
      output = [];
      await runCli(['rooms', '--lobby', 'my-team', '--config', owner], io);
      assert.deepEqual(JSON.parse(output[0]!).rooms, [
        { lobby_id: 'my-team', room_id: 'app', members: ['backend', 'coordinator'] },
      ]);
      output = [];
      await runCli(['agents', '--lobby', 'my-team', '--config', owner], io);
      const agents = JSON.parse(output[0]!).agents as {
        agent_id: string;
        lobby_id: string;
        manage_rooms: boolean;
      }[];
      assert.equal(agents.length, 2);
      assert.equal(agents.find((agent) => agent.agent_id === 'coordinator')?.manage_rooms, true);
      output = [];
      await runCli(['agents', '--lobby', 'another', '--config', owner], io);
      assert.deepEqual(
        JSON.parse(output[0]!).agents.map((agent: { agent_id: string; lobby_id: string }) => [
          agent.lobby_id,
          agent.agent_id,
        ]),
        [['another', 'backend']],
      );
      await runCli(
        [
          'send-room',
          'app',
          'Shared app update',
          '--request-id',
          'room-cli-1',
          '--lobby',
          'my-team',
          '--config',
          owner,
        ],
        io,
      );
      output = [];
      await runCli(['inbox', 'backend', '--lobby', 'my-team', '--config', owner], io);
      assert.equal(JSON.parse(output[0]!).items[0].room_id, 'app');
      output = [];
      await runCli(['inbox', 'backend', '--lobby', 'another', '--config', owner], io);
      assert.equal(JSON.parse(output[0]!).items.length, 0);
      await assert.rejects(
        runCli(['lobby', 'create', 'forbidden', '--config', coordinator], io),
        /403/u,
      );
      await assert.rejects(
        runCli(
          [
            'agent',
            'add',
            'intruder',
            '--config',
            coordinator,
            '--out',
            join(directory, 'intruder.json'),
          ],
          io,
        ),
        /403/u,
      );
      await assert.rejects(lstat(join(directory, 'intruder.json')), { code: 'ENOENT' });
      await assert.rejects(
        runCli(['room', 'members', 'app', '--agents', 'backend', '--config', coordinator], io),
        /403/u,
      );
      await assert.rejects(
        runCli(['room', 'members', 'app', '--lobby', 'my-team', '--config', owner], io),
        /Provide/u,
      );
      output = [];
      await runCli(['rooms', '--lobby', 'my-team', '--config', owner], io);
      assert.equal(JSON.parse(output[0]!).rooms[0].members.length, 2);
      await runCli(
        ['room', 'members', 'app', '--agents', '', '--lobby', 'my-team', '--config', owner],
        io,
      );
      output = [];
      await runCli(['rooms', '--lobby', 'my-team', '--config', owner], io);
      assert.equal(JSON.parse(output[0]!).rooms[0].members.length, 0);
      // Adding and removing change only the named members; deleting removes the room.
      output = [];
      await runCli(
        ['room', 'add', 'app', '--member', 'backend', '--lobby', 'my-team', '--config', owner],
        io,
      );
      await runCli(
        ['room', 'add', 'app', '--agents', 'coordinator', '--lobby', 'my-team', '--config', owner],
        io,
      );
      await runCli(
        ['room', 'remove', 'app', '--member', 'backend', '--lobby', 'my-team', '--config', owner],
        io,
      );
      assert.deepEqual(
        output.map((line) => JSON.parse(line).members),
        [['backend'], ['backend', 'coordinator'], ['coordinator']],
      );
      await assert.rejects(
        runCli(['room', 'add', 'app', '--lobby', 'my-team', '--config', owner], io),
        /add or remove/u,
      );
      output = [];
      await runCli(['room', 'delete', 'app', '--lobby', 'my-team', '--config', owner], io);
      assert.deepEqual(JSON.parse(output[0]!).former_members, ['coordinator']);
      output = [];
      await runCli(['rooms', '--lobby', 'my-team', '--config', owner], io);
      assert.deepEqual(JSON.parse(output[0]!).rooms, []);
      await assert.rejects(
        runCli(['room', 'delete', 'app', '--lobby', 'my-team', '--config', owner], io),
        /404/u,
      );
    } finally {
      await server.close();
    }
  });
});

test('agent configuration cannot select a lobby through a file or adapter argument', async () => {
  assert.throws(() =>
    validateConfig({ url: 'https://pocolobby.com', token: agentToken, lobby: 'another' }),
  );
  await temporary(async (directory) => {
    const config = join(directory, 'agent.json');
    await writeConfigExclusive(config, { url: 'https://pocolobby.com', token: agentToken });
    await assert.rejects(
      runCli(['adapter', '--config', config, '--lobby', 'another']),
      /bound to its credential/u,
    );
  });
});

test('owner CLI sends kinds and scheduled messages, and reviews and cancels scheduled items', async () => {
  await temporary(async (directory) => {
    const { startServer } = await import('../src/server.js');
    const server = await startServer({
      database: join(directory, 'state.db'),
      adminToken: ownerToken,
      port: 0,
    });
    try {
      const owner = join(directory, 'owner.json');
      await writeConfigExclusive(owner, { url: server.url, token: ownerToken });
      await runCli(['lobby', 'create', 'my-team', '--config', owner], { stdout: () => {} });
      let output: string[] = [];
      const io = { stdout: (line: string) => output.push(line) };
      await runCli(
        ['agent', 'add', 'vader', '--config', owner, '--out', join(directory, 'vader.json')],
        io,
      );
      output = [];
      const at = new Date(Date.now() + 3_600_000).toISOString();
      await runCli(
        [
          'send',
          'vader',
          'Morning notice',
          '--kind',
          'notice',
          '--deliver-at',
          at,
          '--request-id',
          'cli-later',
          '--config',
          owner,
        ],
        io,
      );
      const sent = JSON.parse(output[0]!);
      // Commands that would wipe or guess are refused before any request.
      await assert.rejects(
        runCli(['board', 'agents', 'my-team', '--config', owner], io),
        /at least one --agent/,
      );
      await assert.rejects(runCli(['frobnicate'], io), /Unknown command frobnicate/);
      assert.deepEqual(
        [
          sent.message.kind,
          sent.message.reply_expected,
          sent.message.deliver_at,
          sent.deliveries[0].delivery_state,
        ],
        ['notice', false, at, 'scheduled'],
      );
      output = [];
      await runCli(['schedules', 'owner', '--config', owner], io);
      assert.deepEqual(
        JSON.parse(output[0]!).messages.map((message: { id: string }) => message.id),
        [sent.message.id],
      );
      output = [];
      await runCli(['schedules', 'owner', '--cancel', sent.message.id, '--config', owner], io);
      assert.equal(JSON.parse(output[0]!).cancelled, 'message');
      output = [];
      await runCli(['schedules', 'vader', '--config', owner], io);
      assert.deepEqual(JSON.parse(output[0]!), { schedules: [], messages: [] });
      await assert.rejects(runCli(['send', 'vader', 'x', '--kind', 'fyi', '--config', owner], io));
      await assert.rejects(
        runCli(['schedules', 'vader', '--cancel', 'not-an-id', '--config', owner], io),
      );
    } finally {
      await server.close();
    }
  });
});

test('the server takes push size, upload budget and attachment limits from its environment', () => {
  const unconfigured = { mailer: null, missing: ['POSTMARK_TOKEN', 'POCOLOBBY_MAIL_FROM'] };
  assert.deepEqual(serverSettings({}), {
    pushBytes: undefined,
    uploadInflightBytes: undefined,
    storeOptions: {},
    board: {},
    console: unconfigured,
  });
  assert.deepEqual(
    serverSettings({
      POCOLOBBY_PUSH_BYTES: '49152',
      POCOLOBBY_UPLOAD_INFLIGHT_BYTES: '67108864',
      POCOLOBBY_ATTACHMENTS_DIR: '/data/attachments',
      POCOLOBBY_ATTACHMENT_MAX_IMAGE_BYTES: '5242880',
      POCOLOBBY_ATTACHMENT_MAX_TEXT_BYTES: '524288',
      POCOLOBBY_ATTACHMENT_LOBBY_BYTES: '536870912',
      POCOLOBBY_ATTACHMENT_RETENTION_DAYS: '14',
      POCOLOBBY_ATTACHMENT_GRACE_SECONDS: '600',
      POCOLOBBY_ATTACHMENT_DISK_RESERVE_BYTES: '0',
    }),
    {
      pushBytes: 49152,
      uploadInflightBytes: 67108864,
      storeOptions: {
        maxImageBytes: 5242880,
        maxTextBytes: 524288,
        maxLobbyAttachmentBytes: 536870912,
        attachmentDiskReserveBytes: 0,
        attachmentRetentionMs: 14 * 24 * 60 * 60 * 1000,
        attachmentGraceMs: 600_000,
        attachmentsDir: '/data/attachments',
      },
      board: {},
      console: unconfigured,
    },
  );
  // The console: its origin, and sign-in mail only with both Postmark settings (0.5.0).
  const configured = serverSettings({
    POCOLOBBY_CONSOLE_ORIGIN: 'https://example.org',
    POSTMARK_TOKEN: 'postmark-test-value',
    POCOLOBBY_MAIL_FROM: 'PocoLobby <signin@example.org>',
  }).console;
  assert.equal(configured.origin, 'https://example.org');
  assert.equal(typeof configured.mailer?.sendSignInCode, 'function');
  assert.deepEqual(configured.missing, []);
  assert.deepEqual(serverSettings({ POSTMARK_TOKEN: 'postmark-test-value' }).console, {
    mailer: null,
    missing: ['POCOLOBBY_MAIL_FROM'],
  });
  assert.throws(
    () => serverSettings({ POCOLOBBY_CONSOLE_ORIGIN: 'https://example.org/console' }),
    /without a path/,
  );
  // Board settings and its two secrets; an empty domain turns board hosts off.
  assert.deepEqual(
    serverSettings({
      POCOLOBBY_BOARD_DOMAIN: 'example.org',
      POCOLOBBY_BOARD_NOTES_SECONDS: '120',
      POCOLOBBY_BOARD_SUMMARY_SECONDS: '900',
      POCOLOBBY_CLIENT_IP_HEADER: 'fly-client-ip',
      GITHUB_TOKEN: 'github-test-value',
      ANTHROPIC_API_KEY: 'anthropic-test-value',
    }).board,
    {
      domain: 'example.org',
      githubToken: 'github-test-value',
      anthropicApiKey: 'anthropic-test-value',
      notesIntervalMs: 120_000,
      summaryIntervalMs: 900_000,
      clientIpHeader: 'fly-client-ip',
    },
  );
  assert.deepEqual(serverSettings({ POCOLOBBY_BOARD_DOMAIN: '' }).board, { domain: '' });
  assert.throws(() => serverSettings({ POCOLOBBY_BOARD_DOMAIN: 'https://x' }), /domain name/);
  assert.throws(() => serverSettings({ POCOLOBBY_BOARD_SUMMARY_SECONDS: '5' }), /between 60/);
  assert.throws(() => serverSettings({ POCOLOBBY_PUSH_BYTES: '100000' }), /between 8192 and 65536/);
  assert.throws(() => serverSettings({ POCOLOBBY_PUSH_BYTES: '32k' }), /whole number/);
  assert.throws(
    () => serverSettings({ POCOLOBBY_ATTACHMENTS_DIR: 'attachments' }),
    /absolute path/,
  );
});

test('owner CLI lists attachment metadata and usage per lobby', async () => {
  await temporary(async (directory) => {
    const { startServer } = await import('../src/server.js');
    const server = await startServer({
      database: join(directory, 'state.db'),
      adminToken: ownerToken,
      port: 0,
    });
    try {
      const owner = join(directory, 'owner.json');
      await writeConfigExclusive(owner, { url: server.url, token: ownerToken });
      await runCli(['lobby', 'create', 'my-team', '--config', owner], { stdout: () => {} });
      const output: string[] = [];
      const io = { stdout: (line: string) => output.push(line) };
      await runCli(['attachments', '--config', owner], io);
      assert.deepEqual(JSON.parse(output.pop()!), { items: [], next_cursor: null });
      await runCli(['attachments', 'usage', '--config', owner, '--lobby', 'my-team'], io);
      const usage = JSON.parse(output.pop()!) as { used_bytes: number; quota_bytes: number };
      assert.deepEqual([usage.used_bytes, usage.quota_bytes], [0, 1024 ** 3]);
      await assert.rejects(runCli(['attachments', 'download', '--config', owner], io), /Unknown/);
    } finally {
      await server.close();
    }
  });
});

test('check-config compares installs after resolving links, as a version manager makes them', async () => {
  if (process.platform === 'win32') return;
  await temporary(async (directory) => {
    // mise keeps node/26.10.0 and links node/latest to it; npm's global bin links into it.
    const versioned = join(directory, 'mise', 'installs', 'node', '26.10.0');
    const install = join(versioned, 'lib', 'node_modules', 'pocolobby');
    await mkdir(join(install, 'dist'), { recursive: true });
    await mkdir(join(versioned, 'bin'), { recursive: true });
    await writeFile(join(install, 'package.json'), '{"name":"pocolobby","version":"0.3.0"}');
    await writeFile(join(install, 'dist', 'cli.js'), '');
    await writeFile(join(install, 'dist', 'bin.js'), '');
    await writeFile(join(versioned, 'bin', 'node'), '');
    await symlink(join(install, 'dist', 'bin.js'), join(versioned, 'bin', 'pocolobby'));
    const latest = join(directory, 'mise', 'installs', 'node', 'latest');
    await symlink(versioned, latest);
    const config = join(directory, 'agent.json');
    await writeConfigExclusive(config, { url: 'https://lobby.example.com', token: agentToken });
    const file = join(directory, 'agent.mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          pocolobby: {
            command: join(latest, 'bin', 'node'),
            args: [
              join(latest, 'lib', 'node_modules', 'pocolobby', 'dist', 'cli.js'),
              'adapter',
              '--config',
              config,
            ],
          },
        },
      }),
    );
    const output: string[] = [];
    await runCli(['check-config', '--mcp-config', file], {
      stdout: (line) => output.push(line),
      env: { PATH: join(latest, 'bin') },
    });
    const report = JSON.parse(output.join('\n')) as ConfigCheck;
    const real = await realpath(install);
    assert.equal(report.module.real_path, join(real, 'dist', 'cli.js'));
    assert.equal(report.path_command!.package_root, real);
    assert.equal(report.same_install_as_path, true);
    assert.deepEqual(report.problems, []);
  });
});

test('set-url moves a credential to a new address only after the address accepts it', async () => {
  await temporary(async (directory) => {
    let accept = true;
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.host}`);
      const ok = accept && req.headers.authorization === `Bearer ${agentToken}`;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(ok ? { agents: [] } : { error: { code: 'unauthorized', message: 'No.' } }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const config = join(directory, 'luke.json');
      await writeConfigExclusive(config, { url: 'https://lobby.example.com', token: agentToken });
      const output: string[] = [];
      const run = (url: string) =>
        runCli(['set-url', '--config', config, '--url', url], {
          stdout: (line) => output.push(line),
        });
      await run(`http://localhost:${port}/`);
      assert.deepEqual(await readConfig(config), {
        url: `http://localhost:${port}`,
        token: agentToken,
      });
      assert.deepEqual(seen, [`GET /v1/agents localhost:${port}`]);
      assert.ok(!output.join('\n').includes(agentToken));
      assert.match(output.join('\n'), /now uses http:\/\/localhost:\d+/u);
      if (process.platform !== 'win32') assert.equal((await lstat(config)).mode & 0o777, 0o600);
      // A refused credential, an unreachable address or a malformed one leaves the file alone.
      accept = false;
      await assert.rejects(run(`http://127.0.0.1:${port}`), /unauthorized|No\./u);
      await assert.rejects(run('https://knock.example.com/v1'), /without a path/u);
      server.close();
      await assert.rejects(run(`http://127.0.0.1:${port}`));
      assert.equal((await readConfig(config)).url, `http://localhost:${port}`);
      assert.deepEqual(await readdir(directory), ['luke.json']);
    } finally {
      server.close();
    }
  });
});

test(
  'launch-script writes a launcher that resumes the conversation, and keeps it out of Git',
  { skip: process.platform === 'win32' && 'the launcher runs under bash' },
  async () => {
    await temporary(async (directory) => {
      const home = await realpath(directory);
      const checkout = join(home, 'app checkout');
      const bin = join(home, 'bin');
      await mkdir(checkout);
      await mkdir(bin);
      execFileSync('git', ['init', '-q'], { cwd: checkout });
      const mcp = join(home, '.pocolobby', 'luke.mcp.json');
      await mkdir(dirname(mcp));
      await writeFile(mcp, '{}');
      // A stand-in for claude that reports where it ran and what it was given.
      await writeFile(
        join(bin, 'claude'),
        '#!/usr/bin/env bash\npwd\necho "profile=${CLAUDE_CONFIG_DIR-unset} mcp=$MCP_PROTOCOL_NEGOTIATION"\nprintf "%s\\n" "$@"\n',
        { mode: 0o755 },
      );
      const session = '0f8fad5b-d9cb-469f-a165-70867728950e';
      const generate = (env: NodeJS.ProcessEnv) =>
        runCli(
          ['launch-script', '--mcp-config', mcp, '--', '--remote-control', '--effort', 'medium'],
          { stdout: () => undefined, stderr: () => undefined, env },
        );
      const previous = process.cwd();
      const previousHome = process.env.HOME;
      process.chdir(checkout);
      process.env.HOME = home;
      try {
        await assert.rejects(generate({}), /own Claude conversation/u);
        await generate({
          CLAUDE_CODE_SESSION_ID: session,
          CLAUDE_CONFIG_DIR: join(home, '.claude-luke'),
        });
        await assert.rejects(generate({ CLAUDE_CODE_SESSION_ID: session }), { code: 'EEXIST' });
      } finally {
        process.chdir(previous);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
      // A default-profile conversation in a nested directory whose name Git would read as a pattern.
      const nested = join(checkout, 'agents', 'worker[1]');
      await mkdir(nested, { recursive: true });
      process.chdir(nested);
      process.env.HOME = home;
      try {
        await generate({ CLAUDE_CODE_SESSION_ID: session });
      } finally {
        process.chdir(previous);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
      const launcher = join(checkout, 'launch-agent');
      assert.equal((await lstat(launcher)).mode & 0o777, 0o755);
      assert.deepEqual(
        (await readFile(join(checkout, '.git', 'info', 'exclude'), 'utf8')).split('\n').slice(-3),
        ['/launch-agent', '/agents/worker\\[1]/launch-agent', ''],
      );
      assert.equal(
        execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
          cwd: checkout,
          encoding: 'utf8',
        }),
        '',
      );
      // Run from a shell that exports another profile, it still resumes in the default one.
      const nestedRun = execFileSync(join(nested, 'launch-agent'), {
        cwd: home,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, '.claude-other'),
        },
      }).split('\n');
      assert.deepEqual(nestedRun.slice(0, 2), [nested, 'profile=unset mcp=legacy']);
      // Run from elsewhere, it still resumes from its checkout with the exact arguments.
      const ran = execFileSync(launcher, {
        cwd: home,
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
      }).split('\n');
      assert.deepEqual(ran.slice(0, -1), [
        checkout,
        `profile=${join(home, '.claude-luke')} mcp=legacy`,
        '--resume',
        session,
        '--remote-control',
        '--effort',
        'medium',
        '--mcp-config',
        mcp,
        '--dangerously-load-development-channels',
        'server:pocolobby',
        '--',
        'Read POCOLOBBY.md in this checkout and follow its startup steps.',
      ]);
    });
  },
);

test('a backup copies the database as it is, also one with a schema the broker refuses', async () => {
  await temporary(async (directory) => {
    const database = join(directory, 'state.db');
    const { LobbyStore } = await import('../src/store.js');
    const { DatabaseSync } = await import('node:sqlite');
    new LobbyStore(database).close();
    // The previous release's schema, which this broker no longer opens.
    const old = new DatabaseSync(database);
    old.exec('DROP INDEX messages_bytes; PRAGMA user_version=9;');
    old.close();
    const out = join(directory, 'backup.db');
    await runCli(['backup', '--db', database, '--out', out], { stdout: () => undefined });
    for (const file of [database, out]) {
      const copy = new DatabaseSync(file, { readOnly: true });
      assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 9, file);
      copy.close();
    }
  });
});

test(
  'check-config reports a credential reached through a link, which the adapter refuses',
  { skip: !fileSymlinks() && 'file symlinks need Developer Mode or an administrator on Windows' },
  async () => {
    await temporary(async (directory) => {
      const config = join(directory, 'agent.json');
      await writeConfigExclusive(config, { url: 'https://lobby.example.com', token: agentToken });
      const generated: string[] = [];
      await runCli(['mcp-config', '--config', config], {
        stdout: (line) => generated.push(line),
        stderr: () => undefined,
      });
      const mcp = JSON.parse(generated.join('\n')) as {
        mcpServers: { pocolobby: { args: string[] } };
      };
      const link = join(directory, 'linked.json');
      await symlink(config, link);
      mcp.mcpServers.pocolobby.args[3] = link;
      const mcpFile = join(directory, 'agent.mcp.json');
      await writeFile(mcpFile, JSON.stringify(mcp));
      await assert.rejects(
        runCli(['check-config', '--mcp-config', mcpFile], { stdout: () => undefined, env: {} }),
        /symbolic link/u,
      );
    });
  },
);
