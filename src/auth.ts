import { createHash, createHmac, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { z } from 'zod';

/**
 * Browser sign-in for the console and the boards (0.5.0): email codes, session tokens and their
 * cookies. Codes and email rate keys are HMACs under a key derived from the broker's admin token;
 * session tokens are random and stored as SHA-256 hashes. Cookies never authorize an API route,
 * and API credentials never authorize a browser route.
 */

/**
 * The key per-client limits count under: an IPv4 address as it is, an IPv6 one by its /64 (one
 * household or server holds a whole /64), and an IPv4-mapped IPv6 address as its IPv4 address.
 */
export function clientKey(address: string): string {
  const plain = address.replace(/%.*$/u, '');
  if (!isIPv6(plain)) return address;
  const mapped = /^::ffff:(.+)$/iu.exec(plain)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  const [head = '', tail] = plain.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

export const CONSOLE_COOKIE = '__Host-pocolobby_console';
export const BOARD_COOKIE = '__Host-pocolobby_board';
/** Limits and lifetimes of browser sign-in. */
export const SIGN_IN = {
  /** A code works for 10 minutes and allows 5 wrong tries; a new code replaces it. */
  codeMs: 10 * 60_000,
  attempts: 5,
  /**
   * One code per address per minute and 5 an hour, and a ceiling across all addresses that
   * bounds mail. Without the hourly cap, anyone knowing an address could mail it ~1,000 codes a
   * day, spending the mail quota and replacing its live code each time.
   */
  sendWindowMs: 60_000,
  sendsPerAddressPerHour: 5,
  sendsPerHour: 300,
  /** Wrong codes per address per hour, across resends. */
  wrongPerHour: 10,
  /** Sessions last 30 days, extended at most once a day while in use. */
  sessionMs: 30 * 86_400_000,
  /** A hand-off to a board host works once, within a minute. */
  handoffMs: 60_000,
  lobbiesPerAccount: 3,
  viewersPerLobby: 50,
} as const;

export const newSessionToken = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** A session token in a Cookie header, if it has the form this broker issues. */
export function cookieToken(cookieHeader: string | undefined, name: string): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === name && value && /^[A-Za-z0-9_-]{43}$/u.test(value)) return value;
  }
  return null;
}
/** Host-only (no Domain, `__Host-`), Secure, HttpOnly, SameSite=Lax; null clears it. */
export function sessionCookie(name: string, token: string | null): string {
  return token === null
    ? `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
    : `${name}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SIGN_IN.sessionMs / 1000}`;
}

export const Code = z.string().regex(/^\d{6}$/u, 'The code is six digits');

/** The keys for sign-in codes and per-email rate rows, derived from the admin token. */
export class SignInKeys {
  private readonly key: Buffer;
  constructor(adminToken: string) {
    this.key = Buffer.from(hkdfSync('sha256', adminToken, '', 'pocolobby console otp', 32));
  }
  private mac(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('hex');
  }
  /** Rate rows and codes are keyed by this, never by the address itself. */
  emailKey(email: string): string {
    return this.mac(`email\n${email}`);
  }
  /** A code is stored only as this MAC, bound to its address. */
  codeMac(emailKey: string, code: string): string {
    return this.mac(`code\n${emailKey}\n${code}`);
  }
}
export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * Attempts per key within a fixed window, in memory: per-client ceilings and global ceilings.
 * A restart forgets them, which only ever allows a few more attempts.
 */
export class WindowLimiter {
  private readonly entries = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  /** Seconds to wait, or 0 when this attempt may go ahead (and is counted). */
  take(key: string): number {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (!entry && this.entries.size >= 4096)
        this.entries.delete(this.entries.keys().next().value!);
      entry = { start: now, count: 0 };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.limit) return Math.ceil((entry.start + this.windowMs - now) / 1000);
    entry.count += 1;
    return 0;
  }
}
