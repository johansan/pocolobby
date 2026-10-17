import type { RuntimeAuth } from './protocol.js';

export interface LobbyClientConfig {
  url: string;
  token: string;
  timeoutMs?: number;
  /** Sent on every request and the event socket, such as the bridge's declared features. */
  headers?: Record<string, string>;
}
/** Uploads and downloads of attachments may take longer than ordinary requests. */
const TRANSFER_TIMEOUT_MS = 120_000;
/** Larger than any attachment a broker accepts by default. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export class LobbyClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** The broker's one-line explanation, such as which argument failed validation. */
    public readonly detail?: string,
    /** attachment_upload_required: the SHA-256 of each file the broker still needs. */
    public readonly missing?: string[],
  ) {
    super(`PocoLobby request failed (${status || 'network'}: ${code}).`);
    this.name = 'LobbyClientError';
  }
}

/** A broker error message, reduced to one bounded line. */
function errorDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return line ? (line.length > 300 ? `${line.slice(0, 297)}...` : line) : undefined;
}

/** Never follows redirects or retries mutations: callers retain their request ID. */
export class LobbyClient {
  readonly url: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: LobbyClientConfig) {
    const url = new URL(config.url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error('PocoLobby requires HTTPS, except for loopback HTTP.');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('PocoLobby URLs must not contain credentials, queries, or fragments.');
    }
    if (url.pathname !== '/') {
      throw new Error('PocoLobby requires an origin URL without a path.');
    }
    if (!config.token || /[\r\n]/.test(config.token)) {
      throw new Error('A valid PocoLobby credential is required.');
    }
    this.url = url;
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.extraHeaders = { ...config.headers };
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error('PocoLobby request timeout must be between 1 and 60000 milliseconds.');
    }
  }

  endpoint(path: string): URL {
    if (!path.startsWith('/v1/') || path.includes('\\') || path.includes('..')) {
      throw new Error('Invalid PocoLobby API path.');
    }
    const endpoint = new URL(path, this.url.origin);
    if (endpoint.origin !== this.url.origin) {
      throw new Error('PocoLobby API requests must stay on the configured origin.');
    }
    return endpoint;
  }

  headers(runtime?: RuntimeAuth): Record<string, string> {
    return {
      ...this.extraHeaders,
      authorization: `Bearer ${this.token}`,
      ...(runtime
        ? {
            'x-pocolobby-runtime-id': runtime.runtime_id,
            'x-pocolobby-generation': String(runtime.generation),
            'x-pocolobby-incarnation': runtime.incarnation,
          }
        : {}),
    };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    runtime?: RuntimeAuth,
  ): Promise<T> {
    const response = await this.send(method, path, runtime, this.timeoutMs, {
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), contentType: 'application/json' }),
    });
    return (await this.json(response)) as T;
  }

  /** PUT an attachment's bytes; the broker answers with what it stored. */
  async upload<T>(path: string, bytes: Buffer, runtime: RuntimeAuth): Promise<T> {
    const response = await this.send('PUT', path, runtime, TRANSFER_TIMEOUT_MS, {
      body: bytes,
      contentType: 'application/octet-stream',
    });
    return (await this.json(response)) as T;
  }

  /** GET an attachment's bytes. */
  async download(path: string): Promise<Buffer> {
    const response = await this.send('GET', path, undefined, TRANSFER_TIMEOUT_MS, {});
    if (!response.ok) {
      await this.json(response);
      throw new LobbyClientError(response.status, 'request_rejected');
    }
    try {
      return await this.read(response, MAX_DOWNLOAD_BYTES);
    } catch {
      throw new LobbyClientError(response.status, 'invalid_response');
    }
  }

  private async send(
    method: string,
    path: string,
    runtime: RuntimeAuth | undefined,
    timeoutMs: number,
    { body, contentType }: { body?: string | Buffer; contentType?: string },
  ): Promise<Response> {
    try {
      return await fetch(this.endpoint(path), {
        method,
        headers: {
          ...this.headers(runtime),
          ...(contentType ? { 'content-type': contentType } : {}),
        },
        // A Buffer is sent as its bytes, through a view rather than a copy; fetch's types
        // predate Buffer generics.
        ...(body === undefined
          ? {}
          : {
              body:
                typeof body === 'string'
                  ? body
                  : new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
            }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Deliberately omit fetch's error/cause: it can contain an endpoint or header.
      throw new LobbyClientError(0, 'connection_failed_or_timed_out');
    }
  }

  private async read(response: Response, limit: number): Promise<Buffer> {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) {
          await reader.cancel();
          throw new Error('Response too large');
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks);
  }

  /** A JSON result, or the broker's error as a LobbyClientError. */
  private async json(response: Response): Promise<unknown> {
    let result: unknown;
    try {
      const bytes = await this.read(response, 2 * 1024 * 1024);
      result = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
    } catch {
      throw new LobbyClientError(response.status, 'invalid_response');
    }
    if (!response.ok) {
      const value = result as {
        code?: unknown;
        error?: { code?: unknown; message?: unknown; missing?: unknown };
      } | null;
      const code = value?.code ?? value?.error?.code;
      const missing = value?.error?.missing;
      throw new LobbyClientError(
        response.status,
        typeof code === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(code)
          ? code
          : 'request_rejected',
        errorDetail(value?.error?.message),
        Array.isArray(missing) &&
          missing.length <= 5 &&
          missing.every((item) => typeof item === 'string' && /^[0-9a-f]{64}$/u.test(item))
          ? (missing as string[])
          : undefined,
      );
    }
    return result;
  }
}
