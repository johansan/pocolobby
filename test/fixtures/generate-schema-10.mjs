// Regenerates schema-10-0.5.3.sql from the real 0.5.3 broker storage code (b119c89), so the test
// that opens a schema 10 database starts from one that the deployed migrations and 0.5.3 actually
// wrote: the 0.4.0 fixture, upgraded by 0.5.3, plus a console account with a session and a
// pending code, a board viewer with a board session and an open hand-off, an approved repository,
// summary settings and a summary, an archived room and a deleted lobby, a new agent with a claimed
// runtime, sends that are seen, pending and scheduled, a pending read receipt, a daily schedule
// with an attachment, an attachment on a message, a pending upload, and the audit rows those
// leave.
//
//   git archive --output /tmp/v053.tar b119c89 src package.json test/fixtures/schema-8-0.4.0.sql
//   mkdir /tmp/v053 && tar -xf /tmp/v053.tar -C /tmp/v053 && ln -s "$PWD/node_modules" /tmp/v053/
//   node --import tsx test/fixtures/generate-schema-10.mjs /tmp/v053 test/fixtures/schema-10-0.5.3.sql
//
// The 0.4.0 fixture is read from the 0.5.3 checkout, since later commits no longer have it. The
// fixture's tokens are the throwaway test values of the 0.1.2 fixture, and its sign-in key and
// session tokens are throwaways too. Attachment content files are not part of the dump.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error('Usage: generate-schema-10.mjs <0.5.3 checkout> <out.sql>');
const { LobbyStore } = await import(pathToFileURL(resolve(root, 'src/store.ts')).href);
const { SignInKeys, tokenHash } = await import(pathToFileURL(resolve(root, 'src/auth.ts')).href);
const directory = mkdtempSync(join(tmpdir(), 'pocolobby-schema-10-'));
const path = join(directory, 'state.db');
const legacy = new DatabaseSync(path);
legacy.exec(readFileSync(resolve(root, 'test/fixtures/schema-8-0.4.0.sql'), 'utf8'));
legacy.close();

// The fixtures' agents are in 0.5.3's built-in default lobby. The dump renames it my-team, a
// name of no deployment: the rename touches lobby columns, principal prefixes, column defaults
// and repository names, which no fingerprint or content hash covers.
const { DEFAULT_LOBBY: LOBBY } = await import(pathToFileURL(resolve(root, 'src/protocol.ts')).href);
let now = Date.parse('2026-10-16T08:00:00.000Z');
const store = new LobbyStore(path, {
  now: () => (now += 1000),
  infoDelayMs: 0,
  attachmentsDir: join(directory, 'attachments'),
});
const incarnation = store.incarnation;
const vader = { runtime_id: '00000000-0000-4000-8000-000000000005', generation: 1, incarnation };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The console: the owner signs in; a viewer opens the private board; a code waits unused.
const keys = new SignInKeys('k'.repeat(43));
const owner = store.grantLobby('owner@example.com', LOBBY).account_id;
const ownerKey = keys.emailKey('owner@example.com');
store.beginSignIn('owner@example.com', ownerKey, keys.codeMac(ownerKey, '111111'));
store.finishSignIn(
  'owner@example.com',
  ownerKey,
  keys.codeMac(ownerKey, '111111'),
  tokenHash('c'.repeat(43)),
);
store.addBoardViewer({ account_id: owner }, LOBBY, 'viewer@example.com');
const viewer = store
  .accounts()
  .find((account) => account.email === 'viewer@example.com').account_id;
store.createHandoff(viewer, LOBBY, tokenHash('h'.repeat(43)));
store.consumeHandoff(LOBBY, tokenHash('h'.repeat(43)), tokenHash('b'.repeat(43)));
store.createHandoff(owner, LOBBY, tokenHash('o'.repeat(43)));
const viewerKey = keys.emailKey('viewer@example.com');
store.beginSignIn('viewer@example.com', viewerKey, keys.codeMac(viewerKey, '222222'));
store.approveRepo(LOBBY, 'johansan/pocolobby');
store.setSummarySettings({ account_id: owner }, LOBBY, {
  model: 'claude-sonnet-5-5',
  effort: 'medium',
});
store.saveBoardSummary({
  lobby_id: LOBBY,
  input_hash: 'fixture-053',
  sources: [{ room_id: 'app', repo: `johansan/${LOBBY}`, commit_sha: 'c'.repeat(40) }],
  model: 'claude-sonnet-5-5',
  usage: {
    input_tokens: 20000,
    output_tokens: 1800,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1200,
  },
  cost_usd: 0.087,
  summary: {
    verdict: {
      runway: 'ok',
      headline: 'Padmé joins the app room.',
      sentence: 'Two tasks are queued.',
      tell_coordinator: 'nothing',
    },
    waiting: [],
    agents: [{ agent_id: 'padme', now: 'Plan the release', waits_on_johan: null, ready: null }],
    pipeline: [],
  },
  error: null,
});
store.createRoom('owner', 'night-shift', LOBBY);
store.archiveRoom({ account_id: owner }, 'night-shift', LOBBY);
store.createLobby('scratch');
store.deleteLobby('owner', 'scratch', 'scratch');

