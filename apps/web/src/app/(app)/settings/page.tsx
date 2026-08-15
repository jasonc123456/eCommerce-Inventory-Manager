import { authorize } from '@eim/authz';
import { businesses } from '@eim/db';
import { DEFAULT_POLICY, loadRetentionSettings, policyOf } from '@eim/retention';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { Card, EmptyState, Notice, PageHeader } from '../../../components/form';
import { csrfToken } from '../../../lib/csrf';
import { identity } from '../../../lib/identity';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { CancelDeletionForm, RequestDeletionForm } from './danger-forms';
import { BusinessDetailsForm, RetentionForm } from './settings-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Business settings' };

/**
 * What a business is and how long it remembers (sections 9, 13, 37).
 *
 * Split by permission rather than by topic: the name and the clock are
 * `manage_business_settings`, and retention is `manage_retention_settings`,
 * because section 5 makes them separate grants and somebody trusted to rename a
 * shop is not automatically trusted to decide when its records disappear.
 *
 * Each card is rendered only where the caller holds the permission for it. That
 * is a display decision, not a security one — both actions check the same
 * permission on the server, which is where it counts.
 */
export default async function SettingsPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const memberships = await identity().memberships.listBusinessesFor(db, context.user.id);
  const businessId = context.session.activeBusinessId ?? memberships[0]?.businessId ?? null;

  if (businessId === null) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader title="Business settings" />
        <Card title="No business">
          <EmptyState title="There is nothing to configure yet">
            Create a business first — settings belong to one.
          </EmptyState>
        </Card>
      </main>
    );
  }

  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader title="Business settings" />
        <Card title="Not a member">
          <EmptyState title="You are not a member of this business">
            Ask an owner to invite you.
          </EmptyState>
        </Card>
      </main>
    );
  }

  const mayEditDetails = authorize(subject, 'manage_business_settings').allowed;
  const mayEditRetention = authorize(subject, 'manage_retention_settings').allowed;

  // Ownership, not the `delete_business` permission. Owners hold it implicitly,
  // so checking the permission would also show this to a manager somebody
  // granted it to — and only an owner may delete a shop. The service checks the
  // same thing again; this only decides whether the card is worth drawing.
  const isOwner = subject.isOwner;
  const pending = isOwner ? await identity().deletion.outstanding(db, businessId) : null;

  const [row] = await db
    .select({ name: businesses.name, slug: businesses.slug, timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);

  const policy = policyOf(await loadRetentionSettings(db, businessId));
  const csrf = csrfToken(context.session);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        title="Business settings"
        description={`Handle: ${row?.slug ?? 'unknown'}. The handle is fixed at creation — it appears in links and logs, and renaming the business does not move it.`}
      />

      {mayEditDetails ? (
        <Card
          title="Details"
          description="What this business is called, and what clock it runs on."
        >
          <BusinessDetailsForm
            csrf={csrf}
            businessId={businessId}
            name={row?.name ?? ''}
            timezone={row?.timezone ?? 'UTC'}
          />
        </Card>
      ) : null}

      {mayEditRetention ? (
        <Card
          title="Retention"
          description="How long this business keeps what it has recorded. The nightly sweep enforces it."
        >
          <RetentionForm
            csrf={csrf}
            businessId={businessId}
            historyDays={policy.historyDays}
            rawEventDays={policy.rawEventDays}
          />
        </Card>
      ) : null}

      {mayEditDetails || mayEditRetention ? null : (
        <Card title="Nothing to change">
          <EmptyState title="You can see this business but not configure it">
            Changing the name or clock needs permission to manage business settings; changing
            retention needs permission to manage retention settings.
          </EmptyState>
        </Card>
      )}

      {isOwner ? (
        <Card
          title="Delete this business"
          description="Asks twice: once here, and once by email to every owner."
        >
          {pending === null ? (
            <RequestDeletionForm
              csrf={csrf}
              businessId={businessId}
              businessName={row?.name ?? ''}
            />
          ) : (
            <div className="flex flex-col gap-3">
              <Notice tone="warning">
                A deletion was requested at {pending.requestedAt.toISOString()} and the emailed link
                works until {pending.expiresAt.toISOString()}. Nothing has been deleted. If this was
                not you, cancel it now and change your password.
              </Notice>
              {pending.reason === null ? null : (
                <p className="text-muted text-sm">Reason given: {pending.reason}</p>
              )}
              <CancelDeletionForm csrf={csrf} businessId={businessId} />
            </div>
          )}
        </Card>
      ) : null}

      <Card title="Defaults" description="What applies until somebody changes it.">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted">History</dt>
          <dd className="tabular">{DEFAULT_POLICY.historyDays} days</dd>
          <dt className="text-muted">Raw provider bodies</dt>
          <dd className="tabular">{DEFAULT_POLICY.rawEventDays} days</dd>
          <dt className="text-muted">Time zone</dt>
          <dd>UTC</dd>
        </dl>
      </Card>
    </main>
  );
}
