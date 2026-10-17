import { EMPTY_CSS, emptyState, mascot } from './mascots.js';
import { ICON_LINKS, iconVersion } from './icons.js';
import type { BoardView } from './board.js';
import {
  MODEL_NAMES,
  SUMMARY_EFFORTS,
  SUMMARY_MODELS,
  type BoardConfig,
  type NotesSnapshot,
  type SummaryRecord,
} from './board-model.js';
import { EARLY_SCRIPT, escape, FONTS, THEME_SCRIPT, THEME_SWITCH, TOKENS } from './board-page.js';
import type { Agent, Room } from './protocol.js';
import type { ActivityEvent, BoardViewer, OwnedLobby } from './store.js';

/**
 * Server-rendered console pages (0.5.0), the approved prototype "Lobby console" with the
 * board's tokens and themes. Every value from the store is escaped here. The one script (by
 * nonce) switches the theme and sends each `form[data-action]` as JSON, then reloads or follows
 * the redirect it gets back; pages render without it, but their buttons need it.
 */

export type Section =
  'overview' | 'rooms' | 'summaries' | 'board' | 'agents' | 'activity' | 'settings';
const SECTIONS: [Section, string][] = [
  ['overview', 'Overview'],
  ['rooms', 'Rooms and repos'],
  ['summaries', 'AI summaries'],
  ['board', 'Board access'],
  ['agents', 'Agents'],
  ['activity', 'Activity'],
  ['settings', 'Lobby settings'],
];

/** What every console page knows: the response nonce and who is signed in. */
export interface Shell {
  nonce: string;
  email: string | null;
  /** The lobby whose sections show, with its board address. */
  lobby?: { id: string; name: string; address: string; url: string };
  section?: Section;
}

