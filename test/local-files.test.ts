import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  LocalFileRefusal,
  pathViolation,
  readLocalAttachment,
  saveDirectory,
  writeAttachmentFile,
} from '../src/local-files.js';
import { encodePng } from '../src/png.js';

const png = encodePng({ width: 4, height: 3, data: new Uint8Array(4 * 3 * 4).fill(200) });

async function home(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pocolobby-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'home');
  await mkdir(join(user, 'screens'), { recursive: true });
  await mkdir(join(user, '.ssh'), { recursive: true });
  await mkdir(join(user, 'notes'), { recursive: true });
  await writeFile(join(user, 'screens', 'before.png'), png);
  await writeFile(join(user, 'notes', 'report.md'), '# Report\n\nFindings: å, ö, 漢字.\n');
  await writeFile(join(root, 'outside.png'), png);
  await writeFile(join(user, '.ssh', 'id_ed25519.png'), png);
  await writeFile(join(user, '.ssh', 'shot.png'), png);
  return { root, user };
}
const refused = async (path: unknown, user: string, pattern: RegExp) =>
  await assert.rejects(readLocalAttachment(path, { home: user }), (error: unknown) => {
    assert(error instanceof LocalFileRefusal, String(error));
    assert.match(error.message, pattern);
    assert.match(error.message, /Nothing was sent\.$/);
    return true;
  });