// A new agent with a claimed runtime, in the app room.
store.provision({ agent_id: 'padme', role: 'padme role', can_broadcast: false });
const claimed = store.claimRuntime('padme', '00000000-0000-4000-8000-000000000006');
store.ready('padme', claimed, { context_revision: 0, probe_nonce: claimed.probe_nonce });
const padme = { runtime_id: claimed.runtime_id, generation: claimed.generation, incarnation };
store.changeRoomMembers('vader', 'app', { add: ['padme'] });
store.setStatus('padme', padme, { state: 'working', text: 'Release plan' });

// Seen with a read receipt still to push, pending after a host write, and pending.
const assignment = store.send('vader', {
  client_request_id: 'fixture-053-assignment',
  to: 'padme',
  kind: 'assignment',
  content: 'Plan the 0.6.0 release',
  notify_when_seen: true,
});
const pushed = store.nextNotification('padme', padme);
for (const type of ['adapter_received', 'notification_attempted'])
  store.recordTransport('padme', padme, { type, notification_id: pushed.notification_id });
store.acknowledge('padme', padme, [assignment.message.id]);
store.checkpoint('padme', padme, {
  expected_revision: 0,
  content: 'Release plan started.',
  covered_receipt_seq: 1,
  acknowledge_message_ids: [],
});
store.send('vader', {
  client_request_id: 'fixture-053-room',
  to: '*',
  room: 'app',
  kind: 'notice',
  content: 'Padmé joins the app room',
});
const notice = store.nextNotification('padme', padme);
for (const type of ['adapter_received', 'notification_attempted'])
  store.recordTransport('padme', padme, { type, notification_id: notice.notification_id });
store.send('luke', {
  client_request_id: 'fixture-053-pending',
  to: 'padme',
  kind: 'question',
  content: 'Which day is the release?',
  options: ['Monday', 'Tuesday'],
});

// A scheduled note two days ahead, and a daily schedule carrying an attachment.
store.send('vader', {
  client_request_id: 'fixture-053-scheduled',
  to: 'luke',
  kind: 'notice',
  content: 'Release day',
  deliver_at: '2026-10-18T08:00:00.000Z',
});
const frame = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000020806', 'hex');
store.uploadAttachment('vader', vader, sha(frame), frame);
store.createSchedule('vader', vader, {
  client_request_id: 'fixture-053-daily',
  to: 'padme',
  kind: 'notice',
  content: 'Daily frame',
  attachments: [
    { sha256: sha(frame), filename: 'daily.png', mime_type: 'image/png', size: frame.length },
  ],
  repeat: { time_zone: 'Europe/Stockholm', times: ['06:41'], weekdays: ['mon', 'wed', 'fri'] },
});

// An attachment on a message, and an upload no send has used yet.
const plan = Buffer.from('# Release plan\n- Tag 0.6.0\n');
store.uploadAttachment('padme', padme, sha(plan), plan);
store.send('padme', {
  client_request_id: 'fixture-053-attachment',
  to: 'vader',
  kind: 'report',
  content: 'Release plan attached',
  attachments: [
    { sha256: sha(plan), filename: 'plan.md', mime_type: 'text/markdown', size: plan.length },
  ],
});
const draft = Buffer.from('# Draft\n');
store.uploadAttachment('padme', padme, sha(draft), draft);
store.close();

const db = new DatabaseSync(path);
db.prepare('UPDATE agents SET token_hash=? WHERE agent_id=?').run(
  sha(`fixture-token-padme`.padEnd(40, '0')),
  `${LOBBY}/padme`,
);
const version = db.prepare('PRAGMA user_version').get().user_version;
db.exec('PRAGMA journal_mode=DELETE');
db.close();
if (version !== 10) throw new Error(`Expected schema 10 from 0.5.3, found ${version}`);
// node:sqlite refuses writable_schema; AUTOINCREMENT tables create sqlite_sequence anyway.
const dump = execFileSync('sqlite3', [path, '.dump'], { encoding: 'utf8' })
  .split('\n')
  .filter(
    (line) =>
      !/^PRAGMA writable_schema=/.test(line) &&
      !/^CREATE TABLE IF NOT EXISTS sqlite_sequence/.test(line),
  )
  .join('\n')
  .replaceAll(LOBBY, 'my-team');
writeFileSync(
  output,
  `-- Written by package 0.5.3 (commit b119c89) through test/fixtures/generate-schema-10.mjs,\n-- starting from schema-8-0.4.0.sql, its default lobby renamed my-team. Do not edit by hand.\n${dump}PRAGMA user_version=10;\n`,
);
rmSync(directory, { recursive: true, force: true });
