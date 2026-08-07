import { redirect } from 'next/navigation';

import {
  reconcileWebhooksAction,
  rotateWebhookSecretsAction,
  setConnectionPausedAction,
  testConnectionAction,
} from '../../actions/connections';
import { Button, Card, Notice } from '../../../components/form';
import {
  availableProviders,
  connectionPermissions,
  listConnections,
  type ConnectionSummary,
} from '../../../lib/connections';
import { csrfToken } from '../../../lib/csrf';
import { CSRF_FIELD } from '../../../lib/csrf-field';
import { identity } from '../../../lib/identity';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { ConnectForms, DisconnectForm } from './connect-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Connections' };

/**
 * The eBay accounts and WooCommerce stores this business is connected to
 * (sections 13, 14, 21).
 *
 * Section 21 asks this screen for identity, environment, scopes, health, webhook
 * status, quotas, and last sync — and for connect, reauthorize, test, rotate,
 * pause, and disconnect.
 *
 * Nothing here calls a provider. Everything shown is what was recorded the last
 * time somebody tested a connection or a worker used it, which means the page
 * renders during exactly the outage somebody would be opening it to understand.
 * Testing is a button, because a status page that called eBay on every render
 * would be the thing exhausting the quota it reports on.
 *
 * The page hides what the caller cannot do, and every action re-checks it
 * server-side anyway. Section 5: hiding a button is a courtesy to the person
 * using the screen, not a control on the person attacking it.
 */
export default async function ConnectionsPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const businesses = await identity().memberships.listBusinessesFor(db, context.user.id);
  const businessId = context.session.activeBusinessId ?? businesses[0]?.businessId ?? null;

  if (businessId === null) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Connections</h1>
        <Notice tone="info">
          You are not a member of any business, so there is nothing to connect.
        </Notice>
      </main>
    );
  }

  const { canView, canManage } = await connectionPermissions(businessId, context.user.id);

  if (!canView) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Connections</h1>
        <Notice tone="info">
          You cannot see connection health in this business. That needs the view connection health
          permission.
        </Notice>
      </main>
    );
  }

  const [summaries, providers] = await Promise.all([
    listConnections(businessId),
    Promise.resolve(availableProviders()),
  ]);

  const token = csrfToken(context.session);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Connections</h1>
        <p className="text-sm opacity-70">
          The eBay accounts and WooCommerce stores this business reads from. Nothing on this page
          contacts a provider; use Test to check one now.
        </p>
      </header>

      {summaries.length === 0 ? (
        <Card title="Nothing connected yet">
          <p className="text-sm opacity-70">
            {providers.ebay.length === 0
              ? 'No eBay keyset is configured for this installation, so only WooCommerce stores can be connected. An administrator adds eBay credentials to the environment file.'
              : 'Connect an eBay account or a WooCommerce store to start importing a catalog. Nothing is written to either until a later milestone.'}
          </p>
        </Card>
      ) : (
        summaries.map((summary) => (
          <ConnectionCard
            key={summary.id}
            summary={summary}
            businessId={businessId}
            token={token}
            canManage={canManage}
          />
        ))
      )}

      {canManage ? (
        <ConnectForms csrf={token} businessId={businessId} ebayEnvironments={[...providers.ebay]} />
      ) : (
        <Notice tone="info">
          You can see these connections but not change them. That needs the manage integrations
          permission.
        </Notice>
      )}
    </main>
  );
}