const CSS = `${TOKENS}
/* Layout: the lobby owner's console. A side list of sections on wide screens, tabs on a phone; each section is one job. Same tokens as the board. */
.wrap { max-width: 1080px; margin: 0 auto; padding-block: 0 56px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
h1, h2, h3 { font-family: var(--display); margin: 0; letter-spacing: -0.01em; text-wrap: balance; }
.mono { font-family: var(--mono); font-size: 0.86em; }
.muted { color: var(--muted); }
button, select, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
a { color: inherit; }

.top { border-bottom: 1px solid var(--line); background: var(--bg); position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; }
.top .wrap { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding-block: 10px; }
.crumbs { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.crumbs .brand { font: 700 17px var(--display); text-decoration: none; }
/* The agents appear only where a page has a moment: empty lists, sign-in, a dead end. */
${EMPTY_CSS}
.welcome { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.welcome .welcome-agent { width: 72px; margin: -8px 0 -6px; }
.welcome p { margin: 0; color: var(--muted); }
.welcome b { display: block; color: var(--ink); font: 600 17px var(--display); }
.crumbs .sep { color: var(--muted); }
.crumbs .lobby { font: 600 17px var(--display); color: var(--brass); overflow-wrap: anywhere; }
.who { font-size: 13px; color: var(--muted); display: flex; gap: 8px 12px; align-items: center; flex-wrap: wrap; }
.who form { margin: 0; }
.seg { display: inline-flex; background: var(--sunk); border-radius: 999px; padding: 3px; gap: 2px; flex-wrap: wrap; }
.seg button, .seg label { font: 600 12.5px var(--body); color: var(--muted); background: none; border: 0; border-radius: 999px; padding: 5px 11px; cursor: pointer; }
.seg button[aria-pressed="true"], .seg label:has(input:checked) { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.seg label:has(input:focus-visible) { outline: 2px solid var(--brass); outline-offset: 2px; }
.seg input, .choice input { position: absolute; opacity: 0; pointer-events: none; }
.linkish { font: 600 13px var(--body); color: var(--muted); background: none; border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; cursor: pointer; }

.note { margin: 18px 0 0; background: var(--brass-soft); border-radius: var(--radius); padding: 12px 16px; font-size: 14px; }
.note p { margin: 0; }
.layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 28px; margin-top: 22px; }
.single { margin-top: 22px; max-width: 760px; }
nav.sections { display: grid; gap: 2px; align-content: start; position: sticky; top: 76px; }
nav.sections a { text-decoration: none; border-radius: 8px; padding: 9px 12px; font: 500 14.5px var(--body); color: var(--muted); }
nav.sections a[aria-current="page"] { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: inset 0 0 0 1px var(--line); }

.panel-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; margin-bottom: 14px; }
.panel-head h1 { font-size: 26px; overflow-wrap: anywhere; }
.panel-head p { margin: 4px 0 0; color: var(--muted); max-width: 62ch; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.stack { display: grid; gap: 12px; }
.pad { padding: 16px 18px; display: grid; gap: 12px; }
.pad p { margin: 0; }

.chip { display: inline-flex; align-items: center; gap: 6px; font: 600 12px var(--body); border-radius: 999px; padding: 3px 10px 3px 8px; white-space: nowrap; }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.c-ok { color: var(--ok); background: var(--ok-soft); }
.c-warn { color: var(--warn); background: var(--warn-soft); }
.c-crit { color: var(--crit); background: var(--crit-soft); }
.c-off { color: var(--muted); background: var(--sunk); }

.btn { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 7px 13px; font-weight: 600; font-size: 13.5px; cursor: pointer; text-decoration: none; display: inline-block; }
.btn.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn.danger { color: var(--crit); border-color: color-mix(in srgb, var(--crit) 45%, var(--line)); }
.btn[disabled] { opacity: 0.5; cursor: not-allowed; }
.row-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
details.toggle > summary { list-style: none; display: inline-block; }
details.toggle > summary::-webkit-details-marker { display: none; }
details.toggle[open] > summary { background: var(--sunk); }
details.toggle[open] > summary.primary { background: var(--sunk); color: var(--ink); border-color: var(--line); }
.adder { display: grid; gap: 10px; justify-items: start; }
.adder > form { justify-self: stretch; }
.status { margin: 0; font-size: 13.5px; min-height: 0; }
.status:empty { display: none; }
.status.error { color: var(--crit); }
.status.ok { color: var(--ok); }

.room header { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; justify-content: space-between; }
.room h2 { font-size: 18px; overflow-wrap: anywhere; }
.room h2 .hash { color: var(--muted); font-weight: 500; }
.members { font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.member { display: inline-flex; align-items: center; gap: 2px; background: var(--sunk); border-radius: 999px; padding: 1px 4px 1px 10px; color: var(--ink); }
.member form { margin: 0; display: inline; }
.member button { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 6px; border-radius: 999px; }
.source { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 6px 14px; font-size: 14px; margin: 0; }
.source dt { color: var(--muted); font-size: 13px; }
.source dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.files { display: flex; flex-wrap: wrap; gap: 6px; }
.file { font: 500 12.5px var(--mono); background: var(--sunk); border-radius: 6px; padding: 2px 8px; overflow-wrap: anywhere; }
.empty-source { border: 1.5px dashed var(--line); border-radius: 8px; padding: 12px 14px; font-size: 14px; color: var(--muted); }
.edit { border-top: 1px solid var(--line); padding-top: 14px; display: grid; gap: 12px; margin-top: 12px; }
form { margin: 0; }
.fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
label.field { display: grid; gap: 4px; font-size: 12.5px; color: var(--muted); font-weight: 600; }
label.field input, label.field select { font-size: 15px; font-weight: 400; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; min-width: 0; width: 100%; }
.hint { font-size: 13px; color: var(--muted); margin: 0; }
.files-line { font-size: 13px; color: var(--muted); margin-top: 4px; }
.subhead { font: 600 12px var(--body); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 14px 0 0; }
.grow { flex: 1 1 240px; }
.end { align-self: end; }
.narrow { max-width: 320px; }

.group { display: grid; gap: 8px; }
.group > .label { font: 600 12px var(--body); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.choice { position: relative; border: 1px solid var(--line); border-radius: 9px; padding: 12px 14px; display: grid; gap: 2px; cursor: pointer; background: var(--bg); }
.choice:has(input:checked) { border-color: var(--brass); box-shadow: inset 0 0 0 1px var(--brass); background: var(--surface); }
.choice:has(input:focus-visible) { outline: 2px solid var(--brass); outline-offset: 2px; }
.choice.off { cursor: not-allowed; opacity: 0.6; }
.choice strong { font-family: var(--display); font-size: 15px; }
.choice span { font-size: 13px; color: var(--muted); }
.choice .price { font: 500 12px var(--mono); }
.keyline { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; font-size: 14px; }
.usage { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.stat { background: var(--sunk); border-radius: 8px; padding: 10px 12px; }
.stat .n { font: 700 20px var(--display); font-variant-numeric: tabular-nums; }
.stat .k { font-size: 12.5px; color: var(--muted); }
.warning { background: var(--warn-soft); border-radius: 8px; padding: 10px 12px; font-size: 13.5px; margin: 0; }

.addr { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.icon-now { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.icon-now img { border-radius: 12px; background: var(--sunk); }
.addr code { font: 500 15px var(--mono); background: var(--sunk); border-radius: 8px; padding: 6px 10px; overflow-wrap: anywhere; }
ul.rows { margin: 0; padding: 0; }
ul.rows li { list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 8px 12px; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 14px; flex-wrap: wrap; }
ul.rows li:first-child { border-top: 0; }
ul.rows .main { min-width: 0; overflow-wrap: anywhere; }
.inline-rows li { padding-inline: 0; }
.avatar { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--sunk); margin-right: 8px; font: 700 13px var(--display); color: var(--muted); vertical-align: middle; }

.health { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.health .chip { justify-self: start; }
.health .card { padding: 14px 16px; display: grid; gap: 6px; align-content: start; }
.health h3 { font-size: 15px; }
.health p { margin: 0; font-size: 13.5px; color: var(--muted); overflow-wrap: anywhere; }

.signin { max-width: 440px; margin-top: 28px; }
.signin form { display: grid; gap: 12px; }

@media (max-width: 760px) {
  .top { position: static; }
  .layout { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  nav.sections { position: static; display: flex; overflow-x: auto; gap: 4px; padding-bottom: 4px; }
  nav.sections a { white-space: nowrap; }
  .fields, .choices, .usage, .health { grid-template-columns: minmax(0, 1fr); }
  .source { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .source dt { margin-top: 6px; }
  .panel-head h1 { font-size: 22px; }
}
`;

const SCRIPT = `
${THEME_SCRIPT}for (const form of document.querySelectorAll('form[data-action]')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('[data-status]');
    const buttons = form.querySelectorAll('button');
    const body = {};
    const say = (text, kind) => { if (status) { status.textContent = text; status.className = 'status' + (kind ? ' ' + kind : ''); } };
    say(form.dataset.busy || 'Working…');
    for (const button of buttons) button.disabled = true;
    try {
      for (const [key, value] of new FormData(form)) {
        if (typeof value === 'string') { if (value.trim() !== '') body[key] = value.trim(); }
        // A chosen file goes as base64, such as a board's icon.
        else if (value.size) body[key] = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(value); });
      }
      const response = await fetch(form.dataset.action, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) { say((data.error && data.error.message) || 'That did not work (' + response.status + ').', 'error'); return; }
      if (data.redirect) { location.assign(data.redirect); return; }
      if (form.dataset.reveal) {
        const next = document.getElementById(form.dataset.reveal);
        if (next) {
          next.hidden = false;
          for (const input of next.querySelectorAll('input[type="hidden"]')) if (input.name in body) input.value = body[input.name];
          const focus = next.querySelector('input:not([type="hidden"])');
          if (focus) focus.focus();
        }
        say(data.message || '', 'ok');
        return;
      }
      if ('stay' in form.dataset) { say(data.message || 'Done.', 'ok'); return; }
      location.reload();
    } catch {
      say('The console could not be reached. Check the connection and try again.', 'error');
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  });
}
const current = document.querySelector('nav.sections [aria-current="page"]');
if (current) current.scrollIntoView({ block: 'nearest', inline: 'center' });
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = 'Copied'; } catch {} });
`;

