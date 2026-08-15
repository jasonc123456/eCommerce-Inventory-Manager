import { alertStateAt } from '@eim/db';
import { openAlerts } from '@eim/notifications';
import { readStage } from '@eim/pilot';
import { sql } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Badge, Card, EmptyState, PageHeader, Stat } from '../../components/form';
import { maySee } from '../../lib/alerts';
import { listConnections } from '../../lib/connections';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Overview' };

/**
 * The signed-in landing page.
 *
 * What belongs on a landing screen is the answer to "is anything wrong, and what
 * should I do next" — not a summary of the product. So it shows outstanding
 * alerts, whether the channels are healthy, what stage the pilot is at, and how
 * much stock is under management; and when a business has none of those yet, it
 * shows the ordered list of things to do instead of an empty grid.
 *
 * Alerts are filtered through the same permission check the alerts screen uses,
 * imported rather than restated. A count on a dashboard that included alerts the
 * reader may not open would be a number they cannot act on and cannot explain.
 */
export default async function OverviewPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const { memberships } = identity();

  const businesses = await memberships.listBusinessesFor(db, context.user.id);
  const activeId = context.session.activeBusinessId ?? businesses[0]?.businessId ?? null;

  if (activeId === null) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader
          title={`Welcome, ${context.user.displayName ?? context.user.email}`}
          description="You are not a member of any business yet."
        />

        <Card title="Start here">
          <EmptyState
            title="A business is the container for everything else"
            action={
              <Link
                href="/businesses/new"
                className="btn-primary mt-1 inline-flex rounded-lg px-3.5 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Create a business
              </Link>
            }
          >
            Stock, channels, mappings, and team members all belong to one. Create the first, or wait
            for somebody to invite you to theirs.
          </EmptyState>
        </Card>
      </main>
    );
  }

  const subject = await memberships.loadSubject(db, activeId, context.user.id);
  const active = businesses.find((business) => business.businessId === activeId);

  const [connections, alerts, stage, counts] = await Promise.all([
    listConnections(activeId),
    openAlerts(db, activeId),
    readStage(db, activeId),
    countStock(activeId),
  ]);

  const visible = subject === null ? [] : alerts.filter((alert) => maySee(subject, alert));
  const now = new Date();
  const unacknowledged = visible.filter((alert) => alertStateAt(alert, now) === 'open');
  const critical = visible.filter((alert) => alert.severity === 'critical');
  const unhealthy = connections.filter((connection) => connection.health.status !== 'healthy');

  const nothingSetUp = connections.length === 0 && counts.items === 0;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        title={active?.name ?? 'Overview'}
        description={`Signed in as ${context.user.email}${
          active === undefined ? '' : ` — ${active.role} of this business`
        }.`}
      />

      {nothingSetUp ? (
        <Card title="Nothing is set up yet" description="In the order it wants doing.">
          <ol className="text-muted flex list-decimal flex-col gap-3 pl-5 text-sm">
            <li>
              <Link href="/connections" className="text-[var(--accent-strong)] underline">
                Connect an eBay account or a WooCommerce store
              </Link>
              . Both import read-only to begin with; nothing is written back until a mapping is
              approved and activated.
            </li>
            <li>
              <Link href="/inventory" className="text-[var(--accent-strong)] underline">
                Create canonical items
              </Link>{' '}
              and record what you hold, at which location.
            </li>
            <li>
              <Link href="/mappings" className="text-[var(--accent-strong)] underline">
                Map each channel listing to an item
              </Link>
              . Nothing synchronizes until you approve and activate the mapping.
            </li>
            <li>
              <Link href="/pilot" className="text-[var(--accent-strong)] underline">
                Start observing
              </Link>{' '}
              before letting anything write to a live listing.
            </li>
          </ol>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Outstanding alerts">
          <Stat
            label="Not yet acknowledged"
            value={unacknowledged.length}
            detail={
              critical.length === 0
                ? `${String(visible.length)} outstanding in total`
                : `${String(critical.length)} critical`
            }
          />
        </Card>

        <Card title="Channels">
          <Stat
            label="Connected"
            value={connections.length}
            detail={
              connections.length === 0
                ? 'none yet'
                : unhealthy.length === 0
                  ? 'all healthy'
                  : `${String(unhealthy.length)} needing attention`
            }
          />
        </Card>

        <Card title="Under management">
          <Stat
            label="Canonical items"
            value={counts.items}
            detail={`${String(counts.activeMappings)} active mappings`}
          />
        </Card>

        <Card title="Pilot">
          <Stat
            label="Stage"
            value={<span className="text-lg">{stage.stage}</span>}
            detail={
              stage.stage === 'full'
                ? 'every mapping is written'
                : `${String(stage.enrolled)} mappings enrolled`
            }
          />
        </Card>
      </div>

      <Card
        title="What needs a person"
        description="Everything here is waiting on a decision rather than on a job."
      >
        {unacknowledged.length === 0 && unhealthy.length === 0 ? (
          <EmptyState title="Nothing is waiting">
            No unacknowledged alerts, and every connection is reporting healthy. Alerts about stock,
            connections, and synchronization appear here.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {unacknowledged.slice(0, 5).map((alert) => (
              <li key={alert.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Badge tone={alert.severity === 'critical' ? 'bad' : 'warn'}>
                  {alert.severity}
                </Badge>
                <Link href="/alerts" className="font-medium underline">
                  {alert.kind}
                </Link>
                <span className="text-muted">{alert.summary}</span>
              </li>
            ))}

            {unhealthy.slice(0, 5).map((connection) => (
              <li key={connection.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Badge tone="warn">{connection.health.status}</Badge>
                <Link href="/connections" className="font-medium underline">
                  {connection.displayName}
                </Link>
                <span className="text-muted">
                  {connection.pauseReason ?? 'the last checks did not succeed'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}

/**
 * Two counts, in one statement.
 *
 * Written out rather than assembled from the inventory services because this is
 * a dashboard tile: it wants a number, not a page of items, and loading a
 * catalogue to call `.length` on it is how a landing screen becomes the slowest
 * one in the application.
 */
async function countStock(businessId: string): Promise<{ items: number; activeMappings: number }> {
  const { db } = runtime();

  const rows = await db.execute<{ items: string | number; mappings: string | number }>(sql`
    select
      (select count(*) from canonical_items
        where business_id = ${businessId}::uuid and deleted_at is null) as items,
      (select count(*) from channel_mappings
        where business_id = ${businessId}::uuid and status = 'active') as mappings
  `);

  return {
    items: Number(rows.rows[0]?.items ?? 0),
    activeMappings: Number(rows.rows[0]?.mappings ?? 0),
  };
}
