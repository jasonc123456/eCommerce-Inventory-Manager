import { businesses, businessDeletionRequests } from '@eim/db';
import { TOKEN_QUERY_PARAMETER } from '@eim/mail';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { Card, Notice, PageHeader } from '../../../../components/form';
import { csrfToken } from '../../../../lib/csrf';
import { identity } from '../../../../lib/identity';
import { runtime } from '../../../../lib/runtime';
import { currentContext } from '../../../../lib/session';
import { ConfirmDeletionForm } from './confirm-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Confirm deletion' };

/**
 * Where the emailed confirmation link lands (sections 5, 13, 19).
 *
 * This page **never deletes anything**. It reads the token, says what will
 * happen, and offers a button — because mail security products follow links.
 * Office 365 Safe Links rewrites every URL in a message and fetches it, which
 * this installation has already had to work around once; a deletion performed
 * on GET would be carried out by a scanner before any human read the email.
 *
 * It is inside the signed-in layout on purpose. Possession of the link is not
 * authority: the reader has to be signed in, and the service checks they are
 * still an owner before it does anything. A link forwarded to somebody else is
 * worth nothing to them.
 *
 * What it shows about an invalid token is deliberately vague. "This link is not
 * usable" rather than "expired at 14:02 for Widgets Ltd", because this page can
 * be opened by anybody holding the URL and the first version confirms what the
 * second only guesses.
 */
export default async function ConfirmDeletionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const parameters = await searchParams;
  const raw = parameters[TOKEN_QUERY_PARAMETER];
  const token = typeof raw === 'string' ? raw : '';

  const { db } = runtime();
  const { hasher } = identity();

  const [request] =
    token === ''
      ? []
      : await db
          .select({
            businessId: businessDeletionRequests.businessId,
            expiresAt: businessDeletionRequests.expiresAt,
            name: businesses.name,
          })
          .from(businessDeletionRequests)
          .innerJoin(businesses, eq(businesses.id, businessDeletionRequests.businessId))
          .where(
            and(
              eq(businessDeletionRequests.tokenHash, hasher.hash('business_deletion', token)),
              isNull(businessDeletionRequests.confirmedAt),
              isNull(businessDeletionRequests.cancelledAt),
              isNull(businesses.deletedAt),
              // Expiry is decided by the database, whose clock wrote the
              // timestamp. Comparing against this process's clock would put two
              // machines' opinions of the time on either side of a `<`.
              sql`${businessDeletionRequests.expiresAt} > now()`,
            ),
          )
          .limit(1);

  if (request === undefined) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader title="Confirm deletion" />
        <Card title="This link is not usable">
          <Notice tone="error">
            It may have expired, been used already, or the request may have been cancelled. Nothing
            has been deleted. If you still want to delete a business, start again from its settings
            screen.
          </Notice>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        title={`Delete ${request.name}?`}
        description="Read this before pressing the button. Nothing has happened yet."
      />

      <Card title="What this does">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          <li>Everything in this business stops synchronizing immediately.</li>
          <li>
            <span className="font-medium">Its credentials are erased and cannot be recovered.</span>{' '}
            The stored eBay authorization and WooCommerce keys go for good; reconnecting later means
            authorizing from scratch.
          </li>
          <li>
            Its records are kept but hidden, so the stock history stays auditable and the deletion
            itself stays on the record.
          </li>
          <li>
            Team members lose access to it. Their accounts and other businesses are untouched.
          </li>
        </ul>

        <Notice tone="warning">
          This link works once and expires at {request.expiresAt.toISOString()}. If you did not
          expect this email, close it and cancel the request from the business settings screen.
        </Notice>

        <ConfirmDeletionForm csrf={csrfToken(context.session)} token={token} />
      </Card>
    </main>
  );
}