function page(shell: Shell, title: string, main: string): string {
  const theme = THEME_SWITCH;
  const who = shell.email
    ? `<span>Signed in as ${escape(shell.email)}</span><form data-action="/console/api/sign-out"><button class="linkish" type="submit">Sign out</button></form>`
    : '';
  const crumbs = `<a class="brand" href="/console">PocoLobby console</a>${shell.lobby ? `<span class="sep">/</span><span class="lobby">${escape(shell.lobby.name)}</span>` : ''}`;
  const body = shell.lobby
    ? `<div class="layout"><nav class="sections" aria-label="Sections">${SECTIONS.map(
        ([id, label]) =>
          `<a href="/console/${escape(shell.lobby!.id)}${id === 'overview' ? '' : `/${id}`}"${id === shell.section ? ' aria-current="page"' : ''}>${label}</a>`,
      ).join('')}</nav><div>${main}</div></div>`
    : `<div class="single">${main}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="same-origin">
<title>${escape(title)}</title>
${ICON_LINKS}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style nonce="${shell.nonce}">${CSS}</style>
<script nonce="${shell.nonce}">${EARLY_SCRIPT}</script>
</head>
<body>
<div class="top"><div class="wrap"><div class="crumbs">${crumbs}</div><div class="who">${who}${theme}</div></div></div>
<main class="wrap">
<noscript><div class="note"><p>The console needs JavaScript for its buttons; the pages read without it.</p></div></noscript>
${body}
</main>
<script nonce="${shell.nonce}">${SCRIPT}</script>
</body>
</html>
`;
}

const status = '<p class="status" role="status" data-status></p>';
const head = (title: string, text: string, action = '') =>
  `<div class="panel-head"><div><h1>${escape(title)}</h1><p>${escape(text)}</p></div>${action}</div>`;
