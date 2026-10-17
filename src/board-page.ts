import { escape } from './html.js';
import { EMPTY_CSS, emptyState, mascot } from './mascots.js';
import { ICON_LINKS, lobbyIconLinks } from './icons.js';
import { age, CHIP_LABELS, type AgentRow, type BoardView, type UsageView } from './board.js';

/**
 * Server-rendered board pages (0.4.0). Every string from a
 * summary, a note, an owner request or the Host header goes through `escape`; the page is complete
 * without JavaScript, and its one script (by nonce) only switches the theme and swaps in a fresh
 * board fragment from /board.json: every few seconds while the board is updating, else every 10 seconds.
 */

export { escape };

export const FONTS =
  'https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';

/** The board's Content-Security-Policy for one response's nonce. */
export const boardCsp = (nonce: string): string =>
  [
    "default-src 'none'",
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

const DARK = `--bg: #0f1518; --surface: #162026; --sunk: #1c2830; --ink: #e6ebe8; --muted: #92a29c; --line: #26343c;
    --brass: #d8a94a; --brass-soft: #3a2f17;
    --ok: #4cb688; --ok-soft: #173329; --warn: #e39b3f; --warn-soft: #3a2a14;
    --crit: #e46b60; --crit-soft: #3d1d1b; --wait: #9296ec; --wait-soft: #24264a;
    color-scheme: dark;`;

/** Colors, type and the light and dark themes, shared by the board and the console (0.5.0). */
export const TOKENS = `
:root {
  --bg: #f4f6f3; --surface: #ffffff; --sunk: #eaeee9; --ink: #18221f; --muted: #5a6964; --line: #d9e0db;
  --brass: #9a6d14; --brass-soft: #f3e7cc;
  --ok: #24795a; --ok-soft: #dcefe6; --warn: #a8640f; --warn-soft: #f7e6cf;
  --crit: #b23b33; --crit-soft: #f6dcd9; --wait: #4f55a8; --wait-soft: #e1e3f6;
  --display: "Familjen Grotesk", "Helvetica Neue", Arial, sans-serif;
  --body: "Hanken Grotesk", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --radius: 10px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    ${DARK}
  }
}
:root[data-theme="dark"] {
  ${DARK}
}
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 var(--body); }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
`;

const CSS = `${TOKENS}
/* Layout: a concierge desk for agents. What waits on the owner up top, then each agent: its 24 hours of messages, what it does now and what comes next. Phone first. */
.wrap { max-width: 980px; margin: 0 auto; padding-block: 0 48px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
h1, h2, h3 { font-family: var(--display); margin: 0; text-wrap: balance; letter-spacing: -0.01em; }
.mono { font-family: var(--mono); font-size: 0.86em; }
.muted { color: var(--muted); }

.bar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); }
.bar .wrap { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; justify-content: space-between; padding-block: 10px; }
.brand { font: 600 13px var(--body); color: var(--muted); letter-spacing: 0.02em; }
/* The agents appear only where the board has a moment: nothing waits, all quiet, no agents. The
   usual moments get a slim row; an empty list gets the full empty state. */
${EMPTY_CSS}
.quiet { display: flex; align-items: center; gap: 12px; padding: 10px 16px; margin-bottom: 10px; }
.quiet .quiet-agent { width: 56px; margin: -8px 0; }
.quiet p { margin: 0; font-size: 14px; color: var(--muted); }
.quiet b { color: var(--ink); font-weight: 600; }
.seg { display: inline-flex; background: var(--sunk); border-radius: 999px; padding: 3px; gap: 2px; flex-wrap: wrap; }
.seg button { font: 600 13px var(--body); color: var(--muted); background: none; border: 0; border-radius: 999px; padding: 6px 12px; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.seg button:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }

.lobby { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; margin: 22px 0 16px; }
.lobby h1 { font-size: 28px; font-weight: 700; overflow-wrap: anywhere; }
.lobby h1 small { font: 500 14px var(--body); color: var(--muted); margin-left: 8px; letter-spacing: 0; }
.stamp { font-size: 13px; color: var(--muted); }
.stamp b { color: var(--ink); font-weight: 600; }
.source { font-size: 12px; color: var(--muted); margin-top: 28px; border-top: 1px solid var(--line); padding-top: 12px; display: grid; gap: 6px; }
.source p { margin: 0; }
.source form { margin: 4px 0 0; }
.source button { font: 600 12px var(--body); color: var(--muted); background: none; border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; cursor: pointer; }

.chip { display: inline-flex; align-items: center; gap: 6px; font: 600 12px var(--body); letter-spacing: 0.02em; border-radius: 999px; padding: 3px 10px 3px 8px; white-space: nowrap; }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.s-working { color: var(--ok); background: var(--ok-soft); }
.s-stalled { color: var(--crit); background: var(--crit-soft); }
.s-away { color: var(--muted); background: var(--sunk); }
.s-wait { color: var(--wait); background: var(--wait-soft); }
.s-coord { color: var(--brass); background: var(--brass-soft); }
.accounts { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(max(240px, calc((100% - 20px) / 3)), 1fr)); }
.account { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px 11px; display: grid; gap: 6px; min-width: 0; }
.account strong { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account .facts { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
.account .facts b { color: var(--ink); font-weight: 600; }
.week { display: block; width: 100%; height: 16px; }
.week .track { fill: var(--sunk); }
.week .used { fill: var(--ok); }
.week .behind { fill: color-mix(in srgb, var(--wait) 35%, var(--surface)); }
.week .ahead { fill: var(--warn); }
.week .far { fill: var(--crit); }
.week .now { fill: var(--ink); }
.flag { font: 600 11px var(--body); text-transform: uppercase; letter-spacing: 0.06em; color: var(--crit); }
.fact { font-size: 12px; color: var(--muted); }

.section-title { font: 600 12px var(--body); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 26px 0 10px; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.blank { padding: 12px 16px; font-size: 14px; color: var(--muted); margin: 0; }

.notices { list-style: none; margin: 10px 0 0; padding: 10px 14px; border-radius: var(--radius); background: var(--crit-soft); color: var(--ink); font-size: 13px; display: grid; gap: 4px; }
.notices li::before { content: "! "; color: var(--crit); font-weight: 700; }

.waitlist { display: grid; gap: 1px; background: var(--line); border-radius: var(--radius); overflow: hidden; border: 1px solid var(--line); }
.waitlist ol { margin: 0; padding: 0; }
.waitlist li { list-style: none; background: var(--surface); padding: 12px 16px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 12px; align-items: baseline; }
.waitlist .who { font-family: var(--display); font-weight: 600; white-space: nowrap; }
.waitlist .count { font: 600 12px var(--body); color: var(--wait); background: var(--wait-soft); border-radius: 999px; padding: 2px 9px; justify-self: start; }
.waitlist .what { grid-column: 1 / -1; font-size: 14px; overflow-wrap: anywhere; }
.waitlist .since { font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.agents { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.agent { background: var(--surface); display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 4px 12px; padding: 12px 16px; align-items: center; }
/* Level with the name line when the name, pills and state wrap onto two lines on a phone. */
.avatar { align-self: start; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-size: 20px; background: var(--sunk); box-shadow: inset 0 0 0 2.5px var(--ring, var(--line)); }
.avatar.initial { font: 700 17px var(--display); color: var(--muted); }
.ring-working { --ring: var(--ok); } .ring-stalled { --ring: var(--crit); } .ring-away { --ring: var(--line); }
.ring-wait { --ring: var(--wait); } .ring-coord { --ring: var(--brass); }
.agent .who { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; min-width: 0; }
/* The state chip and the activity wrap together, the activity at the row's right end, so on a phone
   they share the line under the name and pills (Johan). */
.agent .state { flex: 1 0 auto; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.agent .state .active { margin-left: auto; }
.agent .pills { display: contents; }
.agent .who strong { font-family: var(--display); font-size: 16px; }
.agent .now { grid-column: 2 / -1; font-size: 14px; min-width: 0; overflow-wrap: anywhere; }
.agent .stall { display: block; color: var(--crit); font-size: 12.5px; }
.agent .active { justify-self: end; font: 500 12px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.agent .next { grid-column: 2 / -1; font-size: 13.5px; color: var(--muted); min-width: 0; overflow-wrap: anywhere; }
.agent .next b { color: var(--ink); font-weight: 600; }
.agent .usage { grid-column: 2 / -1; font-size: 12.5px; color: var(--muted); min-width: 0; overflow-wrap: anywhere; display: flex; flex-wrap: wrap; column-gap: 14px; }
.pill { display: inline-flex; align-items: center; gap: 5px; font: 500 12.5px var(--body); color: var(--muted); background: var(--sunk); border-radius: 999px; padding: 3px 9px 3px 7px; white-space: nowrap; }
.pill svg { width: 13px; height: 13px; flex: none; }
.pill b { color: var(--ink); font-weight: 600; }
/* Effort colours: xhigh, the lobby's standard, in blue (Johan), so an agent set differently stands out. */
.pill.effort { font-weight: 600; color: var(--e); background: var(--e-soft); }
.e-low { --e: var(--crit); --e-soft: var(--crit-soft); }
.e-medium { --e: var(--warn); --e-soft: var(--warn-soft); }
.e-high { --e: var(--ok); --e-soft: var(--ok-soft); }
.e-xhigh { --e: var(--wait); --e-soft: var(--wait-soft); }
.e-max { --e: var(--brass); --e-soft: var(--brass-soft); }
.agent .usage b { color: var(--ink); font-weight: 600; }
.agent .usage .low { color: var(--crit); }
/* 96 quarter hours, oldest first: one bar per block, taller with more messages in and out. */
.strip { grid-column: 2 / -1; display: grid; grid-template-columns: repeat(96, minmax(0, 1fr)); gap: 1px; height: 22px; align-items: end; margin-top: 4px; }
.strip i { display: block; height: 3px; border-radius: 1px; background: var(--line); }
.strip i.l1 { height: 9px; background: color-mix(in srgb, var(--ok) 55%, var(--surface)); }
.strip i.l2 { height: 15px; background: color-mix(in srgb, var(--ok) 80%, var(--surface)); }
.strip i.l3 { height: 22px; background: var(--ok); }
.axis { background: var(--surface); display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 0 12px; padding: 10px 16px 6px; }
.axis .ticks { grid-column: 2 / -1; position: relative; height: 16px; font: 500 11px var(--mono); color: var(--muted); }
.axis .ticks span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
.axis .ticks .t-start { left: 0; transform: none; }
.axis .ticks .t-mid { left: 50%; }
.axis .ticks .t-end { left: 100%; transform: translateX(-100%); }
.legend { font-size: 12px; color: var(--muted); margin: 8px 2px 0; }

.login { max-width: 420px; }
.notice { display: grid; gap: 12px; padding: 18px 20px; }
.notice p { margin: 0; }
.button { justify-self: start; font: 600 15px var(--display); color: var(--bg); background: var(--ink); border-radius: 8px; padding: 10px 14px; text-decoration: none; }
.button:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }

@media (max-width: 640px) {
  .lobby h1 { font-size: 24px; }
  .agent, .axis { grid-template-columns: 40px minmax(0, 1fr) auto; }
  /* On a phone the name, the state and its activity share the first line and the pills take the second (Johan). */
  .agent .who { row-gap: 6px; }
  .agent { padding-top: 20px; }
  .agent .avatar { margin-top: -8px; } /* centred on the name line, overhanging it rather than pushing the pills down */
  .agent .pills { order: 1; flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; }
  .strip { gap: 0; }
}
@media (prefers-reduced-motion: no-preference) { .seg button { transition: background 0.15s, color 0.15s; } }
`;

/** The theme switch (System, Light, Dark), shown once the script runs; the console uses it too. */
export const THEME_SWITCH = `<div class="seg" role="group" aria-label="Theme" id="theme" hidden><button type="button" data-theme-choice="system" aria-pressed="true">System</button><button type="button" data-theme-choice="light" aria-pressed="false">Light</button><button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button></div>`;
/** Wires the theme switch and remembers the choice in this browser. */
export const THEME_SCRIPT = `const choices = document.querySelectorAll('[data-theme-choice]');
const applyTheme = (choice) => {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
  for (const b of choices) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
};
let saved = 'system';
try { saved = localStorage.getItem('lobby-theme') || 'system'; } catch {}
applyTheme(saved);
for (const b of choices) b.addEventListener('click', () => { applyTheme(b.dataset.themeChoice); try { localStorage.setItem('lobby-theme', b.dataset.themeChoice); } catch {} });
const themeGroup = document.getElementById('theme');
if (themeGroup) themeGroup.hidden = false;
`;
/** Applies a remembered theme before the first paint. */
export const EARLY_SCRIPT = `try{var t=localStorage.getItem('lobby-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
/**
 * The theme switch, and a fresh board fragment: every few seconds while the board is updating
 * (a visit starts the update), otherwise every 10 seconds and when the page is shown again.
 */
const BOARD_SCRIPT = `
${THEME_SCRIPT}const board = document.getElementById('board');
let timer = 0;
let busy = board && board.dataset.activity ? true : false;
const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, busy ? 4000 : 10000); };
async function refresh() {
  // A hidden tab stops asking; becoming visible again asks at once and restarts the timer.
  if (document.hidden) return;
  try {
    const response = await fetch('/board.json', { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) { location.reload(); return; }
    if (response.ok) {
      const data = await response.json();
      if (board && typeof data.html === 'string') { board.innerHTML = data.html; clock(); }
      busy = Boolean(data.activity);
    }
  } catch {}
  schedule();
}
// The history's axis in the viewer's own time: a label at each local 00, 06, 12 and 18 o'clock.
// Positions are set through the style object, which the page's style policy allows.
function clock() {
  const ticks = document.querySelector('.ticks');
  if (!ticks) return;
  const since = Number(ticks.dataset.since), slot = Number(ticks.dataset.slot), slots = Number(ticks.dataset.slots);
  const labels = [];
  for (let index = 1; index < slots; index++) {
    const at = new Date(since + index * slot);
    if (at.getMinutes() !== 0 || at.getHours() % 6 !== 0) continue;
    const label = document.createElement('span');
    label.textContent = String(at.getHours()).padStart(2, '0') + ':00';
    label.style.left = (index / slots) * 100 + '%';
    labels.push(label);
  }
  if (labels.length) ticks.replaceChildren(...labels);
  // The bars' times too, which the server writes in UTC.
  const hhmm = (at) => String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
  // Plan reset times: the time alone today, with the day and date otherwise.
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (const time of document.querySelectorAll('time[data-at]')) {
    const at = new Date(time.dateTime);
    if (Number.isNaN(at.getTime())) continue;
    time.textContent = (at.toDateString() === new Date().toDateString() ? '' : days[at.getDay()] + ' ' + at.getDate() + ' ' + months[at.getMonth()] + ', ') + hhmm(at);
  }
  for (const strip of document.querySelectorAll('.strip'))
    [...strip.children].forEach((cell, index) => {
      if (!cell.title) return;
      const start = new Date(since + index * slot);
      cell.title = cell.title.replace(/^.* UTC/, hhmm(start) + '–' + hhmm(new Date(start.getTime() + slot)));
    });
}
clock();
schedule();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
`;

/** A board host's page; `icon` is the version of the lobby's own icon, if it has one. */
function page(
  title: string,
  nonce: string,
  body: string,
  script: boolean,
  icon: string | null = null,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="same-origin">
<title>${escape(title)}</title>
${icon ? lobbyIconLinks(icon) : ICON_LINKS}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style nonce="${nonce}">${CSS}</style>
<script nonce="${nonce}">${EARLY_SCRIPT}</script>
</head>
<body>
${body}
${script ? `<script nonce="${nonce}">${BOARD_SCRIPT}</script>` : ''}
</body>
</html>
`;
}

