/**
 * The bridge's only access to the agent's disk: reading a file the model named in its own
 * attachments argument, and writing a downloaded attachment where get_attachment's save_to
 * points. Peer messages never reach this module, so message text cannot cause an upload.
 *
 * Every path is checked twice, as written and after resolving symbolic links: it must be inside
 * the user's home directory or a system temporary folder (where Claude Code keeps a session's
 * scratch files), not hidden and not under a dot directory (~/.ssh, ~/.aws, ~/.pocolobby), not
 * inside an application-data directory (~/Library on macOS except its cloud folders, AppData on
 * Windows, apart from the temporary folder inside it), and not named like a credential. A symbolic link to a file is
 * accepted only when its target sits in the same directory and passes the same rules. Whatever
 * its name, the bridge's own credential file and any PocoLobby configuration are refused.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AttachmentFilename,
  classify,
  formatBytes,
  kindForFilename,
  ALLOWED_EXTENSIONS,
  OTHER_FILES,
  type AttachmentDescriptor,
  type AttachmentKind,
} from './attachments.js';
import type { ConfigIdentity } from './config.js';

/** A refused path or file; the message says why and that nothing was sent or written. */
export class LocalFileRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalFileRefusal';
  }
}
/**
 * The most this bridge reads for one attachment, whatever a broker accepts. A broker's own,
 * usually lower, limits come from its tool catalog (`maxBytes`).
 */
export const READ_CEILING = { image: 64 * 1024 * 1024, text: 16 * 1024 * 1024 } as const;
const CREDENTIAL_NAMES = [
  /^\.env/iu,
  /\.pem$/iu,
  // Key files, not every name with "key" in it: keyframe-panel.png and key-light.png are evidence.
  /\.key$/iu,
  /^keys?(\.[^.]+)?$/iu,
  /(api|private|secret|access|ssh|auth|signing|encryption|master)[-_ .]?keys?(?![a-z])/iu,
  /key(store|chain|ring|file)/iu,
  /^id_/iu,
  /secret/iu,
  /credential/iu,
  /password/iu,
  /passwd/iu,
  /\.p12$/iu,
  /\.pfx$/iu,
];
const CREDENTIAL_RULE =
  'its name looks like a credential (.env*, *.pem, *.key, key.*, api-key, private_key and the like, *keystore*, id_*, *secret*, *credential*, *password*, *passwd*, *.p12, *.pfx)';

export interface LocalFileOptions {
  /** The user's home directory; normally os.homedir(). */
  home: string;
  /** System temporary folders also allowed, normally tempRoots(); none when omitted. */
  temp?: string[];
  platform?: NodeJS.Platform;
  /** The bridge's own credential file, refused under any name, link or path to it. */
  credentialFile?: ConfigIdentity;
  /** The broker's configured size limits, when its catalog states them; used for wording. */
  maxBytes?: Record<AttachmentKind, number>;
}
const OWN_CREDENTIAL = "it is this bridge's own PocoLobby credential file";
const HOLDS_CREDENTIAL = 'it is a PocoLobby configuration, which holds a credential';
const HOLDS_PRIVATE_KEY = 'it contains a private key';
const HOLDS_TOKEN = 'it holds an access or refresh token or a client secret';
// PEM keys and PGP key blocks.
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/u;
// OAuth token files such as Google's token.json, whatever their name.
const TOKEN_FIELDS = /"(refresh_token|access_token|client_secret)"\s*:/u;
// Well-known secrets in plain text: AWS keys, GitHub, Anthropic and Slack tokens.
const SECRET_SHAPES =
  /aws_secret_access_key\s*=|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-ant-[A-Za-z0-9_-]{20,}|\bxox[abps]-[A-Za-z0-9-]{20,}/u;
const HOLDS_SECRET = 'it holds what looks like an access key or token';

/** A JSON object with string url and token fields: the shape of every PocoLobby configuration. */
function isLobbyConfig(bytes: Buffer): boolean {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { url?: unknown }).url === 'string' &&
      typeof (value as { token?: unknown }).token === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * The system's temporary folders: Claude Code keeps a session's scratch files there (under
 * AppData\Local\Temp on Windows, /tmp on macOS).
 */
export function tempRoots(platform: NodeJS.Platform = process.platform): string[] {
  return [...new Set([tmpdir(), ...(platform === 'win32' ? [] : ['/tmp'])])];
}
/** Each folder as given and as resolved, so a path matches whichever way it is written. */
async function withReal(folders: string[]): Promise<string[]> {
  const real = await Promise.all(folders.map((folder) => realpath(folder).catch(() => folder)));
  return [...new Set([...folders.map((folder) => resolve(folder)), ...real])];
}
const within = (folder: string, path: string): string[] | null => {
  const inside = relative(folder, path);
  return !inside || inside.startsWith('..') || isAbsolute(inside)
    ? null
    : inside.split(sep).filter(Boolean);
};
const DOT_RULE =
  'it is a dotfile or inside a dot directory (such as ~/.ssh, ~/.aws or ~/.pocolobby)';