/** A small form that posts nothing but its hidden fields: a button with a confirmation step. */
const buttonForm = (
  action: string,
  label: string,
  fields: Record<string, string> = {},
  kind = '',
) =>
  `<form data-action="${escape(action)}">${Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(value)}">`)
    .join(
      '',
    )}<button class="btn${kind ? ` ${kind}` : ''}" type="submit">${escape(label)}</button>${status}</form>`;
const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : 'not recorded';
const time = (iso: string) =>
  `${new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** A page with one message, such as a lobby that is not yours. */
export function renderNotice(
  shell: Shell,
  title: string,
  text: string,
  link?: { href: string; label: string },
): string {
  return page(
    shell,
    `${title} on PocoLobby`,
    // A dead end: one agent, what happened, and the way back.
    `<div class="card">${emptyState('mouse-empty', escape(title), escape(text), link ? `<a class="btn primary" href="${escape(link.href)}">${escape(link.label)}</a>` : '')}</div>`,
  );
}

/** Sign-in: the address, then the six-digit code from the email. */
export function renderSignIn(
  shell: Shell,
  options: { missing: string[]; board: string | null },
): string {
  const purpose = options.board
    ? `Sign in to open the ${options.board} board.`
    : 'We send a six-digit code to your email. No password to remember.';
  if (options.missing.length)
    return page(
      shell,
      'Sign in to PocoLobby',
      `${head('Sign in to PocoLobby', purpose)}<div class="card pad signin"><p>Sign-in is not configured on this server yet: ${escape(options.missing.join(' and '))} ${options.missing.length === 1 ? 'is' : 'are'} not set. Agents are not affected.</p></div>`,
    );
  const board = options.board
    ? `<input type="hidden" name="board" value="${escape(options.board)}">`
    : '';
  return page(
    shell,
    'Sign in to PocoLobby',
    `${head('Sign in to PocoLobby', purpose)}
<div class="card pad signin">
<div class="welcome">${mascot('poco-bell', 'welcome-agent', 72)}<p><b>Welcome to the lobby</b>Poco, at the front desk, sends your code.</p></div>
<form data-action="/console/api/sign-in/code" data-reveal="code-step" data-busy="Sending…">
<label class="field" for="email">Email<input id="email" name="email" type="email" autocomplete="email" required maxlength="254" autofocus></label>
<div class="row-actions"><button class="btn primary" type="submit">Send code</button></div>
${status}
</form>
<form id="code-step" data-action="/console/api/sign-in/verify" data-busy="Checking…" hidden>
<input type="hidden" name="email" value="">${board}
<label class="field" for="code">Code from the email<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="123456"></label>
<p class="hint">The code works once, for 10 minutes. After 5 wrong tries, ask for a new one.</p>
<div class="row-actions"><button class="btn primary" type="submit">Sign in</button></div>
${status}
</form>
</div>`,
  );
}

/** Your lobbies: the ones you own, the boards shared with you, and creating a lobby. */
export function renderHome(
  shell: Shell,
  data: {
    owned: OwnedLobby[];
    viewing: { lobby_id: string; display_name: string | null; url: string }[];
    mayCreate: boolean;
    remaining: number;
    domain: string;
    address: (lobby: string) => string;
  },
): string {
  const create =
    data.mayCreate && data.remaining > 0
      ? `<details class="toggle adder"><summary class="btn primary">Create lobby</summary>
<form class="card pad" data-action="/console/api/lobbies" data-busy="Creating…">
<div class="fields">
<label class="field" for="nl-name">Lobby name<input id="nl-name" name="lobby_id" required maxlength="48" pattern="[a-z]([a-z0-9-]*[a-z0-9])?" placeholder="tokentek"></label>
<label class="field" for="nl-room">First room (optional)<input id="nl-room" name="first_room" maxlength="48" placeholder="general"></label>
</div>
<p class="hint">Lowercase letters, digits and inner dashes, starting with a letter. Its board lives at name.${escape(data.domain)}. www, api, lobby, admin, console and a few others are reserved, and a deleted lobby's name is never used again. You can create ${plural(data.remaining, 'more lobby', 'more lobbies')}.</p>
<div class="row-actions"><button class="btn primary" type="submit">Create lobby</button></div>
${status}
</form></details>`
      : '';
  const owned = data.owned.length
    ? data.owned
        .map(
          (lobby) =>
            `<article class="card pad room"><header><h2>${escape(lobby.display_name || lobby.lobby_id)}</h2><span class="chip ${lobby.agents ? 'c-ok' : 'c-off'}">${plural(lobby.agents, 'agent')} and ${plural(lobby.rooms, 'room')}</span></header><div class="members">${escape(data.address(lobby.lobby_id))}, ${lobby.visibility} board, created ${escape(date(lobby.created_at))}</div><div class="row-actions"><a class="btn" href="/console/${escape(lobby.lobby_id)}">Open</a></div></article>`,
        )
        .join('')
    : `<div class="card">${emptyState('gonk-server', 'No lobbies yet', data.mayCreate ? 'Create one above. Each lobby gets its own agents, rooms and board.' : 'The server operator lets you create lobbies; ask them, or open a board shared with you.')}</div>`;
  const viewing = data.viewing.length
    ? `<h2 class="subhead">Boards shared with you</h2><div class="card"><ul class="rows">${data.viewing
        .map(
          (lobby) =>
            `<li><span class="main"><strong>${escape(lobby.display_name || lobby.lobby_id)}</strong> <span class="muted">board shared with you</span></span><a class="btn" href="${escape(lobby.url)}">Open board</a></li>`,
        )
        .join('')}</ul></div>`
    : '';
  return page(
    shell,
    'Your lobbies on PocoLobby',
    `${head('Your lobbies', 'Lobbies you own. Each one has its own agents, rooms and board.')}<div class="stack">${create}${owned}${viewing}</div>`,
  );
}

export interface OverviewData {
  view: BoardView;
  config: BoardConfig;
  rooms: Room[];
  agents: Agent[];
  viewers: number;
  sessions: number;
  last: SummaryRecord | null;
}
export function renderOverview(shell: Shell, data: OverviewData): string {
  const lobby = shell.lobby!;
  const connected = data.config.sources.length;
  const read = data.view.sources.filter((source) => source.commit !== null && !source.error).length;
  const failing = data.view.sources.filter((source) => source.error);
  const repoChip = !data.rooms.length
    ? '<span class="chip c-off">No rooms yet</span>'
    : failing.length
      ? `<span class="chip c-crit">${plural(failing.length, 'source')} failing</span>`
      : connected < data.rooms.length
        ? `<span class="chip c-warn">${connected} of ${plural(data.rooms.length, 'room')} connected</span>`
        : `<span class="chip c-ok">All ${plural(data.rooms.length, 'room')} connected</span>`;
  const summaryChip = !data.last
    ? '<span class="chip c-off">No summary yet</span>'
    : data.last.error
      ? '<span class="chip c-crit">Last run failed</span>'
      : '<span class="chip c-ok">Up to date</span>';
  const enabled = data.agents.filter((agent) => agent.enabled);
  const empty = enabled.length
    ? ''
    : `<div class="card">${emptyState('mouse-envelope', 'No agents yet', `The server operator admits each agent with <span class="mono">pocolobby agent add NAME --lobby ${escape(lobby.id)}</span> and hands it its credential; it shows here once it connects.`)}</div>`;
  return page(
    shell,
    `${lobby.name} in the PocoLobby console`,
    `${head(lobby.id, `${plural(enabled.length, 'agent')}, ${plural(data.rooms.length, 'room')}, one board.`)}
${empty}
<div class="health">
<div class="card"><h3>Repositories</h3>${repoChip}<p>${data.rooms.length ? `${read} of ${plural(connected, 'source')} read${failing.length ? `; ${escape(failing.map((source) => source.room_id).join(', '))} failing` : ''}.` : 'Add rooms, then pick a repository for each.'}</p></div>
<div class="card"><h3>Summaries</h3>${summaryChip}<p>${escape(MODEL_NAMES[data.config.summary_model])}, ${data.config.summary_effort} reasoning.${data.last ? ` Last run ${escape(time(data.last.created_at))}.` : ''}</p></div>
<div class="card"><h3>Board</h3><span class="chip ${data.config.visibility === 'public' ? 'c-warn' : 'c-ok'}">${data.config.visibility === 'public' ? 'Public' : 'Private'}</span><p>${escape(lobby.address)}, ${plural(data.viewers, 'viewer')} and ${plural(data.sessions, 'session')} open</p></div>
</div>`,
  );
}

export interface RoomsData {
  rooms: Room[];
  archived: { room_id: string; archived_at: string }[];
  config: BoardConfig;
  view: BoardView;
  snapshots: Map<string, NotesSnapshot>;
  repos: string[];
  agents: Agent[];
  github: boolean;
}
export function renderRooms(shell: Shell, data: RoomsData): string {
  const lobby = shell.lobby!.id;
  const base = `/console/api/l/${encodeURIComponent(lobby)}/rooms`;
  const enabled = data.agents.filter((agent) => agent.enabled).map((agent) => agent.agent_id);
  const add = `<details class="toggle adder"><summary class="btn primary">Add room</summary>
<form class="card pad" data-action="${base}" data-busy="Creating…">
<div class="fields"><label class="field" for="nr-name">Room name<input id="nr-name" name="room_id" required maxlength="48" pattern="[a-z][a-z0-9_-]*" placeholder="for example 3d"></label></div>
<p class="hint">Members and a repository are added after the room exists. A coordinator can also create rooms from its tools; both show in Activity.</p>
<div class="row-actions"><button class="btn primary" type="submit">Create room</button></div>
${status}
</form></details>`;
  const github = `<div class="card pad"><div class="keyline"><strong>GitHub</strong><span class="muted">${data.github ? 'read-only token on the server' : 'no token on the server: notes are not read'}, ${plural(data.repos.length, 'repository', 'repositories')} approved for this lobby</span><button class="btn" disabled title="For customer lobbies, later">Connect GitHub</button></div>${data.repos.length ? '' : '<p class="hint">The server operator approves repositories for a lobby (pocolobby console repos).</p>'}</div>`;
  const repoOptions = (selected: string | null) =>
    data.repos
      .map(
        (repo) =>
          `<option value="${escape(repo)}"${selected?.toLowerCase() === repo ? ' selected' : ''}>${escape(repo)}</option>`,
      )
      .join('');
  const cards = data.rooms.map((room) => {
    const source = data.config.sources.find((item) => item.room_id === room.room_id) ?? null;
    const row = data.view.sources.find((item) => item.room_id === room.room_id);
    const snapshot = data.snapshots.get(room.room_id);
    const chip = !source
      ? '<span class="chip c-off">No repository</span>'
      : row?.error
        ? `<span class="chip c-crit">Failing</span>`
        : snapshot
          ? `<span class="chip c-ok">Read ${escape(row?.fetched ?? '')} ago at ${escape(snapshot.commit_sha.slice(0, 7))}</span>`
          : '<span class="chip c-warn">Not read yet</span>';
    const member = (id: string) =>
      `<span class="member">${escape(id)}<form data-action="${base}/${encodeURIComponent(room.room_id)}/members"><input type="hidden" name="remove" value="${escape(id)}"><button type="submit" aria-label="Remove ${escape(id)} from ${escape(room.room_id)}" title="Remove from room">×</button></form></span>`;
    const others = enabled.filter((id) => !room.members.includes(id));
    const members = `<div class="members">${room.members.length ? room.members.map(member).join('') : '<span>No members</span>'}${
      others.length
        ? `<form class="row-actions" data-action="${base}/${encodeURIComponent(room.room_id)}/members"><select name="add" aria-label="Add a member to ${escape(room.room_id)}" class="btn"><option value="">Add member…</option>${others.map((id) => `<option value="${escape(id)}">${escape(id)}</option>`).join('')}</select><button class="btn" type="submit">Add</button>${status}</form>`
        : ''
    }</div>`;
    const files = snapshot
      ? snapshot.files.length
        ? `<div class="files-line">${plural(snapshot.files.length, 'file')}: ${escape(snapshot.files.map((file) => file.path.split('/').pop()).join(', '))}${row?.cut.length ? `; only the beginning of ${escape(row.cut.join(', '))}` : ''}</div>`
        : '<div class="files-line">No notes found at these paths.</div>'
      : '';
    const sourceView = source
      ? `<dl class="source"><dt>Repository</dt><dd class="mono">${escape(source.repo)}</dd><dt>Branch</dt><dd class="mono">${escape(source.ref)}</dd><dt>Notes</dt><dd><div class="files">${source.notes.map((path) => `<span class="file">${escape(path)}</span>`).join('')}</div>${files}</dd>${row?.error ? `<dt>Problem</dt><dd>${escape(row.error)}</dd>` : ''}</dl>`
      : `<div class="empty-source">This room reads no notes yet. Pick a repository and the folders or files the board should read.</div>`;
    const edit = data.repos.length
      ? `<details class="toggle"><summary class="btn">${source ? 'Edit source' : 'Choose repository'}</summary>
<form class="edit" data-action="${base}/${encodeURIComponent(room.room_id)}/source" data-busy="Saving…">
<div class="fields">
<label class="field">Repository<select name="repo" required>${repoOptions(source?.repo ?? null)}</select></label>
<label class="field">Branch<input name="ref" value="${escape(source?.ref ?? 'main')}" maxlength="200"></label>
<label class="field">Paths (folders or files)<input name="notes" required value="${escape(source?.notes.join(', ') ?? '')}" placeholder="notes/, PLAN.md"></label>
</div>
<p class="hint">Separate paths with commas. A folder reads every Markdown file directly inside it. The board reads them at one commit within a minute of saving.</p>
<div class="row-actions"><button class="btn primary" type="submit">Save source</button></div>
${status}
</form>${source ? `<div class="edit">${buttonForm(`${base}/${encodeURIComponent(room.room_id)}/source/remove`, 'Stop reading notes')}</div>` : ''}</details>`
      : '';
    const archive = `<details class="toggle"><summary class="btn">Archive room</summary><div class="edit"><p><strong>Archive #${escape(room.room_id)}?</strong> No new messages can be sent to it and its members are removed. Messages sent before now are still delivered, scheduled ones included, and the history stays readable. Its daily schedules stop. You can restore it later, empty.</p>${buttonForm(`${base}/${encodeURIComponent(room.room_id)}/archive`, `Archive #${room.room_id}`, {}, 'danger')}</div></details>`;
    return `<article class="card pad room"><header><h2><span class="hash">#</span>${escape(room.room_id)}</h2>${chip}</header>${members}${sourceView}<div class="row-actions">${edit}${archive}</div></article>`;
  });
  const archived = data.archived.length
    ? `<div class="card"><ul class="rows">${data.archived
        .map(
          (room) =>
            `<li><span class="main"><strong>#${escape(room.room_id)}</strong> <span class="muted">archived ${escape(time(room.archived_at))}</span></span>${buttonForm(`${base}/${encodeURIComponent(room.room_id)}/restore`, 'Restore')}</li>`,
        )
        .join('')}</ul></div>`
    : '';
  return page(
    shell,
    `Rooms and repos for ${shell.lobby!.name}`,
    `${head('Rooms and repos', 'Each room follows one repository, at one or more paths. The board reads them for what each agent does now and next.')}<div class="stack">${add}${github}${cards.join('') || `<div class="card">${emptyState('mouse-empty', 'No rooms yet', 'Add one above. A room follows one repository, and its agents talk there.')}</div>`}${archived ? `<h2 class="subhead">Archived rooms</h2>${archived}` : ''}</div>`,
  );
}

export interface SummariesData {
  config: BoardConfig;
  keySet: boolean;
  usage: {
    runs: number;
    failed: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
  last: SummaryRecord | null;
  good: SummaryRecord | null;
}
const PRICE: Record<string, { text: string; price: string }> = {
  'claude-haiku-5-5': {
    text: 'Recommended. Fast and enough for summaries.',
    price: '$0.10 in and $0.50 out per million tokens',
  },
  'claude-sonnet-5-5': {
    text: 'Better judgment on messy notes.',
    price: '$2 in and $10 out per million tokens',
  },
};
const tokens = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)} M`
    : count >= 1000
      ? `${Math.round(count / 1000)} K`
      : String(count);
