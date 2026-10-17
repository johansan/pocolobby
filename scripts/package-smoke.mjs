import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'pocolobby-package-'));
const hosts = [];
let server;
let updated;
const packageVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;

/** A digest of every file under a directory, to show an install was left untouched. */
async function treeHash(top) {
  const hash = createHash('sha256');
  const entries = (await readdir(top, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const path of entries) hash.update(path).update(await readFile(path));
  return hash.digest('hex');
}

// npm scripts supply the actual npm CLI path. Use it through Node on Windows,
// where execFile cannot directly run the npm.cmd shell shim.
async function npm(args, options = {}) {
  if (process.env.npm_execpath) {
    return exec(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  if (process.platform === 'win32') {
    throw new Error('Run this package smoke test with npm run test:package on Windows.');
  }
  return exec('npm', args, options);
}

try {
  const packed = await npm(
    ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
    { cwd: root },
  );
  const packResult = JSON.parse(packed.stdout);
  const [{ filename }] = Array.isArray(packResult) ? packResult : Object.values(packResult);
  await npm([
    'install',
    '--prefix',
    directory,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    join(directory, filename),
  ]);
  // The installed command is a version-checking wrapper; MCP configurations start the
  // CLI module directly.
  const bin = join(directory, 'node_modules', 'pocolobby', 'dist', 'bin.js');
  const cliModule = join(directory, 'node_modules', 'pocolobby', 'dist', 'cli.js');
  const cli = (...args) => exec(process.execPath, [bin, ...args], { cwd: directory });
  assert.match((await cli('--help')).stdout, /PocoLobby/);
  assert.match((await exec(process.execPath, [cliModule, '--help'])).stdout, /PocoLobby/);
  if (process.platform !== 'win32') {
    const linkedBin = join(directory, 'node_modules', '.bin', 'pocolobby');
    assert.equal(await realpath(linkedBin), await realpath(bin));
    assert.match(
      (await exec(process.execPath, [linkedBin, '--help'], { cwd: directory })).stdout,
      /PocoLobby/,
    );
  }
  // An old Node must get a clear refusal from the wrapper, not a missing-module error.
  const oldNode = `data:text/javascript,Object.defineProperty(process.versions,'node',{value:'20.11.0'})`;
  await assert.rejects(exec(process.execPath, ['--import', oldNode, bin, '--help']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /PocoLobby needs Node\.js 24 or newer; this is v20\.11\.0/);
    assert.equal(error.stdout, '');
    return true;
  });
  const ownerPath = join(directory, 'owner.json');
  await cli('init', '--config', ownerPath);
  server = spawn(
    process.execPath,
    [bin, 'server', '--config', ownerPath, '--db', join(directory, 'state.db'), '--port', '0'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // The board must not reach GitHub, Anthropic or Postmark from a smoke test, whatever the
      // shell holds.
      env: {
        ...process.env,
        GITHUB_TOKEN: '',
        ANTHROPIC_API_KEY: '',
        POSTMARK_TOKEN: '',
        POCOLOBBY_MAIL_FROM: '',
        POCOLOBBY_CONSOLE_ORIGIN: '',
        POCOLOBBY_BOARD_DOMAIN: 'pocolobby.test',
      },
    },
  );
  server.stderr.resume();
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged broker startup timed out')), 10_000);
    let output = '';
    server.stdout.on('data', (data) => {
      output += data.toString();
      const match = /listening at (http:\/\/[^\s]+)\./.exec(output);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Packaged broker exited: ${code}`));
    });
  });
  const ownerConfig = JSON.parse(await readFile(ownerPath, 'utf8'));
  await writeFile(ownerPath, JSON.stringify({ ...ownerConfig, url }), { mode: 0o600 });

  // 0.4.0 and 0.5.0: the installed package serves its landing page on the API host, the console
  // on its own origin (here without mail, so sign-in says what is missing), the operator's
  // console commands, and a private board that sends a visitor to the console's sign-in.
  const landing = await fetch(`${url}/`);
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-type'), /^text\/html/);
  assert.match(await landing.text(), /A little place for agents to meet/);
  const onHost = (host, path, options = {}) =>
    new Promise((resolveReply, reject) => {
      const target = new URL(url);
      const request = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path,
          method: options.method ?? 'GET',
          headers: { host, ...options.headers },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            resolveReply({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(options.body);
    });
  const signInPage = await onHost('pocolobby.test', '/console/sign-in');
  assert.equal(signInPage.status, 200);
  assert.match(
    signInPage.body,
    /Sign-in is not configured on this server yet: POSTMARK_TOKEN and POCOLOBBY_MAIL_FROM are not set/,
  );
  const consoleCli = async (...args) =>
    JSON.parse((await cli('console', ...args, '--config', ownerPath)).stdout);
  assert.equal((await consoleCli('allow', 'Owner@Example.com')).may_create_lobbies, true);
  // A new broker has no lobby until its owner creates one.
  await cli('lobby', 'create', 'my-team', '--config', ownerPath);
  assert.deepEqual((await consoleCli('grant', 'owner@example.com', 'my-team')).owns, ['my-team']);
  assert.deepEqual((await consoleCli('repos', 'my-team', 'add', 'owner/notes')).repos, [
    'owner/notes',
  ]);
  assert.deepEqual(
    (await consoleCli('accounts')).accounts.map((account) => account.email),
    ['owner@example.com'],
  );
  const boardStatus = JSON.parse(
    (await cli('board', 'status', 'my-team', '--config', ownerPath)).stdout,
  );
  assert.equal(boardStatus.visibility, 'private');
  assert.equal(boardStatus.board_url, 'https://my-team.pocolobby.test/');
  const boardHost = 'my-team.pocolobby.test';
  const privateBoard = await onHost(boardHost, '/');
  assert.equal(privateBoard.status, 303);
  assert.equal(privateBoard.headers.location, 'https://pocolobby.test/console/open/my-team');
  assert.equal(
    (
      await onHost(boardHost, '/v1/admin/agents', {
        headers: { authorization: `Bearer ${ownerConfig.token}` },
      })
    ).status,
    404,
  );
  for (const id of ['alpha', 'beta'])
    await cli(
      'agent',
      'add',
      id,
      '--config',
      ownerPath,
      '--out',
      join(directory, `${id}.json`),
      '--broadcast',
    );

  // Each call starts a new adapter subprocess, as Claude does for each launch or resume.
  async function start(id, conversation) {
    const host = new Client({ name: `package-test-${id}`, version: '1.0.0' });
    hosts.push(host);
    const queue = [];
    const listeners = new Set();
    const listChanges = [];
    host.setNotificationHandler(
      z.object({
        method: z.literal('notifications/claude/channel'),
        params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
      }),
      ({ params }) => {
        queue.push(params);
        for (const listener of listeners) listener();
      },
    );
    host.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanges.push(Date.now());
    });
    // Takes the next event of a type, or the next one a predicate accepts.
    async function next(type) {
      const accepts = typeof type === 'function' ? type : (event) => event.meta.event_type === type;
      return new Promise((resolveEvent, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Missing packaged ${id} ${type} event`));
        }, 10_000);
        function check() {
          const index = queue.findIndex(accepts);
          if (index >= 0) {
            clearTimeout(timer);
            listeners.delete(check);
            resolveEvent(queue.splice(index, 1)[0]);
          }
        }
        listeners.add(check);
        check();
      });
    }
    async function tool(name, args = {}) {
      const result = await host.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `Packaged tool ${name} failed`);
      return JSON.parse(result.content[0].text);
    }
    const configPath = join(directory, `${id}.json`);
    const generated = JSON.parse((await cli('mcp-config', '--config', configPath)).stdout);
    const adapterConfig = generated.mcpServers.pocolobby;
    // A stable alias such as mise's node/26 may replace the versioned path, but it must
    // resolve to the running Node and installed CLI; the launch below uses it as written.
    assert.equal(await realpath(adapterConfig.command), await realpath(process.execPath));
    assert.equal(await realpath(adapterConfig.args[0]), await realpath(cliModule));
    assert.deepEqual(adapterConfig.args.slice(1), ['adapter', '--config', configPath]);
    assert(
      !JSON.stringify(generated).includes(JSON.parse(await readFile(configPath, 'utf8')).token),
    );
    // Each agent has its own home directory: attachments may only come from inside it.
    const home = join(directory, `home-${id}`);
    await mkdir(join(home, 'Pictures'), { recursive: true });
    const transport = new StdioClientTransport({
      ...adapterConfig,
      env: {
        ...getDefaultEnvironment(),
        CLAUDE_CODE_SESSION_ID: conversation,
        HOME: home,
        USERPROFILE: home,
      },
      stderr: 'pipe',
    });
    transport.stderr?.resume();
    await host.connect(transport);
    return { host, tool, next, listChanges, pid: transport.pid, home };
  }
  async function connect(id, conversation = randomUUID()) {
    const session = await start(id, conversation);
    const bootstrap = await session.next('bootstrap');
    const nonce = /probe_nonce ([a-f0-9-]+)/.exec(bootstrap.content)?.[1];
    assert(nonce);
    // The bootstrap points at the current arguments, which a host's tool list may lack.
    assert.match(bootstrap.content, /tool_guide, including attachments/);
    const context = await session.tool('get_context');
    assert.equal(context.runtime_scope, 'conversation');
    assert(context.tool_guide.operations.some((operation) => operation.name === 'send_message'));
    await session.tool('ready', {
      context_revision: context.checkpoint.revision,
      probe_nonce: nonce,
    });
    return { ...session, context };
  }

  const alphaConversation = randomUUID();
  const alpha = await connect('alpha', alphaConversation);
  const beta = await connect('beta');
  const agents = await alpha.tool('list_agents');
  assert.deepEqual(
    agents.agents.map((agent) => agent.agent_id),
    ['alpha', 'beta'],
  );
  const input = {
    client_request_id: 'packaged-two-agent-send',
    to: 'beta',
    priority: 'important',
    content: 'Packaged stdio delivery witness',
  };
  const sent = await alpha.tool('send_message', input);
  const event = await beta.next('inbox');
  // A push is a headline line followed by the JSON payload.
  const [headline, ...payload] = event.content.split('\n');
  // Sent without a kind, so the push claims no reply expectation; the broker wrote the line.
  assert.match(headline, /^PocoLobby IMPORTANT direct message from alpha\. /);
  assert.equal(event.meta.priority, 'important');
  assert.equal(JSON.parse(payload.join('\n')).messages[0].id, sent.message.id);
  const retried = await alpha.tool('send_message', input);
  assert.equal(retried.message.id, sent.message.id);
  assert.equal(retried.duplicate, true);
  await beta.tool('acknowledge_messages', { message_ids: [sent.message.id] });
  // The sender's retry and history report the recipient's seen receipt.
  assert.equal((await alpha.tool('send_message', input)).deliveries[0].delivery_state, 'seen');
  await beta.tool('set_owner_requests', { count: 1, text: 'Look at the packaged smoke test' });
  const listed = await alpha.tool('list_agents');
  const betaListed = listed.agents.find((agent) => agent.agent_id === 'beta');
  assert.equal(betaListed.owner_requests.count, 1);
  assert.equal(typeof betaListed.last_message_at, 'string');
  const context = await beta.tool('get_context');
  assert.equal(context.reconciliation.items[0].id, sent.message.id);
  await beta.tool('save_checkpoint', {
    expected_revision: 0,
    covered_receipt_seq: context.receipt_snapshot,
    content: 'Packaged handoff witness; no external effects.',
  });
  const broadcast = await alpha.tool('broadcast', {
    client_request_id: 'packaged-broadcast',
    priority: 'important',
    content: 'Packaged broadcast witness',
  });
  assert.deepEqual(broadcast.recipients, ['beta']);
  await beta.next('inbox');

  // A note to self, stored now and delivered by the broker at its time.
  const reminder = await alpha.tool('send_message', {
    client_request_id: 'packaged-reminder',
    to: 'alpha',
    kind: 'notice',
    content: 'Packaged scheduled reminder',
    deliver_at: new Date(Date.now() + 1500).toISOString(),
  });
  assert.equal(reminder.deliveries[0].delivery_state, 'scheduled');
  assert.deepEqual(
    (await alpha.tool('list_scheduled')).messages.map((message) => message.id),
    [reminder.message.id],
  );
  const reminded = await alpha.next((event) => event.content.includes(reminder.message.id));
  assert.match(
    reminded.content,
    /^PocoLobby notice from alpha \(no reply expected\): direct message, scheduled for /,
  );
  assert.equal(reminded.meta.kind, 'notice');
  // A read receipt pushed to the sender, which needs no acknowledgment.
  const tracked = await alpha.tool('send_message', {
    client_request_id: 'packaged-receipt',
    to: 'beta',
    kind: 'assignment',
    content: 'Packaged receipt witness',
    notify_when_seen: true,
  });
  await beta.next((event) => event.content.includes(tracked.message.id));
  await beta.tool('acknowledge_messages', { message_ids: [tracked.message.id] });
  const receipt = await alpha.next('receipts');
  assert.match(receipt.content, /^PocoLobby read receipts: beta saw your assignment/);
  assert(receipt.content.includes(tracked.message.id));

  // A real screenshot round trip: alpha's installed bridge reads and uploads a PNG and a report
  // from alpha's home directory; beta's installed bridge returns the PNG as an MCP image block
  // with the same bytes and saves the original into beta's home directory.
  const { encodePng } = await import(pathToFileURL(join(root, 'dist', 'png.js')).href);
  const width = 64;
  const height = 40;
  const screenshot = encodePng({
    width,
    height,
    data: Uint8Array.from({ length: width * height * 4 }, (_, index) =>
      index % 4 === 3 ? 255 : (index * 7 + (index >> 8) * 13) % 256,
    ),
  });
  const screenshotPath = join(alpha.home, 'Pictures', 'after.png');
  await writeFile(screenshotPath, screenshot);
  const notesText = '# Notes\n\nThe login button moved.\n';
  await writeFile(join(alpha.home, 'Pictures', 'notes.md'), notesText);
  const withFiles = {
    client_request_id: 'packaged-screenshot',
    to: 'beta',
    kind: 'report',
    content: 'Packaged screenshot round trip',
    attachments: [screenshotPath, join(alpha.home, 'Pictures', 'notes.md')],
  };
  const attached = await alpha.tool('send_message', withFiles);
  assert.deepEqual(
    attached.message.attachments.map((item) => [item.filename, item.mime_type, item.size]),
    [
      ['after.png', 'image/png', screenshot.length],
      ['notes.md', 'text/markdown', Buffer.byteLength(notesText)],
    ],
  );
  assert.equal((await alpha.tool('send_message', withFiles)).duplicate, true);
  const pushed = await beta.next((event) => event.content.includes(attached.message.id));
  assert.match(pushed.content, /with 2 attachments: after\.png, notes\.md/);
  const image = await beta.host.callTool({
    name: 'get_attachment',
    arguments: {
      id: attached.message.attachments[0].id,
      save_to: join(beta.home, 'Pictures'),
    },
  });
  assert.notEqual(image.isError, true, image.content[0]?.text);
  assert.equal(image.content[0].type, 'image');
  assert.equal(image.content[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.content[0].data, 'base64'), screenshot);
  assert.deepEqual(await readFile(join(beta.home, 'Pictures', 'after.png')), screenshot);
  const notes = await beta.host.callTool({
    name: 'get_attachment',
    arguments: { id: attached.message.attachments[1].id },
  });
  assert.equal(notes.content[1].text, notesText);
  // 0.3.1: the document's heading outline, and filing it into a folder that does not exist yet
  // without returning its contents.
  const outline = await beta.host.callTool({
    name: 'get_attachment',
    arguments: { id: attached.message.attachments[1].id, headings: true },
  });
  assert.equal(outline.content[1].text, `offset 0 (${notesText.length} chars): # Notes`);
  const evidence = join(beta.home, 'Dropbox', 'MDP', 'evidence');
  const filed = await beta.host.callTool({
    name: 'get_attachment',
    arguments: { id: attached.message.attachments[1].id, save_to: evidence, save_only: true },
  });
  assert.equal(filed.content.length, 1, filed.content[0]?.text);
  assert.match(filed.content[0].text, /Created the directory and saved the original/);
  assert.equal(await readFile(join(evidence, 'notes.md'), 'utf8'), notesText);
  // A path outside the rules is refused by the installed bridge, and nothing is sent.
  const refusal = await alpha.host.callTool({
    name: 'send_message',
    arguments: { ...withFiles, client_request_id: 'packaged-refused', attachments: [ownerPath] },
  });
  assert.equal(refusal.isError, true);
  assert.match(refusal.content[0].text, /outside your home directory.*Nothing was sent/);
  // So is alpha's own credential under a harmless name in its home: the installed CLI hands
  // the adapter the identity of the configuration file it read.
  const ownCredential = join(alpha.home, 'Pictures', 'agent.json');
  await link(join(directory, 'alpha.json'), ownCredential);
  const own = await alpha.host.callTool({
    name: 'send_message',
    arguments: { ...withFiles, client_request_id: 'packaged-own', attachments: [ownCredential] },
  });
  assert.equal(own.isError, true);
  assert.match(own.content[0].text, /own PocoLobby credential file\. Nothing was sent/);

  // Restart alpha's adapter subprocess within the same conversation: it reclaims its
  // runtime without an owner reset. A different conversation is still rejected.
  await alpha.host.close();
  const resumed = await connect('alpha', alphaConversation);
  assert.equal(resumed.context.runtime_id, alpha.context.runtime_id);
  assert.equal((await resumed.tool('send_message', input)).duplicate, true);
  const intruder = await start('alpha', randomUUID());
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await intruder.host.callTool({ name: 'list_agents', arguments: {} });
    if (result.isError && /another conversation/.test(result.content[0].text)) break;
    assert(Date.now() < deadline, 'A different conversation must not take over the identity');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }

  // The generated MCP file names this install, and check-config agrees without the token.
  const mcpFile = join(directory, 'beta.mcp.json');
  await writeFile(
    mcpFile,
    (await cli('mcp-config', '--config', join(directory, 'beta.json'))).stdout,
  );
  const checked = await exec(process.execPath, [bin, 'check-config', '--mcp-config', mcpFile], {
    cwd: directory,
    env: { ...process.env, PATH: join(directory, 'node_modules', '.bin') },
  });
  const report = JSON.parse(checked.stdout);
  assert.deepEqual(
    [report.module.version, report.path_command?.version, report.problems],
    [packageVersion, packageVersion, []],
  );
  assert(
    !checked.stdout.includes(
      JSON.parse(await readFile(join(directory, 'beta.json'), 'utf8')).token,
    ),
  );

  // A broker-only release reaches the unchanged installed bridge. Beta's adapter process and
  // the installed files stay as they are; only the broker restarts with a new tool and a new
  // optional argument on an existing one, from this checkout's build.
  const installed = await treeHash(join(directory, 'node_modules', 'pocolobby'));
  const betaPid = beta.pid;
  const toolsBefore = (await beta.host.listTools()).tools.map((tool) => tool.name);
  assert(!toolsBefore.includes('count_pending'));
  await new Promise((resolveExit) => {
    server.once('exit', resolveExit);
    server.kill('SIGTERM');
  });
  const { startServer } = await import(pathToFileURL(join(root, 'dist', 'server.js')).href);
  const { defaultTools, defineTool } = await import(
    pathToFileURL(join(root, 'dist', 'catalog.js')).href
  );
  const laterRelease = defaultTools().map((tool) =>
    tool.name === 'list_agents'
      ? defineTool({
          ...tool,
          input: z.object({ waiting: z.boolean().optional() }).strict(),
          run: async (context, { waiting }) => {
            const listed = await context.call('GET', '/v1/agents');
            return waiting
              ? { agents: listed.agents.filter((agent) => agent.owner_requests !== null) }
              : listed;
          },
        })
      : tool,
  );
  laterRelease.push(
    defineTool({
      name: 'count_pending',
      description: 'Count your unacknowledged messages without reading them.',
      input: z.object({}).strict(),
      run: async (context) => ({
        pending: (await context.call('GET', '/v1/messages?mode=pending&limit=100')).items.length,
      }),
    }),
  );
  updated = await startServer({
    database: join(directory, 'state.db'),
    adminToken: ownerConfig.token,
    port: Number(new URL(url).port),
    tools: laterRelease,
  });
  const changeDeadline = Date.now() + 15_000;
  while (!beta.listChanges.length) {
    assert(Date.now() < changeDeadline, 'The running bridge must hear of the new tools');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  const toolsAfter = (await beta.host.listTools()).tools;
  assert(toolsAfter.some((tool) => tool.name === 'count_pending'));
  assert.deepEqual(
    Object.keys(toolsAfter.find((tool) => tool.name === 'list_agents').inputSchema.properties),
    ['waiting'],
  );
  const waiting = await beta.tool('list_agents', { waiting: true });
  assert.deepEqual(
    waiting.agents.map((agent) => agent.agent_id),
    ['beta'],
  );
  // Messaging and Channel delivery continue through the updated broker.
  const after = await resumed.tool('send_message', {
    client_request_id: 'packaged-after-broker-update',
    to: 'beta',
    content: 'Delivered by the updated broker',
  });
  await beta.next((event) => event.content.includes(after.message.id));
  const unread = await beta.tool('get_messages', { mode: 'pending' });
  assert(unread.items.some((message) => message.id === after.message.id));
  assert.deepEqual(await beta.tool('count_pending'), { pending: unread.items.length });
  assert.equal(beta.pid, betaPid);
  assert.equal(await treeHash(join(directory, 'node_modules', 'pocolobby')), installed);
  console.log(
    'PASS: npm package install, executable CLI with Node version check, the landing page, the console sign-in page and the operator console commands, a private board sending a visitor to the console sign-in, generated portable MCP configs for two real stdio adapters, check-config, discovery, push with priority attributes, send deduplication, receipts, sender delivery state, owner requests and last message times, checkpoint, broadcast, a scheduled note to self, a pushed read receipt, a screenshot and a document attached by one installed bridge and opened by the other as an MCP image block and text, a heading outline and save_only into a new folder, refusal of a bridge credential file under a harmless name, same-conversation adapter restart without owner reset, and a broker-only catalog change (a new tool and a new optional argument) reaching the unchanged installed bridge process. Simulated MCP host; no model calls.',
  );
} finally {
  await Promise.allSettled(hosts.map((host) => host.close()));
  await updated?.close();
  if (server && server.exitCode === null) {
    await new Promise((resolveExit) => {
      server.once('exit', resolveExit);
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
      timer.unref();
    });
  }
  await rm(directory, { recursive: true, force: true });
}
