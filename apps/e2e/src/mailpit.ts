import { environment } from './environment';

/**
 * Reading the mail the application actually sent.
 *
 * Every authentication path in section 20 ends in an inbox, so a browser tier
 * that stubbed the mail would be testing the half of sign-in that does not
 * decide anything. This talks to the capture service the stack already runs,
 * which means the assertions are about the real rendered message: the real
 * subject, the real link, in the real carrier shape.
 *
 * It deliberately does not reach into the database for a token. A token read
 * from `sign_in_challenges` would still pass if the template dropped the link,
 * if the carrier configuration was wrong, or if nothing was ever sent.
 */

interface MailpitSummary {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
  readonly Created: string;
}

export interface CapturedMessage {
  readonly id: string;
  readonly subject: string;
  readonly to: readonly string[];
  readonly text: string;
  readonly html: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${environment.mailpitUrl}${path}`, init);

  if (!response.ok) {
    throw new Error(`mailpit ${path} returned ${String(response.status)}`);
  }

  return (await response.json()) as T;
}

/**
 * Empties the mailbox.
 *
 * Called before anything that will then wait for a message. Without it, a test
 * that asks for "the newest sign-in mail" can be handed one left by an earlier
 * test — which passes, and proves nothing about the request just made.
 */
export async function clearMailbox(): Promise<void> {
  const response = await fetch(`${environment.mailpitUrl}/api/v1/messages`, { method: 'DELETE' });

  if (!response.ok) {
    throw new Error(`mailpit refused to clear the mailbox (${String(response.status)})`);
  }
}

/** Waits for a message to a given address, newest first. */
export async function waitForMessage(
  recipient: string,
  options: { readonly subjectContains?: string; readonly timeoutMs?: number } = {},
): Promise<CapturedMessage> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const wanted = recipient.toLowerCase();

  for (;;) {
    const listing = await api<{ readonly messages: readonly MailpitSummary[] }>(
      '/api/v1/messages?limit=50',
    );

    const match = listing.messages.find(
      (message) =>
        message.To.some((address) => address.Address.toLowerCase() === wanted) &&
        (options.subjectContains === undefined ||
          message.Subject.toLowerCase().includes(options.subjectContains.toLowerCase())),
    );

    if (match !== undefined) {
      const full = await api<{ readonly Text: string; readonly HTML: string }>(
        `/api/v1/message/${match.ID}`,
      );

      return {
        id: match.ID,
        subject: match.Subject,
        to: match.To.map((address) => address.Address),
        text: full.Text,
        html: full.HTML,
      };
    }

    if (Date.now() > deadline) {
      throw new Error(
        `no message reached ${recipient}` +
          (options.subjectContains === undefined ? '' : ` with "${options.subjectContains}"`) +
          ` within the timeout. ${String(listing.messages.length)} other message(s) were waiting.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** How many messages are sitting in the mailbox right now. */
export async function messageCount(): Promise<number> {
  const listing = await api<{ readonly total: number }>('/api/v1/messages?limit=1');

  return listing.total;
}

/**
 * The one link in a message that points back at this installation.
 *
 * Asserting there is exactly one is part of the check rather than defensive
 * coding. These messages carry an action, and a second link beside it is how a
 * recipient clicks the wrong thing — so a template that grew one should fail
 * here rather than be silently accommodated by picking the first match.
 */
export function actionLink(message: CapturedMessage): URL {
  const found = new Set(
    [...message.text.matchAll(/https?:\/\/[^\s<>"')]+/gu)]
      .map((match) => match[0].replace(/[.,)]+$/u, ''))
      .filter((candidate) => candidate.startsWith(environment.baseUrl)),
  );

  const [only, ...rest] = [...found];

  if (only === undefined || rest.length > 0) {
    throw new Error(
      `expected exactly one action link in "${message.subject}", found ` +
        `${String(found.size)}: ${[...found].join(', ')}`,
    );
  }

  return new URL(only);
}