function ConnectionCard({
  summary,
  businessId,
  token,
  canManage,
}: {
  summary: ConnectionSummary;
  businessId: string;
  token: string;
  canManage: boolean;
}) {
  const { health, readiness } = summary;

  return (
    <Card title={summary.displayName}>
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Detail label="Provider">
            {summary.provider === 'ebay' ? 'eBay' : 'WooCommerce'}
            {summary.environment === 'sandbox' ? ' · sandbox' : ''}
          </Detail>
          {/* Immutable, and shown because it is what makes two connections to
              similar-looking accounts distinguishable (sections 13, 14). */}
          <Detail label="Account">{summary.externalAccountId}</Detail>
          <Detail label="Status">{summary.status}</Detail>
          <Detail label="Health">
            <HealthBadge status={health.status} /> {health.summary}
          </Detail>
          <Detail label="Connected">
            {summary.connectedAt === null
              ? 'not yet'
              : `${summary.connectedAt.toISOString().slice(0, 16)}Z`}
          </Detail>
          <Detail label="Last checked">
            {readiness === null
              ? 'never tested'
              : `${readiness.checkedAt.toISOString().slice(0, 16)}Z`}
          </Detail>
        </dl>

        {summary.pauseReason === null ? null : <Notice tone="info">{summary.pauseReason}</Notice>}

        <Detail label="Permissions">
          {summary.scopes.length === 0 ? 'none recorded' : summary.scopes.join(', ')}
        </Detail>

        {readiness === null ? (
          <p className="text-sm opacity-70">
            This connection has not been tested. Testing asks the provider what this account is set
            up to do; it changes nothing.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              Available:{' '}
              {readiness.available.length === 0 ? 'nothing yet' : readiness.available.join(', ')}
            </p>
            {readiness.blocked.length === 0 ? null : (
              <ul className="flex flex-col gap-1 text-sm opacity-80">
                {readiness.blocked.map((entry) => (
                  <li key={entry.capability}>
                    {entry.capability} — blocked by {entry.because}
                  </li>
                ))}
              </ul>
            )}
            <ul className="flex flex-col gap-1 text-xs opacity-70">
              {readiness.checks.map((check) => (
                <li key={check.name}>
                  {check.status} · {check.name}: {check.summary}
                </li>
              ))}
            </ul>
          </div>
        )}

        {health.pollingRequired.length === 0 ? null : (
          <Notice tone="info">
            Changes to {health.pollingRequired.join(', ')} are found by polling rather than
            delivered, so they arrive more slowly.
          </Notice>
        )}

        {health.quotas.length === 0 ? null : (
          <ul className="flex flex-col gap-1 text-xs opacity-70">
            {health.quotas.map((quota) => (
              <li key={`${quota.apiFamily}-${quota.windowEndsAt.toISOString()}`}>
                {quota.apiFamily}:{' '}
                {quota.limit === null
                  ? `${String(quota.used)} calls, no limit reported`
                  : `${String(quota.used)} of ${String(quota.limit)} (${String(Math.round((quota.fraction ?? 0) * 100))}%)`}
              </li>
            ))}
          </ul>
        )}

        {!canManage ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <form action={testConnectionAction}>
              <Hidden token={token} businessId={businessId} connectionId={summary.id} />
              <Button type="submit" variant="secondary">
                Test
              </Button>
            </form>

            {summary.provider !== 'woocommerce' ? null : (
              <>
                <form action={reconcileWebhooksAction}>
                  <Hidden token={token} businessId={businessId} connectionId={summary.id} />
                  <Button type="submit" variant="secondary">
                    Check webhooks
                  </Button>
                </form>

                <form action={rotateWebhookSecretsAction}>
                  <Hidden token={token} businessId={businessId} connectionId={summary.id} />
                  <Button type="submit" variant="secondary">
                    Rotate secrets
                  </Button>
                </form>
              </>
            )}

            <form action={setConnectionPausedAction}>
              <Hidden token={token} businessId={businessId} connectionId={summary.id} />
              <input
                type="hidden"
                name="intent"
                value={summary.status === 'paused' ? 'resume' : 'pause'}
              />
              <Button type="submit" variant="secondary">
                {summary.status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
            </form>

            <DisconnectForm csrf={token} businessId={businessId} connectionId={summary.id} />
          </div>
        )}
      </div>
    </Card>
  );
}

function Hidden({
  token,
  businessId,
  connectionId,
}: {
  token: string;
  businessId: string;
  connectionId: string;
}) {
  return (
    <>
      <input type="hidden" name={CSRF_FIELD} value={token} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="connectionId" value={connectionId} />
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide opacity-60">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

/**
 * The health word, with a shape as well as a colour.
 *
 * Section 21 requires WCAG 2.2 AA, and colour alone is not an accessible way to
 * carry meaning — the word is the signal and the dot is decoration.
 */
function HealthBadge({ status }: { status: string }) {
  const tone =
    status === 'healthy'
      ? 'bg-emerald-500'
      : status === 'degraded'
        ? 'bg-amber-500'
        : status === 'failing'
          ? 'bg-red-500'
          : 'bg-slate-400';

  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden="true" className={`inline-block size-2 rounded-full ${tone}`} />
      <span className="font-medium">{status}</span>
    </span>
  );
}