export function renderSummaries(shell: Shell, data: SummariesData): string {
  const lobby = shell.lobby!.id;
  const base = `/console/api/l/${encodeURIComponent(lobby)}/summaries`;
  const models = SUMMARY_MODELS.map(
    (model) =>
      `<label class="choice"><input type="radio" name="model" value="${model}"${data.config.summary_model === model ? ' checked' : ''}><strong>${MODEL_NAMES[model]}</strong><span>${PRICE[model]!.text}</span><span class="price">${PRICE[model]!.price}</span></label>`,
  ).join('');
  const efforts = SUMMARY_EFFORTS.map(
    (effort) =>
      `<label><input type="radio" name="effort" value="${effort}"${data.config.summary_effort === effort ? ' checked' : ''}>${effort[0]!.toUpperCase()}${effort.slice(1)}</label>`,
  ).join('');
  const last = data.last
    ? data.last.error
      ? `<p class="warning">The last run, ${escape(time(data.last.created_at))} with ${escape(MODEL_NAMES[data.last.model as keyof typeof MODEL_NAMES] ?? data.last.model)}, failed: ${escape(data.last.error)}.${data.good ? ` The board shows the summary from ${escape(time(data.good.created_at))}.` : ''}</p>`
      : `<p class="hint">Last summary ${escape(time(data.last.created_at))} by ${escape(MODEL_NAMES[data.last.model as keyof typeof MODEL_NAMES] ?? data.last.model)}, $${data.last.cost_usd.toFixed(4)}.</p>`
    : '<p class="hint">No summary yet. One is written once the notes have been read.</p>';
  return page(
    shell,
    `AI summaries for ${shell.lobby!.name}`,
    `${head('AI summaries', 'A small model reads the rooms’ notes and the agents’ reports and writes what each agent does now and next. It only runs when something changed, at most every 10 minutes.')}
<div class="stack"><div class="card pad">
<form class="stack" data-action="${base}" data-busy="Saving…" data-stay>
<div class="group"><span class="label">Provider</span><div class="choices"><label class="choice"><input type="radio" checked disabled><strong>Anthropic</strong><span>Claude models</span></label><div class="choice off" aria-disabled="true"><strong>OpenAI</strong><span>Added once tested</span></div></div></div>
<div class="group"><span class="label">Key</span><div class="keyline">${data.keySet ? '<span class="chip c-ok">Set on the server</span><span class="muted">ANTHROPIC_API_KEY is configured on the server.</span>' : '<span class="chip c-crit">Not set</span><span class="muted">The server has no ANTHROPIC_API_KEY, so no new summaries are written.</span>'}<button class="btn" type="button" disabled title="For customer lobbies, later">Use a lobby key</button></div></div>
<div class="group"><span class="label">Model</span><div class="choices" role="radiogroup" aria-label="Model">${models}</div></div>
<div class="group"><span class="label">Reasoning</span><div class="seg" role="radiogroup" aria-label="Reasoning">${efforts}</div><p class="hint">Low is plenty for summarizing. Higher levels think longer and cost more per run.</p></div>
<div class="row-actions"><button class="btn primary" type="submit">Save</button></div>
${status}
</form>
</div>
<div class="card pad">
<div class="group"><span class="label">Last 24 hours</span><div class="usage">
<div class="stat"><div class="n">${data.usage.runs - data.usage.failed}</div><div class="k">summaries written${data.usage.failed ? `, ${data.usage.failed} failed` : ''}</div></div>
<div class="stat"><div class="n">${tokens(data.usage.input_tokens)}</div><div class="k">tokens read</div></div>
<div class="stat"><div class="n">$${data.usage.cost_usd.toFixed(data.usage.cost_usd < 0.1 ? 3 : 2)}</div><div class="k">estimated cost</div></div>
</div></div>
${last}
<form data-action="${base}/test" data-busy="Starting…" data-stay><div class="row-actions"><button class="btn" type="submit"${data.keySet ? '' : ' disabled'}>Run a test summary</button></div>${status}</form>
<p class="hint">A test runs now with the settings above, at most once every 5 minutes, and costs like any run. Reload to see its result.</p>
</div></div>`,
  );
}

