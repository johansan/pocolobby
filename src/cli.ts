#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import {
  loadConfig,
  readConfig,
  reserveConfig,
  setConfigUrl,
  validateConfig,
  writeConfigExclusive,
} from './config.js';
import {
  BoardAgentsSchema,
  BoardSourceSchema,
  RepoName,
  type BoardAgentLook,
} from './board-model.js';
import { LobbyClient, LobbyClientError } from './client.js';
import { postmarkMailer } from './mail.js';
import {
  commandOnPath,
  launchScript,
  packageRoot,
  pocolobbyVersion,
  stableLaunchPaths,
} from './launch.js';
import { unsupportedNodeMessage } from './node-version.js';
import type { ServerOptions } from './server.js';
import {
  AgentId,
  CancelScheduledSchema,
  Email,
  MIN_PUSH_BYTES,
  MAX_PUSH_BYTES,
  LobbyId,
  NewLobbyId,
  ProvisionSchema,
  RoomId,
  RoomMembersSchema,
  RoomMemberChangesSchema,
  SendSchema,
} from './protocol.js';

/** "a, b," as ["a", "b"]. */
const listOf = (text: string) =>
  text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const HELP = `PocoLobby — a little place for agents to meet.

  pocolobby init --config owner.json [--url http://127.0.0.1:8787]
  pocolobby server --db state.db [--config owner.json] [--host 127.0.0.1] [--port 8787]
  pocolobby agent add NAME --config owner.json --out agent.json [--lobby NAME] [--coordinator] [--role-file role.txt] [--broadcast] [--allow PEER]
  pocolobby agent rotate NAME --config owner.json --out new-agent.json
  pocolobby agent pause|resume|disable|enable|retry|reset-runtime NAME --config owner.json
  pocolobby agents --config owner.json
  pocolobby lobbies --config owner.json
  pocolobby lobby create NAME --config owner.json
  pocolobby lobby display-name NAME ["Display Name"] --config owner.json
  pocolobby rooms --config owner.json [--lobby NAME]
  pocolobby room create NAME --config owner.json [--lobby NAME]
  pocolobby room members NAME --member AGENT --member AGENT --config owner.json [--lobby NAME]
  pocolobby room add|remove NAME --member AGENT --config owner.json [--lobby NAME]
  pocolobby room delete NAME --config owner.json [--lobby NAME]
  pocolobby send NAME "message" --config owner.json [--important] [--request-id ID]
  pocolobby broadcast "message" --config owner.json [--important] [--request-id ID]
  pocolobby send-room ROOM "message" --config owner.json [--lobby NAME] [--important]
  pocolobby schedules NAME --config owner.json [--cancel ID]
  pocolobby inbox NAME --config owner.json [--mode pending|history|reconciliation] [--cursor N] [--limit N]
  pocolobby context NAME --config owner.json
  pocolobby attachments [usage] --config owner.json [--lobby NAME] [--cursor N] [--limit N]
  pocolobby board source set LOBBY ROOM --repo OWNER/NAME [--ref main] --notes PATH [--notes PATH] --config owner.json
  pocolobby board source remove LOBBY ROOM --config owner.json
  pocolobby board agents LOBBY --agent ID=EMOJI[ NAME] [--agent ...] [--hide ID] [--support ID] --config owner.json
  pocolobby board icon set LOBBY ICON.png --config owner.json
  pocolobby board icon remove LOBBY --config owner.json
  pocolobby board status LOBBY --config owner.json
  pocolobby console accounts --config owner.json
  pocolobby console allow|enable EMAIL --config owner.json
  pocolobby console grant EMAIL LOBBY --config owner.json
  pocolobby console revoke EMAIL [LOBBY] --config owner.json
  pocolobby console repos LOBBY list|add|remove [OWNER/NAME] --config owner.json
  pocolobby adapter --config agent.json
  pocolobby mcp-config --config agent.json
  pocolobby check-config --mcp-config agent.mcp.json
  pocolobby statusline --config agent.json [--dry-run]
  pocolobby set-url --config FILE --url https://NEW-ADDRESS
  pocolobby launch-script --mcp-config agent.mcp.json [--session ID] [-- CLAUDE-OPTIONS]
  pocolobby backup --db state.db --out backup.db
  pocolobby recover --db restored.db

Credentials are saved in protected files, never printed. Server may use
POCOLOBBY_ADMIN_TOKEN instead of --config. --allow-remote explicitly permits a
non-loopback HTTP listener behind a TLS proxy. Do not expose cleartext remotely.
--content-file FILE replaces the message argument. Repeat --allow for peer access.
Sends accept --kind request|notice|assignment|report|question and --deliver-at
ISO-TIME (with Z or an offset, at most 30 days ahead). schedules lists an agent's
recurring schedules and undelivered scheduled messages; --cancel ID cancels one.
Owner operations act in the broker's only lobby; with several, name one with --lobby.
room members replaces the whole list; use --agents a,b or repeat --member. --agents ""
clears membership.
room add and room remove change only the named members. room delete removes every
member and holds the room's unseen messages; its history stays.
--coordinator permits room management, never credential issuance or lobby admission.
backup and recover require the broker to be stopped and acquire its database lock.
check-config reports whether a generated MCP file's Node and PocoLobby module exist and
which release the module is, compared with the pocolobby on PATH after resolving symbolic
links, and the broker address the credential file names (never its token). Install and run mcp-config with the same Node and
npm prefix. attachments lists a lobby's attachment metadata; attachments usage shows its
storage use and limits. The owner never downloads attachment content.
set-url points an owner or agent credential file at another address of the same
broker, after checking that the address accepts it; the token is kept and never printed.
A running adapter moves on its next start or /mcp reconnect pocolobby.
launch-script, run from the agent's own Claude conversation in its checkout, writes
./launch-agent: a bash script that resumes this conversation with the PocoLobby channel,
its MCP file, its CLAUDE_CONFIG_DIR and any CLAUDE-OPTIONS (such as --remote-control),
and excludes it from Git. On Windows, Git Bash runs it. It refuses to overwrite one.
A lobby's board lives at https://LOBBY.<POCOLOBBY_BOARD_DOMAIN>/. board source set
reads one room's notes from a GitHub repository: each --notes is a directory (every
*.md directly in it) or a file, and approves that repository for the lobby. board
agents replaces the emoji (and optional names) shown per agent. board icon set gives the
board its own icon (a square PNG, 32 to 1024 pixels, at most 64 KB) in place of PocoLobby's.
lobby display-name sets how the board and the console show a lobby, such as My Team
for my-team; without a display name they show its name.
The lobby owner console lives at POCOLOBBY_CONSOLE_ORIGIN/console (default
https://<board domain>/console); people sign in with a code sent to their email.
console allow lets an address sign in and create up to 3 lobbies; console grant
makes it the owner of an existing lobby (refused when another account owns it);
console revoke EMAIL disables the account everywhere at once, and with a LOBBY
only ends its ownership of that lobby; console enable re-enables a disabled account
without changing what it may do. console repos approves the GitHub repositories a
lobby's owner may read notes from.

The server reads these optional settings from its environment:
  POCOLOBBY_PUSH_BYTES                     push size in bytes (default 32768)
  POCOLOBBY_ATTACHMENTS_DIR                attachment files (default: beside --db)
  POCOLOBBY_ATTACHMENT_MAX_IMAGE_BYTES     per image (default 10485760)
  POCOLOBBY_ATTACHMENT_MAX_TEXT_BYTES      per text document (default 1048576)
  POCOLOBBY_ATTACHMENT_LOBBY_BYTES         per lobby (default 1073741824)
  POCOLOBBY_ATTACHMENT_RETENTION_DAYS      after the last message (default 1)
  POCOLOBBY_ATTACHMENT_GRACE_SECONDS       unsent uploads (default 3600)
  POCOLOBBY_ATTACHMENT_DISK_RESERVE_BYTES  free disk kept for SQLite (default 268435456)
  POCOLOBBY_UPLOAD_INFLIGHT_BYTES          upload bytes received at once (default 33554432)
  POCOLOBBY_BOARD_DOMAIN                   boards at LOBBY.<domain>, such as pocolobby.com (unset: off)
  POCOLOBBY_BOARD_NOTES_SECONDS            how often notes are checked (default 60)
  POCOLOBBY_BOARD_SUMMARY_SECONDS          at most one summary per this (default 600)
  POCOLOBBY_CLIENT_IP_HEADER               trusted client-address header, e.g. fly-client-ip
  GITHUB_TOKEN                             read-only token for the notes repositories
  ANTHROPIC_API_KEY                        the board summarizer's key
  POCOLOBBY_CONSOLE_ORIGIN                 the console's origin (default https://<board domain>)
  POSTMARK_TOKEN                           Postmark server token for sign-in codes
  POCOLOBBY_MAIL_FROM                      sign-in sender, e.g. "PocoLobby <signin@pocolobby.com>"
`;
/** The top-level commands, as the help lists them. */
const COMMANDS = new Set([...HELP.matchAll(/^  pocolobby ([a-z-]+)/gmu)].map((match) => match[1]!));