/** Why a path breaks the rules, or null. Comparisons ignore case where the file system does. */
export function pathViolation(
  path: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
  temp: string[] = [],
): string | null {
  // In a temporary folder only the name rules apply: it holds scratch files, not app data.
  for (const folder of temp) {
    const parts = within(folder, path);
    if (!parts) continue;
    if (parts.some((part) => part.startsWith('.'))) return DOT_RULE;
    if (CREDENTIAL_NAMES.some((pattern) => pattern.test(parts.at(-1)!))) return CREDENTIAL_RULE;
    return null;
  }
  const parts = within(home, path);
  if (!parts)
    return temp.length
      ? 'it is outside your home directory and the system temporary folder'
      : 'it is outside your home directory';
  if (parts.some((part) => part.startsWith('.'))) return DOT_RULE;
  const fold = (value: string | undefined) =>
    platform === 'darwin' || platform === 'win32' ? value?.toLowerCase() : value;
  const [first, second] = [fold(parts[0]), fold(parts[1])];
  if (
    platform === 'darwin' &&
    first === 'library' &&
    second !== 'cloudstorage' &&
    second !== 'mobile documents'
  )
    return 'it is inside ~/Library, where applications keep their data (only ~/Library/CloudStorage and ~/Library/Mobile Documents are allowed)';
  if (platform === 'win32' && first === 'appdata')
    return 'it is inside AppData, where applications keep their data';
  if (CREDENTIAL_NAMES.some((pattern) => pattern.test(parts.at(-1)!))) return CREDENTIAL_RULE;
  return null;
}

async function realHome(home: string): Promise<string> {
  return await realpath(home).catch(() => home);
}

export interface LocalAttachment {
  descriptor: AttachmentDescriptor;
  bytes: Buffer;
  path: string;
}

/**
 * Read one file the model named for attachments, after checking every rule. The result describes
 * it for the broker (SHA-256, name, type from its bytes, size) and holds its bytes for upload.
 */
export async function readLocalAttachment(
  path: unknown,
  options: LocalFileOptions,
): Promise<LocalAttachment> {
  const shown = typeof path === 'string' ? path : JSON.stringify(path);
  const refuse = (reason: string): never => {
    throw new LocalFileRefusal(`PocoLobby: cannot attach ${shown}: ${reason}. Nothing was sent.`);
  };
  if (typeof path !== 'string' || !isAbsolute(path)) return refuse('give an absolute path');
  const platform = options.platform ?? process.platform;
  const home = resolve(options.home);
  const temp = await withReal(options.temp ?? []);
  const written = resolve(path);
  const lexical = pathViolation(written, home, platform, temp);
  if (lexical) refuse(lexical);
  const name = basename(written);
  if (!AttachmentFilename.safeParse(name).success)
    refuse(
      kindForFilename(name)
        ? 'its name has control characters or is too long'
        : `only ${ALLOWED_EXTENSIONS} can be attached. ${OTHER_FILES}`,
    );
  const link = await lstat(written).catch(() => null);
  if (!link) return refuse('it does not exist or cannot be read');
  let real: string;
  try {
    real = await realpath(written);
  } catch {
    return refuse('it cannot be resolved');
  }
  const resolvedViolation = pathViolation(real, await realHome(home), platform, temp);
  if (link.isSymbolicLink()) {
    const sameDirectory = (await realpath(dirname(written)).catch(() => null)) === dirname(real);
    if (!sameDirectory || resolvedViolation)
      refuse(`it is a symbolic link to elsewhere (${real}); attach files directly`);
  } else if (resolvedViolation) refuse(`it resolves to ${real}, and ${resolvedViolation}`);
  const own = options.credentialFile;
  if (own && real === own.path) refuse(OWN_CREDENTIAL);
  const kind = kindForFilename(name)!;
  // Open what was checked, refusing a link swapped in meanwhile.
  const handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() =>
    refuse('it cannot be opened'),
  );
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    // The same file under another name, such as a hard link, before reading anything.
    if (own && info.dev === own.dev && info.ino === own.ino) refuse(OWN_CREDENTIAL);
    if (!info.isFile()) refuse('it is not a regular file');
    if (info.size === 0) refuse('it is empty');
    // Only the bridge's own ceiling refuses here. Below it the broker decides, after it has
    // matched a retry to its stored send; its limits only name the effective one.
    if (info.size > READ_CEILING[kind]) {
      const accepted = options.maxBytes?.[kind];
      refuse(
        `it is ${formatBytes(info.size)}; ${
          accepted !== undefined && accepted < READ_CEILING[kind]
            ? `this broker accepts ${kind} attachments up to ${formatBytes(accepted)}`
            : `this bridge reads ${kind} attachments up to ${formatBytes(READ_CEILING[kind])}${accepted === undefined ? ", and the broker's own limit, stated in the attachments description, can be lower" : ''}`
        }`,
      );
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const type = classify(name, bytes);
  if (!type.ok) return refuse(type.reason);
  // Another agent's or the owner's configuration, or a copy of this bridge's own, at any path.
  if (type.kind === 'text' && isLobbyConfig(bytes)) refuse(HOLDS_CREDENTIAL);
  if (type.kind === 'text') {
    const text = bytes.toString('utf8');
    if (PRIVATE_KEY.test(text)) refuse(HOLDS_PRIVATE_KEY);
    if (TOKEN_FIELDS.test(text)) refuse(HOLDS_TOKEN);
    if (SECRET_SHAPES.test(text)) refuse(HOLDS_SECRET);
  }
  return {
    path: written,
    bytes,
    descriptor: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      filename: name,
      mime_type: type.mime_type,
      size: bytes.length,
    },
  };
}