test('allowed images and text documents are described by their bytes and SHA-256', async (t) => {
  const { user } = await home(t);
  const image = await readLocalAttachment(join(user, 'screens', 'before.png'), { home: user });
  assert.deepEqual(image.descriptor, {
    sha256: createHash('sha256').update(png).digest('hex'),
    filename: 'before.png',
    mime_type: 'image/png',
    size: png.length,
  });
  const text = await readLocalAttachment(join(user, 'notes', 'report.md'), { home: user });
  assert.equal(text.descriptor.mime_type, 'text/markdown');
  // A JPEG saved under a .png name is attached as what its bytes are.
  await writeFile(join(user, 'screens', 'photo.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]));
  assert.equal(
    (await readLocalAttachment(join(user, 'screens', 'photo.png'), { home: user })).descriptor
      .mime_type,
    'image/jpeg',
  );
  for (const [name, mime] of [
    ['data.csv', 'text/csv'],
    ['data.json', 'application/json'],
    ['run.log', 'text/plain'],
    ['notes.txt', 'text/plain'],
  ]) {
    await writeFile(join(user, 'notes', name!), 'a,b\n1,2\n');
    assert.equal(
      (await readLocalAttachment(join(user, 'notes', name!), { home: user })).descriptor.mime_type,
      mime,
    );
  }
});

test('every path rule refuses with its reason', async (t) => {
  const { root, user } = await home(t);
  // Not an absolute path, or not a path at all.
  await refused('screens/before.png', user, /give an absolute path/);
  await refused(42, user, /give an absolute path/);
  // Outside the home directory, including through ..
  await refused(join(root, 'outside.png'), user, /outside your home directory/);
  await refused(join(user, 'screens', '..', '..', 'outside.png'), user, /outside your home/);
  await refused(user, user, /outside your home directory/);
  // Dotfiles and anything under a dot directory.
  await refused(join(user, '.ssh', 'id_ed25519.png'), user, /dot directory/);
  await writeFile(join(user, '.hidden.png'), png);
  await refused(join(user, '.hidden.png'), user, /dotfile/);
  await refused(join(user, '.pocolobby', 'owner.json'), user, /dot directory/);
  await refused(join(user, '.aws', 'credentials.txt'), user, /dot directory/);
  await refused(join(user, 'repo', '.claude', 'worktrees', 'a', 'shot.png'), user, /dot dir/);
  await refused(join(user, 'repo', '.env.local'), user, /dotfile/);
  // Named like credentials, whatever the extension.
  for (const name of [
    'server.pem',
    'api-key.txt',
    'KEYS.md',
    'id_rsa.txt',
    'my-secret.md',
    'aws-credentials.json',
    'password.txt',
    'cert.p12',
    'cert.pfx',
    'server.key',
    'private_key.txt',
    'ssh key.md',
    'signing-keys.json',
    'release.keystore.txt',
  ]) {
    await writeFile(join(user, 'notes', name), 'x');
    await refused(join(user, 'notes', name), user, /looks like a credential/);
  }
  // Everyday names with "key" in them are evidence, not credentials.
  for (const name of ['keyframe-panel-1120x680.png', 'key-light.png', 'monkey.png', 'keyed.png']) {
    await writeFile(join(user, 'screens', name), png);
    assert.equal(
      (await readLocalAttachment(join(user, 'screens', name), { home: user })).descriptor.filename,
      name,
    );
  }
  // A private key is refused by its content, whatever its name.
  await writeFile(
    join(user, 'notes', 'notes.md'),
    '# Deploy\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n',
  );
  await refused(join(user, 'notes', 'notes.md'), user, /contains a private key/);
  // So are PGP key blocks and OAuth token files such as Google's token.json.
  await writeFile(
    join(user, 'notes', 'backup.md'),
    '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n',
  );
  await refused(join(user, 'notes', 'backup.md'), user, /contains a private key/);
  await writeFile(
    join(user, 'notes', 'token.json'),
    '{"token": "x", "refresh_token": "1//0g", "client_id": "a"}',
  );
  await refused(join(user, 'notes', 'token.json'), user, /access or refresh token/);
  // Symbolic links to elsewhere: outside home, into a dot directory, or to another directory.
  await symlink(join(root, 'outside.png'), join(user, 'screens', 'out.png'));
  await refused(join(user, 'screens', 'out.png'), user, /symbolic link to elsewhere/);
  await symlink(join(user, '.ssh', 'shot.png'), join(user, 'screens', 'innocent.png'));
  await refused(join(user, 'screens', 'innocent.png'), user, /symbolic link to elsewhere/);
  await symlink(join(user, 'screens', 'before.png'), join(user, 'notes', 'elsewhere.png'));
  await refused(join(user, 'notes', 'elsewhere.png'), user, /symbolic link to elsewhere/);
  // A directory link that resolves into a dot directory is refused too.
  await symlink(join(user, '.ssh'), join(user, 'linked'));
  await refused(join(user, 'linked', 'shot.png'), user, /resolves to .*dot directory/);
  // A link beside its target, and a linked directory that stays allowed, are accepted.
  await symlink(join(user, 'screens', 'before.png'), join(user, 'screens', 'latest.png'));
  assert.equal(
    (await readLocalAttachment(join(user, 'screens', 'latest.png'), { home: user })).descriptor
      .filename,
    'latest.png',
  );
  await symlink(join(user, 'screens'), join(user, 'Dropbox'));
  assert.ok(await readLocalAttachment(join(user, 'Dropbox', 'before.png'), { home: user }));
  // Types: only the listed extensions, and contents that match them.
  await writeFile(join(user, 'notes', 'paper.pdf'), '%PDF-1.7');
  await refused(join(user, 'notes', 'paper.pdf'), user, /only png, jpg, jpeg, gif and webp/);
  // Where a file of another type goes instead, in the evidence field's words.
  await writeFile(join(user, 'notes', 'model.glb'), 'glTF');
  await refused(
    join(user, 'notes', 'model.glb'),
    user,
    /can be attached\. For other files, put a logical location each machine resolves itself, such as dropbox:MDP\/reports\/run-42, in the evidence field\. Nothing was sent\.$/,
  );
  await writeFile(join(user, 'notes', 'README'), 'text');
  await refused(join(user, 'notes', 'README'), user, /only png/);
  await writeFile(join(user, 'notes', 'fake.png'), 'not an image');
  await refused(join(user, 'notes', 'fake.png'), user, /contents are not PNG, JPEG, GIF or WebP/);
  await writeFile(join(user, 'notes', 'binary.txt'), Buffer.from([0xc3, 0x28, 0x00]));
  await refused(join(user, 'notes', 'binary.txt'), user, /not UTF-8 text/);
  await writeFile(join(user, 'notes', 'image.md'), png);
  await refused(join(user, 'notes', 'image.md'), user, /not UTF-8 text/);
  // Missing, empty, and not a regular file.
  await refused(join(user, 'notes', 'missing.md'), user, /does not exist/);
  await writeFile(join(user, 'notes', 'empty.md'), '');
  await refused(join(user, 'notes', 'empty.md'), user, /empty/);
  await mkdir(join(user, 'folder.png'));
  await refused(join(user, 'folder.png'), user, /not a regular file/);
});

test('the own credential file and any PocoLobby configuration are refused, whatever the name', async (t) => {
  const { user } = await home(t);
  // A supported, harmlessly named location: no dot directory, no credential-like name.
  await mkdir(join(user, 'PocoLobby'));
  const path = join(user, 'PocoLobby', 'agent.json');
  const token = 'T'.repeat(43);
  await writeFile(path, `${JSON.stringify({ url: 'https://lobby.example', token })}\n`, {
    mode: 0o600,
  });
  const { identity } = await loadConfig(path);
  const options = { home: user, credentialFile: identity };
  const own = async (candidate: string) =>
    await assert.rejects(readLocalAttachment(candidate, options), (error: unknown) => {
      assert(error instanceof LocalFileRefusal, String(error));
      assert.match(
        error.message,
        /this bridge's own PocoLobby credential file\. Nothing was sent\.$/,
      );
      assert(!error.message.includes(token));
      return true;
    });
  await own(path);
  // A link beside it and a hard link elsewhere resolve to the same file.
  await symlink(path, join(user, 'PocoLobby', 'current.json'));
  await own(join(user, 'PocoLobby', 'current.json'));
  await link(path, join(user, 'notes', 'settings.json'));
  await own(join(user, 'notes', 'settings.json'));
  // A copy, and the owner's or another agent's configuration, hold a credential too.
  for (const [name, config] of [
    ['backup.json', null],
    ['owner.txt', { url: 'http://127.0.0.1:8787', token: 'O'.repeat(43) }],
    ['peer.md', { token: 'P'.repeat(43), url: 'https://lobby.example' }],
  ] as const) {
    const candidate = join(user, 'notes', name);
    if (config) await writeFile(candidate, JSON.stringify(config, null, 2));
    else await copyFile(path, candidate);
    for (const settings of [options, { home: user }])
      await assert.rejects(
        readLocalAttachment(candidate, settings),
        /cannot attach .*: it is a PocoLobby configuration, which holds a credential\. Nothing was sent\.$/,
      );
  }
  // Ordinary JSON, including look-alikes without both string fields, is still attached.
  for (const [name, text] of [
    ['package.json', '{"name":"app","version":"1.0.0"}'],
    ['links.json', '{"url":"https://example.com","title":"Docs"}'],
    ['numbers.json', '{"url":"https://example.com","token":42}'],
    ['list.json', '[{"url":"https://example.com","token":"x"}]'],
    ['report.md', '{"url":"https://example.com","token":"x"'],
  ]) {
    await writeFile(join(user, 'notes', name!), text!);
    assert.equal(
      (await readLocalAttachment(join(user, 'notes', name!), options)).descriptor.filename,
      name,
    );
  }
});

test('application data directories are refused per platform', () => {
  const home = '/Users/agent';
  assert.match(
    pathViolation('/Users/agent/Library/Application Support/Code/state.json', home, 'darwin')!,
    /inside ~\/Library/,
  );
  assert.equal(
    pathViolation('/Users/agent/Library/CloudStorage/Dropbox/MDP/shot.png', home, 'darwin'),
    null,
  );
  assert.equal(
    pathViolation('/Users/agent/Library/Mobile Documents/notes.md', home, 'darwin'),
    null,
  );
  // Case-insensitive where the file system is.
  assert.match(pathViolation('/Users/agent/library/x.png', home, 'darwin')!, /Library/);
  assert.equal(pathViolation('/Users/agent/library/x.png', home, 'linux'), null);
  assert.match(pathViolation('/Users/agent/AppData/Roaming/x.json', home, 'win32')!, /AppData/);
});

test('save_to follows the same rules and never replaces an existing file', async (t) => {
  const { root, user } = await home(t);
  const options = { home: user };
  const target = await saveDirectory(join(user, 'screens'), 'after.png', options);
  assert.deepEqual(target, { path: join(user, 'screens'), missing: false });
  // On Windows a device name, whatever its extension, is saved under a safe name.
  assert.equal(
    basename(await writeAttachmentFile(target.path, 'nul.txt', png, 'win32')),
    '_nul.txt',
  );
  assert.equal(
    basename(await writeAttachmentFile(target.path, 'COM1.png', png, 'win32')),
    '_COM1.png',
  );
  assert.equal(
    basename(await writeAttachmentFile(target.path, 'console.png', png, 'win32')),
    'console.png',
  );
  const first = await writeAttachmentFile(target.path, 'after.png', png);
  const second = await writeAttachmentFile(target.path, 'after.png', Buffer.from(png));
  assert.equal(first, join(user, 'screens', 'after.png'));
  assert.equal(second, join(user, 'screens', 'after (2).png'));
  assert.deepEqual(await readFile(second), png);
  const refusedSave = async (directory: string, name: string, pattern: RegExp) =>
    await assert.rejects(saveDirectory(directory, name, options), (error: unknown) => {
      assert(error instanceof LocalFileRefusal);
      assert.match(error.message, pattern);
      assert.match(error.message, /Nothing was written\.$/);
      return true;
    });
  await refusedSave('screens', 'a.png', /absolute directory/);
  await refusedSave(root, 'a.png', /outside your home/);
  await refusedSave(join(user, '.ssh'), 'a.png', /dot directory/);
  await refusedSave(join(user, 'screens'), 'id_rsa.txt', /credential/);
  await refusedSave(join(user, 'screens', 'before.png'), 'a.png', /not a directory/);
  await symlink(join(user, '.ssh'), join(user, 'keysafe'));
  await refusedSave(join(user, 'keysafe'), 'a.png', /resolves to .*dot directory/);
});

test('a peer file named like instructions is saved under another name, and secrets stay home', async (t) => {
  const { user } = await home(t);
  // Claude Code and Codex would load these as standing instructions in a project.
  for (const name of ['CLAUDE.md', 'claude.local.md', 'AGENTS.md', 'AGENTS.override.md'])
    assert.equal(
      basename(await writeAttachmentFile(join(user, 'notes'), name, Buffer.from('# x\n'))),
      name.replace(/\.md$/u, ' (attachment).md'),
    );
  assert.equal(
    basename(await writeAttachmentFile(join(user, 'notes'), 'CLAUDE-notes.md', Buffer.from('x'))),
    'CLAUDE-notes.md',
  );
  // Well-known secrets in a text file, whatever its name, and passwd files by name.
  for (const [name, text] of <[string, string][]>[
    ['aws.txt', '[default]\naws_secret_access_key = abc\n'],
    ['ids.txt', 'key AKIAABCDEFGHIJKLMNOP\n'],
    ['gh.md', `token ghp_${'a'.repeat(36)}\n`],
    ['claude.txt', `ANTHROPIC_API_KEY=sk-ant-${'b'.repeat(40)}\n`],
    ['slack.log', `xoxb-${'1'.repeat(30)}\n`],
  ]) {
    await writeFile(join(user, 'notes', name), text);
    await refused(join(user, 'notes', name), user, /looks like an access key or token/);
  }
  await writeFile(join(user, 'notes', 'passwd.txt'), 'x');
  await refused(join(user, 'notes', 'passwd.txt'), user, /looks like a credential/);
  // Prose about keys and tokens is evidence, not a secret.
  await writeFile(
    join(user, 'notes', 'tokens.md'),
    'Design tokens: sk-ant- prefixes and AKIA keys.\n',
  );
  assert.equal(
    (await readLocalAttachment(join(user, 'notes', 'tokens.md'), { home: user })).descriptor
      .filename,
    'tokens.md',
  );
});

test('save_to creates missing directories only where the whole path passes the rules', async (t) => {
  const { root, user } = await home(t);
  const options = { home: user };
  // Checked first without creating anything, then created with every missing parent.
  const nested = join(user, 'Dropbox', 'MDP', 'reviews', '2026-10-16');
  const planned = await saveDirectory(nested, 'after.png', options);
  assert.deepEqual(planned, { path: nested, missing: true });
  await assert.rejects(readFile(join(user, 'Dropbox')), /ENOENT/);
  assert.deepEqual(await saveDirectory(nested, 'after.png', options, true), {
    path: nested,
    missing: false,
  });
  assert.equal(await writeAttachmentFile(nested, 'after.png', png), join(nested, 'after.png'));
  // An existing directory is used as it is, also with create.
  assert.deepEqual(await saveDirectory(nested, 'b.png', options, true), {
    path: nested,
    missing: false,
  });
  // Through a link to an allowed place, such as a cloud folder elsewhere in home.
  await mkdir(join(user, 'Library', 'CloudStorage', 'Dropbox'), { recursive: true });
  await symlink(join(user, 'Library', 'CloudStorage', 'Dropbox'), join(user, 'Cloud'));
  const viaLink = await saveDirectory(join(user, 'Cloud', 'MDP', 'new'), 'a.png', options, true);
  assert.equal(viaLink.path, join(user, 'Library', 'CloudStorage', 'Dropbox', 'MDP', 'new'));
  const refusedSave = async (directory: string, pattern: RegExp, create = true) =>
    await assert.rejects(saveDirectory(directory, 'a.png', options, create), (error: unknown) => {
      assert(error instanceof LocalFileRefusal, String(error));
      assert.match(error.message, pattern);
      assert.match(error.message, /Nothing was written\.$/);
      return true;
    });
  // The same rules as for an existing directory, before anything is created.
  await refusedSave(join(user, 'notes', '.hidden', 'x'), /dot directory/);
  await refusedSave(join(root, 'elsewhere', 'x'), /outside your home/);
  // A link above the missing part that leads out of home, or into a dot directory.
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(user, 'escape'));
  await refusedSave(
    join(user, 'escape', 'new', 'deeper'),
    /would be created at .*outside your home/,
  );
  await symlink(join(user, '.ssh'), join(user, 'keys-folder'));
  await refusedSave(join(user, 'keys-folder', 'new'), /would be created at .*dot directory/);
  await assert.rejects(readFile(join(root, 'outside', 'new')), /ENOENT/);
  await assert.rejects(readFile(join(user, '.ssh', 'new')), /ENOENT/);
  // A link to nothing is not taken for a missing directory, and a file is no parent.
  await symlink(join(user, 'gone'), join(user, 'dangling'));
  await refusedSave(join(user, 'dangling', 'new'), /symbolic link to nothing/);
  // Windows checks a path below a file without complaint and refuses when creating it.
  await refusedSave(
    join(user, 'notes', 'report.md', 'new'),
    /cannot be (checked|created) \(ENOTDIR\)/,
  );
  if (process.platform === 'darwin')
    await refusedSave(join(user, 'Library', 'Preferences', 'new'), /inside ~\/Library/);
});

test('a file above the bridge ceiling is refused with the limit that applies', async (t) => {
  const { user } = await home(t);
  const large = join(user, 'notes', 'large.md');
  await writeFile(large, Buffer.alloc(16 * 1024 * 1024 + 1, 'a'));
  const refusal = async (options: Parameters<typeof readLocalAttachment>[1], pattern: RegExp) =>
    await assert.rejects(readLocalAttachment(large, options), (error: unknown) => {
      assert(error instanceof LocalFileRefusal, String(error));
      assert.match(error.message, pattern);
      return true;
    });
  // The broker's catalog states a lower limit: that one is named.
  await refusal(
    { home: user, maxBytes: { image: 10 * 1024 * 1024, text: 1024 * 1024 } },
    /it is 16\.0 MiB; this broker accepts text attachments up to 1\.0 MiB\. Nothing was sent\.$/,
  );
  // A broker that accepts more: this bridge's own ceiling applies.
  await refusal(
    { home: user, maxBytes: { image: 10 * 1024 * 1024, text: 32 * 1024 * 1024 } },
    /this bridge reads text attachments up to 16\.0 MiB\. Nothing was sent\.$/,
  );
  // A broker that states no limits (before 0.3.1): both are explained.
  await refusal(
    { home: user },
    /this bridge reads text attachments up to 16\.0 MiB, and the broker's own limit, stated in the attachments description, can be lower/,
  );
  // Below the ceiling the broker decides, after matching a retry to its stored send.
  const medium = join(user, 'notes', 'medium.md');
  await writeFile(medium, Buffer.alloc(2 * 1024 * 1024, 'a'));
  const read = await readLocalAttachment(medium, {
    home: user,
    maxBytes: { image: 10 * 1024 * 1024, text: 1024 * 1024 },
  });
  assert.equal(read.descriptor.size, 2 * 1024 * 1024);
});

test('a system temporary folder holds scratch files: allowed, with the name rules still applied', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pocolobby-temp-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'home');
  const scratch = join(root, 'temp', 'claude-501', 'scratchpad');
  await mkdir(user, { recursive: true });
  await mkdir(join(scratch, '.hidden'), { recursive: true });
  await writeFile(join(scratch, 'report.md'), '# Report\n');
  await writeFile(join(scratch, '.hidden', 'shot.png'), png);
  await writeFile(join(scratch, 'credentials.json'), '{}');
  await writeFile(join(root, 'elsewhere.md'), '# Elsewhere\n');
  const temp = [join(root, 'temp')];
  const read = (path: string) => readLocalAttachment(path, { home: user, temp });
  assert.equal((await read(join(scratch, 'report.md'))).descriptor.filename, 'report.md');
  await assert.rejects(read(join(scratch, '.hidden', 'shot.png')), /dot directory/);
  await assert.rejects(read(join(scratch, 'credentials.json')), LocalFileRefusal);
  await assert.rejects(
    read(join(root, 'elsewhere.md')),
    /outside your home directory and the system temporary folder/,
  );
  // Without the temporary folders, as before.
  await assert.rejects(
    readLocalAttachment(join(scratch, 'report.md'), { home: user }),
    /outside your home directory/,
  );
  // Saving there works the same way.
  assert.equal((await saveDirectory(scratch, 'after.png', { home: user, temp })).path, scratch);
  assert.equal(pathViolation(join(scratch, 'x.md'), user, 'win32', temp), null);
});