/** One agent's quarter hours: a bar per block, by how many messages it sent or received. */
function strip(row: AgentRow, view: BoardView): string {
  const level = (count: number) => (count >= 4 ? 3 : count >= 2 ? 2 : count);
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const cells = row.traffic
    .map((slot, index) => {
      const count = slot.sent + slot.received;
      if (!count) return '<i></i>';
      const start = view.traffic.since_ms + index * view.traffic.slot_ms;
      return `<i class="l${level(count)}" title="${time(start)}–${time(start + view.traffic.slot_ms)} UTC: ${slot.sent} sent, ${slot.received} received"></i>`;
    })
    .join('');
  return `<div class="strip" role="img" aria-label="Messages over the last 24 hours: active ${escape(row.active)}">${cells}</div>`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A reset time in UTC until the page's script rewrites it in the viewer's own time. */
function resetTime(iso: string): string {
  const at = new Date(iso);
  const hhmm = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  return `<time datetime="${iso}" data-at>${DAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${hhmm} UTC</time>`;
}

/**
 * The account the agent runs on and what is left of its plan, each part spaced apart with no
 * separator (Johan: no "·"): "5h 62% left resets 18:40   Week 40% left resets Tue 21 Oct,
 * 09:00". Under a fifth left is marked.
 */
function usageLine(usage: UsageView, now: number): string {
  const window = (label: string, value: UsageView['five_hour']) =>
    value
      ? `${label} <b${value.left < 20 ? ' class="low"' : ''}>${value.left}% left</b> resets ${resetTime(value.resets_at)}`
      : '';
  const account = usage.account
    ? `${escape(usage.account)}${usage.plan ? ` (${escape(usage.plan)})` : ''}`
    : '';
  const observed = now - Date.parse(usage.observed_at);
  const parts = [
    account,
    window('5h', usage.five_hour),
    window('Week', usage.seven_day),
    observed >= 30 * 60_000 ? `as of ${age(observed)} ago` : '',
  ].filter(Boolean);
  return `<div class="usage">${parts.map((part) => `<span>${part}</span>`).join('')}</div>`;
}

/**
 * Each Claude account and its week against the line that spends it evenly to its reset: "Week 63%
 * used target 57% resets Wed 21 Oct, 07:00", its agents below, with how far ahead or behind it is.
 */
/** Points ahead of the even pace at which an account counts as far ahead, in red. */
const FAR_AHEAD = 20;

/**
 * An account's week as a bar, with a mark where an evenly spent week is now: green for what it
 * used up to the mark, orange for what it used beyond it (red when more than 20 points ahead),
 * blue for the room it left before it; all green within 5 points of the mark. Drawn in SVG, whose
 * sizes are attributes, as the page's style policy allows no inline styles.
 */
function weekBar(account: BoardView['accounts'][number]): string {
  const clamp = (value: number) => Math.min(100, Math.max(0, value));
  const used = clamp(account.week_used);
  const line = clamp(account.line);
  const rect = (name: string, x: number, width: number, y = 3, height = 10) =>
    `<rect class="${name}" x="${x}" y="${y}" width="${width}" height="${height}"/>`;
  const parts = [rect('track', 0, 100)];
  // On target the bar runs on to the mark, the few points still to use in blue like any room left.
  if (account.state === 'on')
    parts.push(rect('used', 0, used), ...(line > used ? [rect('behind', used, line - used)] : []));
  else if (account.state === 'ahead')
    parts.push(
      rect('used', 0, line),
      rect(account.lead > FAR_AHEAD ? 'far' : 'ahead', line, used - line),
    );
  else parts.push(rect('used', 0, used), rect('behind', used, line - used));
  // The target stands out: thicker than a hairline and above and below the bar.
  parts.push(rect('now', Math.min(98.8, Math.max(0, line - 0.6)), 1.2, 0, 16));
  const where =
    account.state === 'on'
      ? 'on pace'
      : `${Math.abs(account.lead)} points ${account.state === 'ahead' ? 'ahead' : 'behind'}`;
  return `<svg class="week" viewBox="0 0 100 16" preserveAspectRatio="none" role="img" aria-label="Week ${used}% used, ${where}"><title>${where}: ${used}% used, target ${line}%</title>${parts.join('')}</svg>`;
}

/** One small card per Claude account, up to three a row: its email, its week, its numbers. */
function accountRows(view: BoardView): string {
  return `<div class="accounts">${view.accounts
    .map(
      (account) =>
        `<div class="account"><strong title="${escape(account.account)}">${escape(account.account)}</strong>${weekBar(account)}<span class="facts">Week <b>${account.week_used}% used</b> target ${account.line}% resets ${resetTime(account.week_resets_at)}</span>${account.agents.length ? `<span class="facts">${account.agents.map(escape).join(', ')}</span>` : ''}</div>`,
    )
    .join(
      '',
    )}</div><p class="legend">Each bar is an account's week. The mark is its target: how much of the week it should have used by now to use all of it exactly by its reset. Green: on target. Blue: room left. Orange: used ahead of target. Red: more than ${FAR_AHEAD} points ahead.</p>`;
}

/** The session pills' icons: a spark for the model, pages for the context window, rising bars for the effort. */
const PILL_ICONS = {
  model:
    '<path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  context:
    '<rect x="2.5" y="4.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  effort:
    '<path d="M3.5 13v-3M8 13V7M12.5 13V3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const pill = (icon: keyof typeof PILL_ICONS, title: string, text: string, className = '') =>
  `<span class="pill${className}" title="${title}"><svg viewBox="0 0 16 16" aria-hidden="true">${PILL_ICONS[icon]}</svg>${text}</span>`;

/**
 * What the agent's session runs, as three pills beside its name (Johan chose them, 2026-10-17):
 * the model, its context window, and the reasoning effort in its level's colour.
 */
function sessionPills(usage: UsageView | null): string {
  if (!usage || !(usage.model || usage.context || usage.effort)) return '';
  return `<span class="pills">${[
    usage.model ? pill('model', 'Model', `<b>${escape(usage.model)}</b>`) : '',
    usage.context ? pill('context', 'Context window', escape(usage.context)) : '',
    usage.effort
      ? pill(
          'effort',
          'Reasoning effort',
          escape(usage.effort),
          ` effort e-${escape(usage.effort)}`,
        )
      : '',
  ].join('')}</span>`;
}

function agentRow(row: AgentRow, view: BoardView): string {
  const avatar = row.emoji
    ? `<div class="avatar ring-${row.chip}" aria-hidden="true">${escape(row.emoji)}</div>`
    : `<div class="avatar initial ring-${row.chip}" aria-hidden="true">${escape([...row.name][0] ?? '?')}</div>`;
  const offline = row.connected ? '' : '<span class="fact">bridge offline</span>';
  // A coordinator shows what it has coordinated lately instead of now and next (Johan); with no
  // description yet it shows its own task, or nothing.
  const told = row.coordinator ? row.today || row.now : row.now;
  const now = told
    ? escape(told)
    : row.coordinator
      ? ''
      : '<span class="muted">No current task in the notes</span>';
  const stall = row.stall ? `<span class="stall">${escape(row.stall)}</span>` : '';
  const next =
    row.next === null || row.coordinator
      ? ''
      : row.next.count
        ? `<div class="next"><b>Next:</b> ${row.next.items.map(escape).join(', ')}${row.next.count > row.next.items.length ? ` and ${row.next.count - row.next.items.length} more` : ''}</div>`
        : '<div class="next"><b>Next:</b> nothing queued</div>';
  const usage = row.usage ? usageLine(row.usage, Date.parse(view.generated_at)) : '';
  return `<div class="agent">${avatar}<div class="who"><strong>${escape(row.name)}</strong>${sessionPills(row.usage)}<span class="state"><span class="chip s-${row.chip}">${CHIP_LABELS[row.chip]}</span>${offline}<span class="active" title="Quarter hours with messages in the last 24 hours">${row.active === 'none' ? 'no messages' : `${escape(row.active)} active`}</span></span></div>${now || stall ? `<div class="now">${now}${stall}</div>` : ''}${next}${usage}${strip(row, view)}</div>`;
}

/**
 * The part of the board that refreshes: everything below the theme bar. `viewer` is the
 * signed-in address on a private board, which gets a sign-out button; a public board has none.
 */
export function renderBoardBody(view: BoardView, viewer: string | null = null): string {
  const notices = view.problems.length
    ? `<ul class="notices" role="status">${view.problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul>`
    : '';
  const waiting = view.waiting.length
    ? `<div class="waitlist"><ol>${view.waiting
        .map(
          (item) =>
            `<li><span class="who">${item.emoji ? `${escape(item.emoji)} ` : ''}${escape(item.name)}</span><span class="count">${item.count} ${item.count === 1 ? 'request' : 'requests'}</span><span class="since">${escape(item.since)}</span><span class="what">${escape(item.text)}</span></li>`,
        )
        .join('')}</ol></div>`
    : `<div class="panel quiet">${mascot('vader-deckchair', 'quiet-agent', 56)}<p><b>Nothing waits on you.</b> When an agent needs a decision, an approval or a look from you, it says so here.</p></div>`;
  const slots = view.agents[0]?.traffic.length ?? 0;
  const axis = `<div class="axis" aria-hidden="true"><span></span><div class="ticks" data-since="${view.traffic.since_ms}" data-slot="${view.traffic.slot_ms}" data-slots="${slots}"><span class="t-start">24 h ago</span><span class="t-mid">12 h ago</span><span class="t-end">now</span></div></div>`;
  // When everyone has gone quiet, say so once, with the one agent who sleeps on the job.
  const quiet =
    view.agents.length > 1 && view.agents.every((row) => row.chip === 'away')
      ? `<div class="panel quiet">${mascot('luke-sleep', 'quiet-agent', 56)}<p><b>All quiet.</b> Every agent is away: its bridge is offline, or it has sent no message and received no direct message in the last 30 minutes.</p></div>`
      : '';
  const agents = view.agents.length
    ? `${quiet}<div class="agents">${axis}${view.agents.map((row) => agentRow(row, view)).join('')}</div><p class="legend">Each bar is a quarter hour: taller with more messages sent or direct messages received. Away: bridge offline, or no message sent and no direct message received for 30 minutes.</p>`
    : `<div class="panel">${emptyState('mouse-empty', 'No agents here yet', 'The server operator admits them with <span class="mono">pocolobby agent add</span>; each shows here once its bridge connects.')}</div>`;
  const sources = view.sources.length
    ? view.sources
        .map((source) => {
          const where = `<b>${escape(source.room_id)}</b> ${escape(source.repo)}`;
          if (source.commit === null) return `${where}: no notes read yet`;
          const notes = source.files
            ? `${source.files} note${source.files === 1 ? '' : 's'} at <span class="mono">${escape(source.commit)}</span>`
            : `no notes found at <span class="mono">${escape(source.commit)}</span>`;
          const cut = source.cut.length
            ? `, only the beginning of ${escape(source.cut.join(', '))}`
            : '';
          return `${where}: ${notes}${cut}, fetched ${escape(source.fetched ?? '')} ago`;
        })
        .join('; ')
    : 'no notes sources';
  const written = view.summary
    ? `Now and next written by ${escape(view.summary.model)} ${escape(view.summary.written)} ago from the notes and the last day's reports and assignments, at most every ${view.interval_minutes} minutes and only when something changed.`
    : 'Now and next: no summary yet.';
  const doing =
    view.activity === 'summarizing'
      ? ' <b>Writing now and next…</b>'
      : view.activity === 'checking'
        ? ' Checking the notes…'
        : '';
  const stamp = view.summary
    ? `Live. Now and next written <b>${escape(view.summary.written)}</b> ago.${doing}`
    : `Live. No summary yet.${doing}`;
  return `<header class="lobby"><h1>${escape(view.display_name || view.lobby_id)} <small>pocolobby</small></h1><div class="stamp">${stamp}</div></header>
<section aria-label="Board">
${notices}
<h2 class="section-title">Waiting for you</h2>
${waiting}
${view.accounts.length ? `<h2 class="section-title">Accounts</h2>\n${accountRows(view)}` : ''}
<h2 class="section-title">Agents</h2>
${agents}
</section>
<footer class="source"><p>Live from PocoLobby, as of this page: what agents say they wait on from you, their connections and unacknowledged messages, and the messages each sent and the direct messages each received over the last 24 hours.</p><p>${written}</p><p>Notes: ${sources}.</p>${viewer === null ? '' : `<p>Signed in as ${escape(viewer)}.</p><form method="post" action="/logout"><button type="submit">Sign out of this board</button></form>`}</footer>`;
}

const bar = `<div class="bar"><div class="wrap"><span class="brand">PocoLobby board</span>${THEME_SWITCH}</div></div>`;

export function renderBoardPage(
  view: BoardView,
  nonce: string,
  viewer: string | null,
  icon: string | null = null,
): string {
  return page(
    `${view.display_name || view.lobby_id} on PocoLobby`,
    nonce,
    `${bar}\n<main class="wrap" id="board"${view.activity ? ` data-activity="${view.activity}"` : ''}>${renderBoardBody(view, viewer)}</main>`,
    true,
    icon,
  );
}

/**
 * A short page on a board host: after signing out, or when a sign-in link did not work. It
 * looks the same for every label under the board domain, so subdomains reveal nothing.
 */
export function renderBoardNotice(
  label: string,
  nonce: string,
  text: string,
  signIn: string,
): string {
  return page(
    `${label} on PocoLobby`,
    nonce,
    `<main class="wrap login"><header class="lobby"><h1>${escape(label)} <small>pocolobby</small></h1></header>
<div class="panel">${emptyState('vader-point', 'Sign in to see this board', escape(text), `<a class="button" href="${escape(signIn)}">Sign in with your email</a>`)}</div></main>`,
    false,
  );
}
