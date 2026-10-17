/**
 * PocoLobby's icon, the periscope agent from pocolobby.com, on every page of every host. The files
 * ship with the package in site/icons and are served from memory at /favicon.svg, /favicon.ico,
 * /favicon-32.png and /apple-touch-icon.png, so the pages' `img-src 'self'` covers them. A lobby
 * may give its board its own icon instead: a square PNG that its owner uploads, served on the
 * board host at /icon.png.
 */
import { readFileSync } from 'node:fs';
import { LobbyError } from './protocol.js';

const DIRECTORY = new URL('../site/icons/', import.meta.url);
const TYPES = { svg: 'image/svg+xml', ico: 'image/x-icon', png: 'image/png' } as const;

const files = new Map<string, { body: Buffer; type: string }>(
  ['favicon.svg', 'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png'].map((name) => [
    `/${name}`,
    {
      body: readFileSync(new URL(name, DIRECTORY)),
      type: TYPES[name.slice(name.lastIndexOf('.') + 1) as keyof typeof TYPES],
    },
  ]),
);

/** PocoLobby's icon for a request path, with its response headers, or undefined. */
export function iconFile(
  path: string,
): { body: Buffer; headers: Record<string, string> } | undefined {
  const file = files.get(path);
  return (
    file && {
      body: file.body,
      headers: {
        'content-type': file.type,
        'content-length': String(file.body.length),
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      },
    }
  );
}

/** The head links for PocoLobby's icon. */
export const ICON_LINKS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

/** The head links for a lobby's own icon, versioned by its content so a new one shows at once. */
export const lobbyIconLinks = (version: string) =>
  `<link rel="icon" href="/icon.png?v=${version}" type="image/png">
<link rel="apple-touch-icon" href="/icon.png?v=${version}">`;

/** The short content version in a lobby icon's address. */
export const iconVersion = (sha256: string) => sha256.slice(0, 16);

export const MAX_ICON_BYTES = 64 * 1024;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Refuse what cannot be a lobby's icon: anything but a PNG, more than 64 KB, or not square from
 * 32 to 1024 pixels. Only the header is read; a browser shows nothing for a damaged image.
 */
export function checkLobbyIcon(png: Buffer): void {
  if (png.length > MAX_ICON_BYTES)
    throw new LobbyError(
      413,
      'icon_too_large',
      `The icon is ${Math.ceil(png.length / 1024)} KB; use a PNG of at most 64 KB.`,
    );
  if (
    png.length < 33 ||
    !png.subarray(0, 8).equals(SIGNATURE) ||
    png.toString('latin1', 12, 16) !== 'IHDR'
  )
    throw new LobbyError(400, 'icon_not_png', 'The icon must be a PNG image.');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== height || width < 32 || width > 1024)
    throw new LobbyError(
      400,
      'icon_size',
      `The icon is ${width} × ${height} pixels; use a square PNG from 32 to 1024 pixels wide.`,
    );
}
