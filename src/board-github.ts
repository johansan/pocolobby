import type { NotesFile, NotesSnapshot, NotesSource } from './board-model.js';

/**
 * Reads one room's notes from GitHub at one commit (0.4.0). The ref is resolved to a commit
 * first, with a conditional request that costs nothing when it has not moved; then each notes
 * path is read at that commit, a directory as every `*.md` directly inside it and a file as
 * itself, and only blobs whose SHA is new are downloaded. So every file of a snapshot comes
 * from the same commit even while someone pushes. Files are cut, visibly, to the board's share.
 */
export interface GitHubNotesOptions {
  token: string;
  /** https://api.github.com, or a test server. */
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Bytes kept per file and per source; a file beyond its share is cut and marked. */
  maxFileBytes?: number;
  maxSourceBytes?: number;
  now?: () => number;
}
export type NotesFetch =
  | { changed: false; etag: string | null }
  | { changed: true; etag: string | null; snapshot: NotesSnapshot };

export class NotesError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_SOURCE_BYTES = 200 * 1024;
const MAX_FILES = 100;
/** Larger blobs are not downloaded at all; the board shows them as cut with nothing read. */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

interface Entry {
  path: string;
  sha: string;
  size: number;
}
const isEntry = (value: unknown): value is Entry & { type: string } =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  value.type === 'file' &&
  'path' in value &&
  typeof value.path === 'string' &&
  'sha' in value &&
  typeof value.sha === 'string' &&
  'size' in value &&
  typeof value.size === 'number';

/** The first `limit` bytes of UTF-8 text, without a broken last character. */
function cut(content: Buffer, limit: number): string {
  return content.subarray(0, limit).toString('utf8').replace(/�+$/u, '');
}

export class GitHubNotes {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxFileBytes: number;
  private readonly maxSourceBytes: number;
  constructor(private readonly options: GitHubNotesOptions) {
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxSourceBytes = options.maxSourceBytes ?? MAX_SOURCE_BYTES;
  }

  private async get(
    path: string,
    accept: string,
    what: string,
    signal: AbortSignal,
    etag?: string | null,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        headers: {
          accept,
          authorization: `Bearer ${this.options.token}`,
          'user-agent': 'pocolobby-board',
          'x-github-api-version': '2022-11-28',
          ...(etag ? { 'if-none-match': etag } : {}),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new NotesError(
        name === 'TimeoutError'
          ? `GitHub did not answer within ${this.timeoutMs / 1000} s (${what})`
          : `GitHub could not be reached (${what})`,
      );
    }
    if (response.status === 304 || response.ok) return response;
    let detail = '';
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === 'string') detail = `: ${body.message.slice(0, 120)}`;
    } catch {
      /* No JSON body; the status says enough. */
    }
    throw new NotesError(
      `GitHub answered ${response.status} for ${what}${detail}`,
      response.status,
    );
  }

  /**
   * The notes at the ref's current commit, or `changed: false` when the ref still names the
   * previous snapshot's commit. Pass the ETag only together with the snapshot it belongs to.
   */
  async fetch(
    source: NotesSource,
    previous: NotesSnapshot | null,
    etag: string | null,
    signal: AbortSignal,
  ): Promise<NotesFetch> {
    const repo = `/repos/${source.repo}`;
    const head = await this.get(
      `${repo}/commits/${encodeURIComponent(source.ref)}`,
      'application/vnd.github.sha',
      `the ref ${source.ref}`,
      signal,
      etag,
    );
    if (head.status === 304) return { changed: false, etag };
    const nextEtag = head.headers.get('etag');
    const commit = (await head.text()).trim();
    if (!/^[0-9a-f]{40}$/u.test(commit))
      throw new NotesError(`GitHub did not name a commit for the ref ${source.ref}`);
    if (previous?.commit_sha === commit) return { changed: false, etag: nextEtag };

    const entries: Entry[] = [];
    for (const path of source.notes) {
      let listing: unknown;
      try {
        const response = await this.get(
          `${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`,
          'application/vnd.github+json',
          path,
          signal,
        );
        listing = await response.json();
      } catch (error) {
        // The ref resolved, so the repository is readable: a path that does not exist at this
        // commit contributes no notes, which is not a failure.
        if (error instanceof NotesError && error.status === 404) continue;
        throw error;
      }
      const found: Entry[] = Array.isArray(listing)
        ? listing
            .filter((entry) => isEntry(entry) && entry.path.endsWith('.md'))
            .sort((left: Entry, right: Entry) => left.path.localeCompare(right.path))
        : isEntry(listing)
          ? [listing]
          : [];
      for (const entry of found)
        if (!entries.some((known) => known.path === entry.path)) entries.push(entry);
    }
    if (entries.length > MAX_FILES)
      throw new NotesError(`${entries.length} notes files exceed the board's ${MAX_FILES}`);

    const known = new Map(
      previous?.files.filter((file) => !file.truncated).map((file) => [file.sha, file.content]),
    );
    const files: NotesFile[] = [];
    let budget = this.maxSourceBytes;
    for (const entry of entries) {
      const share = Math.min(this.maxFileBytes, budget);
      const truncated = entry.size > share;
      let content = truncated ? undefined : known.get(entry.sha);
      if (content === undefined) {
        if (share === 0 || entry.size > MAX_DOWNLOAD_BYTES) content = '';
        else {
          const blob = await this.get(
            `${repo}/git/blobs/${encodeURIComponent(entry.sha)}`,
            'application/vnd.github.raw',
            entry.path,
            signal,
          );
          content = cut(Buffer.from(await blob.arrayBuffer()), share);
        }
      }
      budget -= Buffer.byteLength(content);
      files.push({ path: entry.path, sha: entry.sha, bytes: entry.size, truncated, content });
    }
    return {
      changed: true,
      etag: nextEtag,
      snapshot: {
        commit_sha: commit,
        files,
        fetched_at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      },
    };
  }
}