/**
 * Broker settings from the environment, so the push size and attachment limits can be tuned
 * on the server (fly.toml [env] or secrets) without a code change or a bridge update.
 */
export function serverSettings(env: NodeJS.ProcessEnv): Pick<
  ServerOptions,
  'pushBytes' | 'uploadInflightBytes'
> & {
  storeOptions: NonNullable<ServerOptions['storeOptions']>;
  board: NonNullable<ServerOptions['board']>;
  console: NonNullable<ServerOptions['console']>;
} {
  const integer = (name: string, min: number, max: number): number | undefined => {
    const value = env[name];
    if (value === undefined || value === '') return undefined;
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`${name} must be a whole number.`);
    const parsed = Number(value);
    if (parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}.`);
    return parsed;
  };
  const days = integer('POCOLOBBY_ATTACHMENT_RETENTION_DAYS', 1, 3650);
  const grace = integer('POCOLOBBY_ATTACHMENT_GRACE_SECONDS', 60, 7 * 24 * 3600);
  const directory = env.POCOLOBBY_ATTACHMENTS_DIR;
  if (directory !== undefined && directory !== '' && !isAbsolute(directory))
    throw new Error('POCOLOBBY_ATTACHMENTS_DIR must be an absolute path.');
  const storeOptions = {
    maxImageBytes: integer('POCOLOBBY_ATTACHMENT_MAX_IMAGE_BYTES', 1024, 1024 ** 3),
    maxTextBytes: integer('POCOLOBBY_ATTACHMENT_MAX_TEXT_BYTES', 1024, 1024 ** 3),
    maxLobbyAttachmentBytes: integer('POCOLOBBY_ATTACHMENT_LOBBY_BYTES', 0, 1024 ** 4),
    attachmentDiskReserveBytes: integer('POCOLOBBY_ATTACHMENT_DISK_RESERVE_BYTES', 0, 1024 ** 4),
    attachmentRetentionMs: days === undefined ? undefined : days * 24 * 60 * 60 * 1000,
    attachmentGraceMs: grace === undefined ? undefined : grace * 1000,
    attachmentsDir: directory || undefined,
  };
  const domain = env.POCOLOBBY_BOARD_DOMAIN;
  if (domain && !/^(?=.{1,200}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(domain))
    throw new Error('POCOLOBBY_BOARD_DOMAIN must be a domain name such as pocolobby.com.');
  const ipHeader = env.POCOLOBBY_CLIENT_IP_HEADER;
  if (ipHeader && !/^[A-Za-z0-9-]{1,64}$/u.test(ipHeader))
    throw new Error('POCOLOBBY_CLIENT_IP_HEADER must be a header name such as fly-client-ip.');
  const notes = integer('POCOLOBBY_BOARD_NOTES_SECONDS', 30, 3600);
  const summary = integer('POCOLOBBY_BOARD_SUMMARY_SECONDS', 60, 86_400);
  const board = {
    // Set but empty turns board hosts off.
    domain,
    githubToken: env.GITHUB_TOKEN || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    notesIntervalMs: notes === undefined ? undefined : notes * 1000,
    summaryIntervalMs: summary === undefined ? undefined : summary * 1000,
    clientIpHeader: ipHeader || undefined,
  };
  const defined = <T extends object>(value: T) =>
    Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  const consoleOrigin = env.POCOLOBBY_CONSOLE_ORIGIN;
  if (consoleOrigin && !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/u.test(consoleOrigin))
    throw new Error(
      'POCOLOBBY_CONSOLE_ORIGIN must be an origin such as https://pocolobby.com, without a path.',
    );
  // Sign-in needs both; without them the broker starts anyway and the sign-in page says so.
  const postmark = env.POSTMARK_TOKEN || undefined;
  const from = env.POCOLOBBY_MAIL_FROM || undefined;
  const missing = [
    ...(postmark ? [] : ['POSTMARK_TOKEN']),
    ...(from ? [] : ['POCOLOBBY_MAIL_FROM']),
  ];
  return {
    pushBytes: integer('POCOLOBBY_PUSH_BYTES', MIN_PUSH_BYTES, MAX_PUSH_BYTES),
    uploadInflightBytes: integer('POCOLOBBY_UPLOAD_INFLIGHT_BYTES', 1024, 1024 ** 4),
    storeOptions: defined(storeOptions),
    board: defined(board),
    console: {
      ...(consoleOrigin ? { origin: consoleOrigin } : {}),
      mailer: postmark && from ? postmarkMailer({ token: postmark, from }) : null,
      missing,
    },
  };
}

export interface CliIO {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  stdin?: () => Promise<string>;
}

/** All of standard input, as Claude Code passes a status line its session data. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runCli(args: string[], io: CliIO = {}): Promise<void> {
  const output = io.stdout ?? ((message: string) => process.stdout.write(`${message}\n`));
  const notice = io.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  const env = io.env ?? process.env;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      config: { type: 'string' },
      lobby: { type: 'string' },
      coordinator: { type: 'boolean' },
      agents: { type: 'string' },
      member: { type: 'string', multiple: true },
      url: { type: 'string' },
      db: { type: 'string' },
      out: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'allow-remote': { type: 'boolean' },
      'role-file': { type: 'string' },
      'content-file': { type: 'string' },
      'request-id': { type: 'string' },
      'correlation-id': { type: 'string' },
      kind: { type: 'string' },
      'deliver-at': { type: 'string' },
      cancel: { type: 'string' },
      important: { type: 'boolean' },
      broadcast: { type: 'boolean' },
      allow: { type: 'string', multiple: true },
      mode: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'string' },
      'mcp-config': { type: 'string' },
      session: { type: 'string' },
      repo: { type: 'string' },
      ref: { type: 'string' },
      notes: { type: 'string', multiple: true },
      agent: { type: 'string', multiple: true },
      hide: { type: 'string', multiple: true },
      support: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' },
    },
  });
  const [command, subcommand, ...rest] = positionals;
  if (values.help || !command) {
    output(HELP);
    return;
  }
  const required = (value: string | undefined, label: string): string => {
    if (!value) throw new Error(`${label} is required. See --help.`);
    return value;
  };
  const exact = (count: number) => {
    if (positionals.length !== count)
      throw new Error('Unexpected or missing arguments. See --help.');
  };
  const number = (value: string | undefined, fallback: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!/^\d+$/u.test(value)) throw new Error('Expected an unsigned integer option.');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > max)
      throw new Error('Numeric option is out of range.');
    return parsed;
  };
  const print = (value: unknown) => output(JSON.stringify(value, null, 2));
  if (command === 'init') {
    exact(1);
    const destination = required(values.config, '--config');
    await writeConfigExclusive(destination, {
      url: values.url ?? 'http://127.0.0.1:8787',
      token: randomBytes(32).toString('base64url'),
    });
    output(`Owner credentials saved to ${resolve(destination)}.`);
    return;
  }
  if (command === 'server') {
    exact(1);
    const config = values.config ? await readConfig(values.config) : undefined;
    // The environment wins over --config; an empty variable counts as unset.
    const token = env.POCOLOBBY_ADMIN_TOKEN || config?.token;
    if (!token || token.length < 32 || /[\r\n]/u.test(token)) {
      throw new Error('Set POCOLOBBY_ADMIN_TOKEN (at least 32 characters), or provide --config.');
    }
    const settings = serverSettings(env);
    const { startServer } = await import('./server.js');
    const server = await startServer({
      database: resolve(required(values.db, '--db')),
      adminToken: token,
      host: values.host ?? '127.0.0.1',
      port: number(values.port, 8787, 65535),
      allowRemote: values['allow-remote'] ?? false,
      ...settings,
    });
    output(`PocoLobby listening at ${server.url}.`);
    await new Promise<void>((resolveClose, rejectClose) => {
      let closing = false;
      const stop = () => {
        if (closing) return;
        closing = true;
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        server.close().then(resolveClose, rejectClose);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return;
  }
  if (command === 'backup' || command === 'recover') {
    exact(1);
    const database = resolve(required(values.db, '--db'));
    const { acquireDatabaseLock } = await import('./lock.js');
    const { backupDatabase, LobbyStore } = await import('./store.js');
    // Opening a typo as a new database must not look like a successful recovery, and must not
    // leave the typo's directories behind: check before taking the lock.
    if (!(await stat(database).catch(() => null))?.isFile())
      throw new Error('Database must be an existing regular file.');
    const release = acquireDatabaseLock(database);
    try {
      if (command === 'backup') {
        const destination = resolve(required(values.out, '--out'));
        const handle = await open(destination, 'wx', 0o600);
        await handle.close();
        try {
          await backupDatabase(database, destination);
        } catch (error) {
          await unlink(destination).catch(() => undefined);
          throw error;
        }
        output(`Backup saved to ${destination}. Treat it as sensitive data.`);
      } else {
        const store = new LobbyStore(database);
        try {
          store.enterRecovery();
        } finally {
          store.close();
        }
        output(
          'Recovery mode enabled. Re-establish credentials and reconcile agent state before resuming delivery.',
        );
      }
    } finally {
      release();
    }
    return;
  }
  if (command === 'check-config') {
    exact(1);
    const report = await checkMcpConfig(
      resolve(required(values['mcp-config'], '--mcp-config')),
      env.PATH ?? env.Path,
    );
    print(report);
    if (report.problems.length) throw new Error(report.problems.join(' '));
    return;
  }
  if (command === 'launch-script') {
    const sessionId = values.session ?? env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId)
      throw new Error(
        "Run launch-script in the agent's own Claude conversation, or pass --session ID.",
      );
    const mcpConfig = resolve(required(values['mcp-config'], '--mcp-config'));
    if (!(await stat(mcpConfig)).isFile())
      throw new Error("--mcp-config must name the agent's generated MCP file.");
    const script = launchScript({
      sessionId,
      mcpConfig,
      profile: env.CLAUDE_CONFIG_DIR || undefined,
      flags: positionals.slice(1),
      home: homedir(),
      windows: process.platform === 'win32',
    });
    const destination = resolve('launch-agent');
    await writeFile(destination, script, { mode: 0o755, flag: 'wx' });
    output(`Saved ${destination}: run ./launch-agent to relaunch this conversation.`);
    notice(excludeFromGit(destination));
    return;
  }
  if (!COMMANDS.has(command)) throw new Error(`Unknown command ${command}. See --help.`);
  const { config, identity } = await loadConfig(required(values.config, '--config'));
  if (command === 'set-url') {
    exact(1);
    const moved = validateConfig({ ...config, url: required(values.url, '--url') });
    // The new address must reach this broker and accept this credential before the file changes.
    await new LobbyClient(moved).request('GET', '/v1/agents');
    await setConfigUrl(identity.path, moved.url);
    output(
      `${identity.path} now uses ${moved.url}. A running adapter moves on /mcp reconnect pocolobby.`,
    );
    return;
  }
  if (command === 'statusline') {
    // Claude Code's status line for this agent: plan usage shown here and sent to the board.
    exact(1);
    const { runStatusLine } = await import('./statusline.js');
    output(
      await runStatusLine(config, identity.path, await (io.stdin ?? readStdin)(), {
        dryRun: values['dry-run'] ?? false,
      }),
    );
    return;
  }
  if (command === 'adapter') {
    exact(1);
    if (values.lobby)
      throw new Error(
        'An agent lobby is bound to its credential; --lobby is for owner administration.',
      );
    const { runClaudeAdapter } = await import('./adapters/claude.js');
    // Claude Code gives stdio MCP servers the ID of the conversation that spawned them,
    // including the resumed ID for `claude --resume <session-id>`.
    // The bridge never attaches its own credential file, whatever its name or location.
    await runClaudeAdapter({
      ...config,
      hostSessionId: env.CLAUDE_CODE_SESSION_ID,
      credentialFile: identity,
    });
    return;
  }
  if (command === 'mcp-config') {
    exact(1);
    if (values.lobby)
      throw new Error(
        'An agent lobby is bound to its credential; --lobby is for owner administration.',
      );
    const launch = stableLaunchPaths({
      execPath: process.execPath,
      script: fileURLToPath(import.meta.url),
      version: process.versions.node,
      searchPath: env.PATH ?? env.Path,
    });
    print({
      mcpServers: {
        pocolobby: {
          command: launch.command,
          args: [launch.script, 'adapter', '--config', resolve(values.config!)],
        },
      },
    });
    // Name what Claude will start, so a stale install or another npm prefix shows at once.
    notice(
      `pocolobby: the adapter runs ${launch.command} ${launch.script} (PocoLobby ${pocolobbyVersion(launch.script) ?? 'of unknown version'}).`,
    );
    if (launch.versionPinned)
      notice(
        `pocolobby: these paths name Node ${process.versions.node}'s own directory. Run mcp-config again after upgrading or removing that Node version.`,
      );
    return;
  }
  const client = new LobbyClient(config);
  // Without --lobby the broker takes its only lobby (0.8.3), and asks for one when it has several.
  const lobby = values.lobby === undefined ? undefined : LobbyId.parse(values.lobby);
  const scoped = (path: string): string =>
    lobby === undefined
      ? path
      : `${path}${path.includes('?') ? '&' : '?'}lobby=${encodeURIComponent(lobby)}`;
  if (command === 'lobbies') {
    exact(1);
    print(await client.request('GET', '/v1/admin/lobbies'));
    return;
  }
  if (command === 'lobby') {
    if (subcommand === 'display-name') {
      // Without a display name, the lobby is shown by its name again.
      if (positionals.length !== 3 && positionals.length !== 4)
        throw new Error('Unexpected or missing arguments. See --help.');
      print(
        await client.request('PATCH', `/v1/admin/lobbies/${LobbyId.parse(rest[0])}`, {
          display_name: rest[1] ?? null,
        }),
      );
      return;
    }
    exact(3);
    if (subcommand !== 'create') throw new Error('Unknown lobby operation. See --help.');
    print(
      await client.request('POST', '/v1/admin/lobbies', { lobby_id: NewLobbyId.parse(rest[0]) }),
    );
    return;
  }
  if (command === 'rooms') {
    exact(1);
    print(await client.request('GET', scoped('/v1/admin/rooms')));
    return;
  }
  if (command === 'room') {
    exact(3);
    const room = RoomId.parse(rest[0]);
    if (subcommand === 'create') {
      print(await client.request('POST', scoped('/v1/admin/rooms'), { room_id: room }));
    } else if (subcommand === 'delete') {
      print(await client.request('DELETE', scoped(`/v1/admin/rooms/${room}`)));
    } else if (subcommand === 'add' || subcommand === 'remove') {
      if (values.agents !== undefined && values.member !== undefined)
        throw new Error('Use --agents or repeated --member, not both.');
      const members = values.member ?? listOf(values.agents ?? '');
      print(
        await client.request(
          'PATCH',
          scoped(`/v1/admin/rooms/${room}/members`),
          RoomMemberChangesSchema.parse({ [subcommand]: members }),
        ),
      );
    } else if (subcommand === 'members') {
      if (values.agents !== undefined && values.member !== undefined)
        throw new Error('Use --agents or repeated --member, not both.');
      if (values.agents === undefined && values.member === undefined)
        throw new Error(
          'Provide --agents or repeated --member; use --agents "" to clear membership.',
        );
      const members = values.member ?? listOf(values.agents!);
      print(
        await client.request(
          'PUT',
          scoped(`/v1/admin/rooms/${room}/members`),
          RoomMembersSchema.parse({ members }),
        ),
      );
    } else throw new Error('Unknown room operation. See --help.');
    return;
  }
  if (command === 'agents') {
    exact(1);
    print(await client.request('GET', scoped('/v1/admin/agents')));
    return;
  }
  if (command === 'agent') {
    exact(3);
    const id = AgentId.parse(rest[0]);
    const route = `/v1/admin/agents/${encodeURIComponent(id)}`;
    if (subcommand === 'add' || subcommand === 'rotate') {
      const destination = required(values.out, '--out');
      const input =
        subcommand === 'add'
          ? ProvisionSchema.parse({
              agent_id: id,
              lobby_id: lobby,
              manage_rooms: values.coordinator ?? false,
              role: values['role-file'] ? await readFile(values['role-file'], 'utf8') : '',
              can_broadcast: values.broadcast ?? false,
              allowed_recipients: values.allow ?? null,
            })
          : undefined;
      const reserved = await reserveConfig(destination);
      let remoteSucceeded = false;
      let where = lobby ? `${lobby}/` : '';
      try {
        const result = await client.request<{ token: string; agent?: { lobby_id: string } }>(
          'POST',
          scoped(subcommand === 'add' ? '/v1/admin/agents' : `${route}/rotate`),
          input ?? {},
        );
        remoteSucceeded = true;
        await reserved.write(validateConfig({ url: config.url, token: result.token }));
        if (result.agent) where = `${result.agent.lobby_id}/`;
      } catch (error) {
        await reserved.abort();
        if (remoteSucceeded) {
          throw new Error(
            'Server changed the credential, but its file could not be saved. Use owner agent rotate with a new writable --out path.',
          );
        }
        throw error;
      }
      output(`Agent ${where}${id} credentials saved to ${resolve(destination)}.`);
      return;
    }
    const patches: Record<string, Record<string, boolean>> = {
      pause: { paused: true },
      resume: { paused: false },
      disable: { enabled: false },
      enable: { enabled: true },
    };
    if (subcommand && patches[subcommand]) {
      print(await client.request('PATCH', scoped(route), patches[subcommand]));
    } else if (subcommand === 'retry' || subcommand === 'reset-runtime') {
      print(await client.request('POST', scoped(`${route}/${subcommand}`), {}));
    } else {
      throw new Error('Unknown agent operation. See --help.');
    }
    return;
  }
  if (command === 'send' || command === 'broadcast' || command === 'send-room') {
    const recipient = command === 'send' ? AgentId.parse(subcommand) : '*';
    const messageArgs = command === 'broadcast' ? positionals.slice(1) : rest;
    if (values['content-file'] && messageArgs.length > 0)
      throw new Error('Use a message argument or --content-file, not both.');
    if (!values['content-file'] && messageArgs.length !== 1)
      throw new Error('Provide exactly one quoted message or --content-file.');
    const content = values['content-file']
      ? await readFile(values['content-file'], 'utf8')
      : messageArgs[0];
    const requestId = values['request-id'] ?? randomUUID();
    const input = SendSchema.parse({
      client_request_id: requestId,
      to: recipient,
      priority: values.important ? 'important' : 'info',
      content,
      correlation_id: values['correlation-id'],
      ...(command === 'send-room' ? { room: RoomId.parse(subcommand) } : {}),
      ...(values.kind === undefined ? {} : { kind: values.kind }),
      ...(values['deliver-at'] === undefined ? {} : { deliver_at: values['deliver-at'] }),
    });
    // Show the retry key before the request so an interrupted/unknown outcome is recoverable,
    // on stderr so the result stays pure JSON.
    notice(`Request ID: ${requestId}`);
    print(await client.request('POST', scoped('/v1/messages'), input));
    return;
  }
  if (command === 'schedules') {
    exact(2);
    const id = AgentId.parse(subcommand);
    print(
      values.cancel === undefined
        ? await client.request('GET', scoped(`/v1/admin/agents/${id}/schedules`))
        : await client.request(
            'POST',
            scoped(`/v1/admin/agents/${id}/schedules/cancel`),
            CancelScheduledSchema.parse({ id: values.cancel }),
          ),
    );
    return;
  }
  if (command === 'board') {
    const boardPath = (name: string | undefined, path = '') =>
      `/v1/admin/board${path}?lobby=${encodeURIComponent(LobbyId.parse(name))}`;
    if (subcommand === 'source') {
      exact(5);
      const [action, name, room] = rest;
      const route = boardPath(name, `/sources/${RoomId.parse(room)}`);
      if (action === 'set')
        print(
          await client.request(
            'PUT',
            route,
            BoardSourceSchema.parse({ repo: values.repo, ref: values.ref, notes: values.notes }),
          ),
        );
      else if (action === 'remove') print(await client.request('DELETE', route));
      else throw new Error('Unknown board source operation. See --help.');
      return;
    }
    if (subcommand === 'icon') {
      const [action, name, file] = rest;
      if (action === 'set') {
        exact(5);
        const png = (await readFile(file!)).toString('base64');
        print(await client.request('PUT', boardPath(name, '/icon'), { png }));
      } else if (action === 'remove') {
        exact(4);
        print(await client.request('DELETE', boardPath(name, '/icon')));
      } else throw new Error('Unknown board icon operation. See --help.');
      return;
    }
    exact(3);
    const name = rest[0];
    if (subcommand === 'status') {
      print(await client.request('GET', boardPath(name)));
    } else if (subcommand === 'agents') {
      // The list replaces the roster, so an empty one would erase every name and emoji.
      if (!values.agent?.length && !values.hide?.length && !values.support?.length)
        throw new Error('Give at least one --agent ID=EMOJI or --hide ID.');
      const agents: Record<string, BoardAgentLook> = Object.fromEntries(
        (values.agent ?? []).map((entry) => {
          const match = /^([^=\s]+)=(\S+)(?:\s+(.+))?$/u.exec(entry.trim());
          if (!match) throw new Error('Use --agent ID=EMOJI or --agent "ID=EMOJI Name".');
          return [match[1], { emoji: match[2], ...(match[3] ? { name: match[3].trim() } : {}) }];
        }),
      );
      // A hidden agent stays in the lobby, off the board.
      for (const id of values.hide ?? []) agents[id] = { ...agents[id], hidden: true };
      // A support agent is listed last, on the coordinator's tint.
      for (const id of values.support ?? []) agents[id] = { ...agents[id], support: true };
      print(
        await client.request(
          'PUT',
          boardPath(name, '/agents'),
          BoardAgentsSchema.parse({ agents }),
        ),
      );
    } else throw new Error('Unknown board operation. See --help.');
    return;
  }
  if (command === 'console') {
    const lobbyPath = (name: string | undefined, path: string) =>
      `/v1/admin/console/${path}?lobby=${encodeURIComponent(LobbyId.parse(name))}`;
    if (subcommand === 'accounts') {
      exact(2);
      print(await client.request('GET', '/v1/admin/console/accounts'));
    } else if (subcommand === 'allow' || subcommand === 'enable') {
      exact(3);
      print(
        await client.request('POST', '/v1/admin/console/accounts', {
          email: Email.parse(rest[0]),
          enabled: true,
          ...(subcommand === 'allow' ? { may_create_lobbies: true } : {}),
        }),
      );
    } else if (subcommand === 'grant') {
      exact(4);
      print(
        await client.request('PUT', lobbyPath(rest[1], 'owner'), { email: Email.parse(rest[0]) }),
      );
    } else if (subcommand === 'revoke') {
      if (positionals.length !== 3 && positionals.length !== 4)
        throw new Error('Unexpected or missing arguments. See --help.');
      const email = Email.parse(rest[0]);
      print(
        rest[1] === undefined
          ? await client.request('POST', '/v1/admin/console/accounts', { email, enabled: false })
          : await client.request('POST', lobbyPath(rest[1], 'owner/revoke'), { email }),
      );
    } else if (subcommand === 'repos') {
      const [name, action, repo] = rest;
      if (action === 'list' || action === undefined) {
        exact(action === undefined ? 3 : 4);
        print(await client.request('GET', lobbyPath(name, 'repos')));
      } else if (action === 'add') {
        exact(5);
        print(
          await client.request('POST', lobbyPath(name, 'repos'), { repo: RepoName.parse(repo) }),
        );
      } else if (action === 'remove') {
        exact(5);
        const [owner, title] = RepoName.parse(repo).split('/') as [string, string];
        print(
          await client.request(
            'DELETE',
            lobbyPath(name, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(title)}`),
          ),
        );
      } else throw new Error('Unknown console repos operation. See --help.');
    } else throw new Error('Unknown console operation. See --help.');
    return;
  }
  if (command === 'attachments') {
    if (subcommand !== undefined && subcommand !== 'usage')
      throw new Error('Unknown attachments operation. See --help.');
    exact(subcommand === undefined ? 1 : 2);
    if (subcommand === 'usage') {
      print(await client.request('GET', scoped('/v1/admin/attachments/usage')));
      return;
    }
    const query = new URLSearchParams({ limit: String(number(values.limit, 50, 100)) });
    if (values.cursor !== undefined)
      query.set('cursor', String(number(values.cursor, 0, Number.MAX_SAFE_INTEGER)));
    print(await client.request('GET', scoped(`/v1/admin/attachments?${query}`)));
    return;
  }
  if (command === 'inbox' || command === 'context') {
    exact(2);
    const id = AgentId.parse(subcommand);
    if (command === 'context') {
      print(await client.request('GET', scoped(`/v1/admin/agents/${id}/context`)));
    } else {
      const mode = values.mode ?? 'pending';
      if (!['pending', 'history', 'reconciliation'].includes(mode))
        throw new Error('Unknown inbox mode.');
      const query = new URLSearchParams({ mode, limit: String(number(values.limit, 50, 100)) });
      if (values.cursor !== undefined)
        query.set('cursor', String(number(values.cursor, 0, Number.MAX_SAFE_INTEGER)));
      print(await client.request('GET', scoped(`/v1/admin/agents/${id}/messages?${query}`)));
    }
    return;
  }
  throw new Error('Unknown command. See --help.');
}

export interface ConfigCheck {
  mcp_config: string;
  command: { path: string; exists: boolean; real_path: string | null };
  module: { path: string; exists: boolean; version: string | null; real_path: string | null };
  /** The broker address it names, so an agent can tell which broker it uses; never its token. */
  credential_config: { path: string | null; exists: boolean; broker_url: string | null };
  path_command: {
    path: string;
    module: string | null;
    version: string | null;
    /** The installed package directory after resolving symbolic links. */
    package_root: string | null;
  } | null;
  this_cli: { module: string; version: string | null; package_root: string | null };
  /**
   * Whether the MCP file starts the same installed package as the pocolobby on PATH, compared
   * after resolving symbolic links: a version manager's node/latest and node/26.10.0 are one
   * directory. Null when either is unknown.
   */
  same_install_as_path: boolean | null;
  problems: string[];
}

/**
 * Keep a launcher out of Git through the checkout's own info/exclude, which nobody commits,
 * rather than its .gitignore.
 */
function excludeFromGit(file: string): string {
  let top: string | undefined;
  let exclude: string | undefined;
  try {
    [top, exclude] = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel', '--git-path', 'info/exclude'],
      { cwd: dirname(file), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split(/\r?\n/u);
  } catch {
    /* Not a checkout, or no Git. */
  }
  if (!top || !exclude) return 'pocolobby: this is not a Git checkout, so nothing was excluded.';
  // Git reads the line as a pattern, so a directory such as worker[1] must be escaped.
  const pattern = `/${relative(realpathSync(top), realpathSync(file))
    .split(sep)
    .join('/')
    .replace(/[*?[\\]/gu, '\\$&')}`;
  const path = resolve(dirname(file), exclude);
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    mkdirSync(dirname(path), { recursive: true });
  }
  if (!current.split(/\r?\n/u).includes(pattern))
    appendFileSync(path, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  return `pocolobby: Git ignores ${pattern} through ${path}.`;
}

/**
 * What a generated MCP file will start, without starting it or reading the credential it names.
 * A stale npm prefix, for example after a new Node changed `npm root -g`, shows as a module
 * whose release differs from the `pocolobby` on PATH.
 */
export async function checkMcpConfig(file: string, searchPath?: string): Promise<ConfigCheck> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error('The MCP configuration must be a regular file smaller than 1 MiB.');
  let server: { command?: unknown; args?: unknown } | undefined;
  try {
    server = (
      JSON.parse(await readFile(file, 'utf8')) as {
        mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
      }
    ).mcpServers?.pocolobby;
  } catch {
    throw new Error('The MCP configuration is not valid JSON.');
  }
  if (
    !server ||
    typeof server.command !== 'string' ||
    !Array.isArray(server.args) ||
    !server.args.every((arg) => typeof arg === 'string')
  )
    throw new Error(
      'The MCP configuration has no mcpServers.pocolobby entry with command and args.',
    );
  const args = server.args as string[];
  const exists = async (path: string | undefined) =>
    path !== undefined &&
    isAbsolute(path) &&
    ((await stat(path).catch(() => null))?.isFile() ?? false);
  const command = server.command;
  const module = args[0] ?? '';
  const credential = args[1] === 'adapter' && args[2] === '--config' ? args[3] : undefined;
  const thisModule = fileURLToPath(import.meta.url);
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const report: ConfigCheck = {
    mcp_config: file,
    command: { path: command, exists: await exists(command), real_path: real(command) },
    module: {
      path: module,
      exists: await exists(module),
      version: (await exists(module)) ? pocolobbyVersion(module) : null,
      real_path: real(module),
    },
    credential_config: {
      path: credential ?? null,
      exists: await exists(credential),
      broker_url: null,
    },
    path_command: null,
    this_cli: {
      module: thisModule,
      version: pocolobbyVersion(thisModule),
      package_root: packageRoot(thisModule),
    },
    same_install_as_path: null,
    problems: [],
  };
  const onPath = commandOnPath(searchPath);
  if (onPath)
    report.path_command = {
      ...onPath,
      version: onPath.module ? pocolobbyVersion(onPath.module) : null,
      package_root: onPath.module ? packageRoot(onPath.module) : null,
    };
  const moduleRoot = report.module.exists ? packageRoot(module) : null;
  if (moduleRoot && report.path_command?.package_root)
    report.same_install_as_path = moduleRoot === report.path_command.package_root;
  const problems = report.problems;
  if (!report.command.exists)
    problems.push(`Its command ${command} does not exist, so Claude cannot start the adapter.`);
  if (!report.module.exists) problems.push(`Its module ${module} does not exist.`);
  else if (!report.module.version) problems.push(`Its module ${module} is not part of PocoLobby.`);
  if (args.length !== 4 || credential === undefined)
    problems.push('Its arguments are not "<module> adapter --config <file>".');
  else if (!report.credential_config.exists)
    problems.push(`Its credential configuration ${credential} does not exist.`);
  // The adapter opens its credential without following links, so a link fails there.
  else if ((await lstat(credential).catch(() => null))?.isSymbolicLink())
    problems.push(
      `Its credential configuration ${credential} is a symbolic link; the adapter refuses links. Point the MCP file at the file itself.`,
    );
  else
    try {
      // Read the way the adapter reads it, so what the adapter would refuse shows here.
      report.credential_config.broker_url = (await loadConfig(credential)).config.url;
    } catch (error) {
      problems.push(
        `Its credential configuration ${credential} cannot be used: ${(error as Error).message}`,
      );
    }
  if (
    report.same_install_as_path !== true &&
    report.module.version &&
    report.path_command?.version &&
    report.module.version !== report.path_command.version
  )
    problems.push(
      `It starts PocoLobby ${report.module.version}, but pocolobby on PATH is ${report.path_command.version} (${report.path_command.module}). Install the package and run mcp-config with the same Node and npm prefix, then save the file again.`,
    );
  if (problems.length)
    problems.push('Generate the file again with pocolobby mcp-config from the intended install.');
  return report;
}

export async function main(): Promise<void> {
  // bin.ts checks first; this covers MCP configurations that start this module directly.
  const problem = unsupportedNodeMessage(process.versions.node, process.execPath);
  try {
    if (problem) throw new Error(problem);
    await runCli(process.argv.slice(2));
  } catch (error: unknown) {
    // The broker's reason, and a readable form of an argument the command refused itself.
    const message =
      error instanceof LobbyClientError && error.detail
        ? `${error.message} ${error.detail}`
        : error instanceof ZodError
          ? `invalid arguments: ${error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ')}`
          : error instanceof Error
            ? error.message
            : 'Command failed.';
    process.stderr.write(`pocolobby: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main();
}