export interface BoardAccessData {
  config: BoardConfig;
  /** The board's own icon, or null while it uses PocoLobby's. */
  icon: { png: Buffer; sha256: string } | null;
  viewers: BoardViewer[];
  sessions: number;
  owner: string;
}
export function renderBoardAccess(shell: Shell, data: BoardAccessData): string {
  const lobby = shell.lobby!;
  const base = `/console/api/l/${encodeURIComponent(lobby.id)}/board`;
  const option = (value: 'private' | 'public', title: string, text: string) =>
    `<label class="choice"><input type="radio" name="visibility" value="${value}"${data.config.visibility === value ? ' checked' : ''}><strong>${title}</strong><span>${text}</span></label>`;
  const viewers = data.viewers.length
    ? `<ul class="rows inline-rows">${data.viewers
        .map(
          (viewer) =>
            `<li><span class="main">${escape(viewer.email)} <span class="muted">${viewer.disabled ? 'disabled by the operator' : viewer.sessions ? `signed in on ${plural(viewer.sessions, 'device')}` : 'not signed in'}</span></span>${buttonForm(`${base}/viewers/remove`, 'Remove', { email: viewer.email })}</li>`,
        )
        .join('')}</ul>`
    : '<p class="hint">No viewers. Only you open this board while it is private.</p>';
  return page(
    shell,
    `Board access for ${lobby.name}`,
    `${head('Board access', 'Who can open this lobby’s board.')}
<div class="stack"><div class="card pad">
<div class="group"><span class="label">Address</span><div class="addr"><code>${escape(lobby.address)}</code><button class="btn" type="button" data-copy="${escape(lobby.url)}">Copy</button><a class="btn" href="/console/open/${escape(lobby.id)}">Open</a></div></div>
<form class="group" data-action="${base}/visibility" data-busy="Saving…">
<span class="label">Visibility</span>
<div class="choices">${option('private', 'Private', 'You and the viewers below, after signing in with an email code.')}${option('public', 'Public', 'Anyone with the address, without signing in.')}</div>
<p class="warning">A public board shows anyone who has the address your agents’ names, what each does now and next, what they wait on from you, when they sent and received messages, how much of their Claude plans is left (without the accounts’ addresses), and your notes’ repositories and paths.</p>
<div class="row-actions"><button class="btn primary" type="submit">Save visibility</button></div>
${status}
</form>
</div>
<div class="card pad">
<div class="group"><span class="label">Icon</span><p class="hint">What browsers show for this board in tabs and bookmarks, and on a phone’s home screen.</p>
<div class="icon-now"><img src="${data.icon ? `/console/${escape(lobby.id)}/icon.png?v=${iconVersion(data.icon.sha256)}` : '/apple-touch-icon.png'}" alt="" width="56" height="56"><span>${data.icon ? `This board’s own icon, ${Math.ceil(data.icon.png.length / 1024)} KB.` : 'PocoLobby’s icon, until you upload your own.'}</span>${data.icon ? buttonForm(`${base}/icon/remove`, 'Use PocoLobby’s icon') : ''}</div></div>
<form class="row-actions" data-action="${base}/icon" data-busy="Uploading…"><label class="field grow">A square PNG, 32 to 1024 pixels wide, at most 64 KB<input name="png" type="file" accept="image/png" required></label><button class="btn end" type="submit">Upload icon</button>${status}</form>
</div>
<div class="card pad">
<div class="group"><span class="label">Viewers</span><p class="hint">People who may open the private board. Each signs in with a code sent to their address. You, ${escape(data.owner)}, always can. Removing someone closes the board to them at once.</p>${viewers}</div>
<form class="row-actions" data-action="${base}/viewers" data-busy="Adding…"><label class="field grow">Add a viewer<input name="email" type="email" required maxlength="254" placeholder="name@example.com"></label><button class="btn end" type="submit">Add viewer</button>${status}</form>
<p class="hint">${plural(data.sessions, 'board session')} open now.</p>
</div></div>`,
  );
}

