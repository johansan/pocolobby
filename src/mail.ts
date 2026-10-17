// Not from board-page: that would load the board, its model client and pictures into every CLI
// command, the per-minute status line included.
import { escape } from './html.js';

/**
 * Sign-in mail (0.5.0). The broker sends one kind of email, a sign-in code, through Postmark's
 * `/email` endpoint. Tests and local checks inject their own mailer instead.
 */
export interface Mailer {
  /** Resolves once the provider accepted the message; throws MailError otherwise. */
  sendSignInCode(to: string, code: string): Promise<void>;
}

/** A send that did not go out, in words the person signing in can act on. */
export class MailError extends Error {}

export interface PostmarkOptions {
  token: string;
  /** Such as "PocoLobby <signin@pocolobby.com>"; the domain must be verified in Postmark. */
  from: string;
  /** Postmark's API, or a test server. */
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function postmarkMailer(options: PostmarkOptions): Mailer {
  const send = options.fetch ?? fetch;
  const url = `${options.apiBase ?? 'https://api.postmarkapp.com'}/email`;
  return {
    async sendSignInCode(to, code) {
      let response: Response;
      try {
        response = await send(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-postmark-server-token': options.token,
          },
          body: JSON.stringify({
            From: options.from,
            To: to,
            // The code leads the subject, so it shows in a notification without opening the mail.
            Subject: `${code} is your PocoLobby sign-in code`,
            TextBody: `Your PocoLobby sign-in code is ${code}.\n\nIt works once, for 10 minutes. If you did not ask for it, ignore this email.\n`,
            HtmlBody: `<p>Your PocoLobby sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${escape(code)}</p><p>It works once, for 10 minutes. If you did not ask for it, ignore this email.</p>`,
            MessageStream: 'outbound',
            TrackOpens: false,
            TrackLinks: 'None',
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch {
        throw new MailError('The email service could not be reached');
      }
      let answer: { ErrorCode?: unknown; Message?: unknown } = {};
      try {
        answer = (await response.json()) as typeof answer;
      } catch {
        /* Reported below with the status. */
      }
      // Postmark answers ErrorCode 0 for an accepted message, even with status 200 otherwise.
      if (!response.ok || answer.ErrorCode !== 0) {
        const reason =
          typeof answer.Message === 'string' && answer.Message.length <= 300
            ? `: ${answer.Message}`
            : '';
        throw new MailError(
          `The email service refused the message (${response.status}${typeof answer.ErrorCode === 'number' ? `, error ${answer.ErrorCode}` : ''})${reason}`,
        );
      }
    },
  };
}