export interface SaveDirectory {
  /** Where the file goes, after resolving links. */
  path: string;
  /** The directory does not exist yet; call again with `create` to make it. */
  missing: boolean;
}

/**
 * The directory save_to names, checked by the same rules (for a file of this name in it) and
 * resolved. A missing directory passes when the deepest existing one above it resolves to a
 * place where the whole path passes the rules too; with `create` it is then made, with any
 * missing parents, and checked again.
 */
export async function saveDirectory(
  directory: string,
  filename: string,
  options: LocalFileOptions,
  create = false,
): Promise<SaveDirectory> {
  const refuse = (reason: string): never => {
    throw new LocalFileRefusal(
      `PocoLobby: cannot save to ${directory}: ${reason}. Nothing was written.`,
    );
  };
  /** The path's status through links, or null only when nothing at all is there. */
  const status = async (path: string) => {
    try {
      return await stat(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && !(await lstat(path).catch(() => null))) return null;
      return refuse(
        code === 'ENOENT'
          ? `${path} is a symbolic link to nothing`
          : `${path} cannot be checked (${code ?? 'failed'})`,
      );
    }
  };
  if (!isAbsolute(directory)) refuse('give an absolute directory');
  const platform = options.platform ?? process.platform;
  const home = resolve(options.home);
  const temp = await withReal(options.temp ?? []);
  const written = resolve(directory);
  const lexical = pathViolation(join(written, filename), home, platform, temp);
  if (lexical) refuse(lexical);
  const info = await status(written);
  if (info && !info.isDirectory()) refuse('it is not a directory');
  if (!info) {
    // Where the missing part would really be, through any links above it.
    let existing = dirname(written);
    while (!(await status(existing)) && dirname(existing) !== existing)
      existing = dirname(existing);
    const planned = join(await realpath(existing), relative(existing, written));
    const violation = pathViolation(join(planned, filename), await realHome(home), platform, temp);
    if (violation) refuse(`it would be created at ${planned}, and ${violation}`);
    if (!create) return { path: planned, missing: true };
    await mkdir(written, { recursive: true, mode: 0o700 }).catch((error: unknown) =>
      refuse(`it cannot be created (${(error as NodeJS.ErrnoException).code ?? 'failed'})`),
    );
  }
  const real = await realpath(written);
  const resolvedViolation = pathViolation(
    join(real, filename),
    await realHome(home),
    platform,
    temp,
  );
  if (resolvedViolation) refuse(`it resolves to ${real}, and ${resolvedViolation}`);
  return { path: real, missing: false };
}

/**
 * Write an attachment into a checked directory without replacing anything: an existing name
 * gets a numbered variant, such as "before (2).png". Returns the written path.
 */
export async function writeAttachmentFile(
  directory: string,
  filename: string,
  bytes: Buffer,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  // Characters Windows cannot store in a name, and its device names (nul.txt is the null
  // device, whatever the extension); elsewhere the broker's rules already suffice.
  const safe =
    platform === 'win32'
      ? filename
          .replace(/[<>:"|?*]/gu, '_')
          .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?=\.|$)/iu, '_$1')
      : filename;
  // Claude Code and Codex load these names as instructions; a peer's file must stay a file.
  const named = /^(CLAUDE(\.local)?|AGENTS(\.override)?)\.md$/iu.test(safe)
    ? safe.replace(/\.md$/iu, ' (attachment).md')
    : safe;
  const extension = extname(named);
  const stem = named.slice(0, named.length - extension.length);
  for (let attempt = 1; attempt <= 100; attempt++) {
    const candidate = join(directory, attempt === 1 ? named : `${stem} (${attempt})${extension}`);
    let handle;
    try {
      // O_EXCL: never follows or replaces an existing file or link.
      handle = await open(candidate, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new LocalFileRefusal(
        `PocoLobby: cannot write ${candidate}: ${(error as NodeJS.ErrnoException).code ?? 'write failed'}. Nothing was written.`,
      );
    }
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return candidate;
  }
  throw new LocalFileRefusal(
    `PocoLobby: ${directory} already holds 100 files named like ${named}. Nothing was written.`,
  );
}
