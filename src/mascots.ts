/**
 * The PocoLobby agents, where a page has a moment rather than content: an empty list, nothing
 * waiting, all quiet, sign-in, a dead end. As Discord does with Wumpus, each comes with a line that
 * says what the moment means and what happens next; they never decorate a full page. They ship
 * with the package in site/agents and are served from memory at /agents/<name>.webp on every
 * host, so the pages' `img-src 'self'` covers them.
 */
import { readFileSync } from 'node:fs';

const DIRECTORY = new URL('../site/agents/', import.meta.url);
export const MASCOTS = [
  'poco-bell',
  'vader-deckchair',
  'vader-point',
  'mouse-empty',
  'mouse-envelope',
  'gonk-server',
  'luke-sleep',
] as const;
export type Mascot = (typeof MASCOTS)[number];

const files = new Map<string, Buffer>(
  MASCOTS.map((name) => [`/agents/${name}.webp`, readFileSync(new URL(`${name}.webp`, DIRECTORY))]),
);

/** The picture for a request path, or undefined when it is not one of them. */
export const mascotFile = (path: string): Buffer | undefined => files.get(path);

/** Response headers for a picture: they never change within a release. */
export const MASCOT_HEADERS = {
  'content-type': 'image/webp',
  'cache-control': 'public, max-age=86400',
  'x-content-type-options': 'nosniff',
} as const;

/** An agent beside words that say everything, so its alt text is empty. */
export const mascot = (name: Mascot, className: string, size: number): string =>
  `<img class="mascot ${className}" src="/agents/${name}.webp" alt="" width="${size}" height="${size}">`;

/**
 * An empty state: the agent, a short title, what the emptiness means, and the next step if there
 * is one. Title, text and action are HTML the caller has escaped.
 */
export const emptyState = (name: Mascot, title: string, text: string, action = ''): string =>
  `<div class="empty">${mascot(name, 'empty-agent', 112)}<h3>${title}</h3><p>${text}</p>${action}</div>`;

/** The empty state's look, shared by the board and the console. */
export const EMPTY_CSS = `.mascot { display: block; flex: none; height: auto; pointer-events: none; }
.empty { display: grid; justify-items: center; text-align: center; gap: 6px; padding: 26px 20px 24px; }
.empty .empty-agent { width: 112px; margin-bottom: 2px; }
.empty h3 { margin: 0; font-size: 17px; }
.empty p { margin: 0; color: var(--muted); max-width: 46ch; }
.empty .btn, .empty .button { margin-top: 8px; }`;