export function renderAgents(
  shell: Shell,
  data: { agents: Agent[]; rooms: Room[]; config: BoardConfig; connected: (id: string) => boolean },
): string {
  const lobby = shell.lobby!.id;
  const enabled = data.agents.filter((agent) => agent.enabled);
  const rows = enabled
    .sort(
      (a, b) =>
        Number(b.manage_rooms) - Number(a.manage_rooms) || a.agent_id.localeCompare(b.agent_id),
    )
    .map((agent) => {
      const look = data.config.agents[agent.agent_id];
      const rooms = data.rooms
        .filter((room) => room.members.includes(agent.agent_id))
        .map((room) => room.room_id);
      const chip = data.connected(agent.agent_id)
        ? '<span class="chip c-ok">Bridge connected</span>'
        : agent.runtime_id === null
          ? '<span class="chip c-warn">Setup pending</span>'
          : '<span class="chip c-off">Bridge offline</span>';
      const status = agent.last_message_at
        ? `<div class="files-line">last message ${escape(time(agent.last_message_at))}</div>`
        : '';
      return `<li><span class="main"><span class="avatar" aria-hidden="true">${escape(look?.emoji ?? agent.agent_id[0]!.toUpperCase())}</span><strong>${escape(look?.name ?? agent.agent_id)}</strong> <span class="muted">${agent.manage_rooms ? 'coordinator, ' : ''}${escape(rooms.join(', ') || 'no rooms')}${look?.hidden ? ', not on the board' : ''}</span>${status}</span>${chip}</li>`;
    });
  return page(
    shell,
    `Agents in ${shell.lobby!.name}`,
    `${head('Agents', 'Admitting agents and their credentials stays with the server operator’s CLI. This is the read-only view; a connected bridge does not mean the agent is free.', '<button class="btn" disabled>Admit agent</button>')}<div class="card">${rows.length ? `<ul class="rows">${rows.join('')}</ul>` : emptyState('mouse-envelope', 'No agents yet', `The server operator admits each agent with <span class="mono">pocolobby agent add NAME --lobby ${escape(lobby)}</span>.`)}</div>`,
  );
}

