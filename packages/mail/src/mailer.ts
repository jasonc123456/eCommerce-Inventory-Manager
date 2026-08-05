import nodemailer, { type Transporter } from 'nodemailer';

import type { RenderedMessage } from './templates';

/**
 * SMTP delivery (section 20).
 *
 * Generic SMTP rather than a provider SDK, because a self-hoster has to be able
 * to point this at whatever they already have, and a hosted API would make the
 * project depend on an account nobody agreed to open. The owner's own
 * deployment uses Office 365, which is one configuration of the same transport.
 *
 * Development never reaches a real inbox. That is arranged in the deployment's
 * Compose file, which points EIM_SMTP_HOST at the local capture service, and
 * this module deliberately has no "if development" branch: a code path that
 * decides whether mail is real is a code path that can decide wrongly.
 */

export interface MailerConfig {
  readonly host: string;
  readonly port: number;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  readonly fromAddress: string;
  readonly fromName: string;
  /**
   * Whether the connection is implicitly TLS.
   *
   * Defaults from the port: 465 is implicit TLS, everything else starts plain
   * and upgrades with STARTTLS. Office 365 and most relays are the latter on
   * 587, and the local capture service is neither, which is why STARTTLS is
   * requested rather than required.
   */
  readonly secure?: boolean;
}

export interface OutboundMessage extends RenderedMessage {
  readonly to: string;
}

export type DeliveryOutcome =
  | { readonly delivered: true; readonly messageId: string }
  | { readonly delivered: false; readonly failure: DeliveryFailure };

/**
 * Why a message did not go out.
 *
 * Deliberately a small, describable shape rather than the driver's error.
 * Section 20 requires delivery failures to be "recorded without message
 * secrets", and an SMTP client's error routinely quotes the envelope, the
 * recipient, and sometimes the rejected body back at you.
 */
export interface DeliveryFailure {
  readonly kind: 'connection' | 'authentication' | 'rejected' | 'unknown';
  /** The server's response code, when there was one. Never its message body. */
  readonly responseCode?: number;
  readonly summary: string;
}

export interface Mailer {
  send(message: OutboundMessage): Promise<DeliveryOutcome>;
  /** Proves the transport is usable, for the readiness surface. Sends nothing. */
  verify(): Promise<DeliveryOutcome>;
  close(): Promise<void>;
}

export function createMailer(config: MailerConfig): Mailer {
  const transport: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? config.port === 465,
    ...(config.user === undefined || config.user.length === 0
      ? {}
      : { auth: { user: config.user, pass: config.password ?? '' } }),
    // Bounded, because an SMTP server that accepts the connection and then
    // stops talking would otherwise hold a request open indefinitely, and the
    // request in question is somebody trying to sign in.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  const from = `${config.fromName} <${config.fromAddress}>`;

  return {
    async send(message) {
      try {
        // nodemailer types `sendMail` as returning `any`, which would spread
        // through every caller. Asserted to the one field that is used, and
        // then checked, because an assertion is a claim rather than a proof.
        const info = (await transport.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: {
            // Keeps a sign-in message out of a corporate auto-responder loop,
            // and out of the "recent conversation" grouping that would show the
            // previous code alongside the current one.
            'Auto-Submitted': 'auto-generated',
            'X-Auto-Response-Suppress': 'All',
          },
        })) as { messageId?: unknown };

        return {
          delivered: true,
          messageId: typeof info.messageId === 'string' ? info.messageId : 'unknown',
        };
      } catch (error: unknown) {
        return { delivered: false, failure: describeFailure(error) };
      }
    },

    async verify() {
      try {
        await transport.verify();
        return { delivered: true, messageId: 'verified' };
      } catch (error: unknown) {
        return { delivered: false, failure: describeFailure(error) };
      }
    },

    async close() {
      transport.close();
      await Promise.resolve();
    },
  };
}

/**
 * Reduces a driver error to something safe to record.
 *
 * Named properties are copied rather than unwanted ones deleted, which is what
 * makes it structurally impossible for the envelope, the credentials, or the
 * rejected body to survive into an audit row or a log line.
 */
export function describeFailure(error: unknown): DeliveryFailure {
  // A thrown non-object is rare but real: a transport that rejects with a
  // string would otherwise crash the path that is recording why mail failed.
  const candidate =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; responseCode?: unknown })
      : {};

  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  const responseCode =
    typeof candidate.responseCode === 'number' ? candidate.responseCode : undefined;

  const kind = classify(code, responseCode);

  return {
    kind,
    ...(responseCode === undefined ? {} : { responseCode }),
    summary: summarize(kind, code, responseCode),
  };
}

function classify(
  code: string | undefined,
  responseCode: number | undefined,
): DeliveryFailure['kind'] {
  if (code === 'EAUTH' || responseCode === 535) {
    return 'authentication';
  }

  if (
    code === 'ECONNECTION' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ESOCKET' ||
    code === 'EDNS'
  ) {
    return 'connection';
  }

  if (responseCode !== undefined && responseCode >= 400) {
    return 'rejected';
  }

  return 'unknown';
}

function summarize(
  kind: DeliveryFailure['kind'],
  code: string | undefined,
  responseCode: number | undefined,
): string {
  const suffix = responseCode === undefined ? '' : ` (${String(responseCode)})`;

  switch (kind) {
    case 'authentication':
      return `the mail server rejected the configured credentials${suffix}`;
    case 'connection':
      return `the mail server could not be reached${code === undefined ? '' : ` (${code})`}`;
    case 'rejected':
      return `the mail server refused the message${suffix}`;
    case 'unknown':
      return 'the message could not be sent';
  }
}