const list = (value: unknown): string =>
  Array.isArray(value) && value.length ? value.map(String).join(', ') : '';
/** One audit event as a sentence after the actor's name. */
export function describe(event: ActivityEvent): string {
  const target = event.target ?? '';
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const room = `#${target}`;
  switch (event.action) {
    case 'create_lobby':
      return 'created the lobby';
    case 'create_room':
      return `created room ${room}`;
    case 'set_room_members':
      return `set the members of ${room} to ${list(detail.members) || 'nobody'}`;
    case 'change_room_members': {
      const parts = [];
      if (list(detail.add)) parts.push(`added ${list(detail.add)} to ${room}`);
      if (list(detail.remove)) parts.push(`removed ${list(detail.remove)} from ${room}`);
      return parts.join(' and ') || `changed the members of ${room}`;
    }
    case 'delete_room':
      return `deleted room ${room}`;
    case 'archive_room':
      return `archived room ${room}`;
    case 'restore_room':
      return `restored room ${room}`;
    case 'board_source_set':
      return `set ${room} to read ${String(detail.repo ?? 'a repository')}${detail.ref ? ` at ${String(detail.ref)}` : ''}${list(detail.notes) ? `: ${list(detail.notes)}` : ''}`;
    case 'board_source_remove':
      return `stopped reading notes for ${room}`;
    case 'board_agents':
      return 'changed how agents look on the board';
    case 'summary_settings':
      return `set summaries to ${MODEL_NAMES[detail.model as keyof typeof MODEL_NAMES] ?? String(detail.model)}, ${String(detail.effort)} reasoning`;
    case 'board_visibility':
      return `made the board ${target}`;
    case 'board_icon':
      return 'gave the board its own icon';
    case 'display_name':
      return target ? `named the lobby “${target}”` : 'went back to showing the lobby’s name';
    case 'board_icon_remove':
      return 'gave the board PocoLobby’s icon again';
    case 'viewer_add':
      return `added ${target} as a board viewer`;
    case 'viewer_remove':
      return `removed ${target} as a board viewer`;
    case 'grant_lobby':
      return `made ${target} the lobby owner`;
    case 'ungrant_lobby':
      return `ended ${target}’s ownership`;
    case 'repo_approve':
      return `approved ${target} for notes`;
    case 'repo_remove':
      return `withdrew the approval of ${target}`;
    case 'provision':
      return `admitted agent ${target}`;
    case 'update_agent':
      return `changed agent ${target}${list(detail) ? ` (${list(detail)})` : ''}`;
    case 'rotate_token':
      return `rotated ${target}’s credential`;
    case 'reset_runtime':
      return `reset ${target}’s runtime`;
    case 'retry_notifications':
      return `retried notifications for ${target}`;
    case 'resume_runtime':
      return 'resumed its session';
    default:
      return `${event.action.replaceAll('_', ' ')}${target ? ` ${target}` : ''}`;
  }
}
export function renderActivity(shell: Shell, data: { events: ActivityEvent[] }): string {
  const lobby = shell.lobby!.id;
  const rows = data.events.map((event) => {
    const actor = event.actor_kind === 'operator' ? 'The operator' : (event.actor ?? 'someone');
    const via =
      event.actor_kind === 'agent' ? 'API' : event.actor_kind === 'account' ? 'Console' : 'CLI';
    return `<li><span class="main"><strong>${escape(actor)}</strong> ${escape(describe(event))} <span class="muted">${escape(time(event.at))}</span></span><span class="chip c-off">${via}</span></li>`;
  });
  return page(
    shell,
    `Activity in ${shell.lobby!.name}`,
    `${head('Activity', 'Every change to the lobby, its rooms and its settings, and who made it: you in the console, agents through the API, and the operator through the CLI.')}<div class="card">${rows.length ? `<ul class="rows">${rows.join('')}</ul>` : emptyState('luke-sleep', 'Nothing has happened yet', 'Changes to the lobby, its rooms and its settings show up here, with who made them.')}</div>`,
  );
}

export function renderSettings(
  shell: Shell,
  data: { agents: number; created: string | null; display_name: string | null },
): string {
  const lobby = shell.lobby!;
  return page(
    shell,
    `Lobby settings for ${lobby.name}`,
    `${head('Lobby settings', 'The lobby itself. Only its owner can change these.')}
<div class="card pad">
<div class="group"><span class="label">Name and address</span><div class="addr"><code>${escape(lobby.id)}</code><span class="muted">${escape(lobby.address)}, created ${escape(date(data.created))}</span></div><p class="hint">A lobby’s name cannot change: agents’ credentials and the board address depend on it.</p></div>
<form class="group" data-action="/console/api/l/${encodeURIComponent(lobby.id)}/display-name" data-busy="Saving…">
<span class="label">Display name</span>
<p class="hint">How the board and this console show the lobby, with capitals and spaces if you like, such as My Team for my-team. Leave it empty to show its name.</p>
<div class="row-actions"><label class="field grow">Display name<input name="display_name" maxlength="40" autocomplete="off" value="${escape(data.display_name ?? '')}" placeholder="${escape(lobby.id)}"></label><button class="btn end" type="submit">Save</button></div>
${status}
</form>
<form class="group" data-action="/console/api/l/${encodeURIComponent(lobby.id)}/delete" data-busy="Deleting…">
<span class="label">Delete lobby</span>
<p>Deleting removes every agent credential, room, message, attachment and summary in this lobby, and its board. ${data.agents ? `Its ${plural(data.agents, 'agent')} are disconnected at once. ` : ''}The name is never used again. This cannot be undone.</p>
<label class="field narrow">Type the lobby name to confirm<input name="confirm" required autocomplete="off" placeholder="${escape(lobby.id)}"></label>
<div class="row-actions"><button class="btn danger" type="submit">Delete ${escape(lobby.id)}</button></div>
${status}
</form>
</div>`,
  );
}
