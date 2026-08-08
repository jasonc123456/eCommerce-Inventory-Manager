import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Card, Notice } from '../../../../components/form';
import { csrfToken } from '../../../../lib/csrf';
import { identity } from '../../../../lib/identity';
import { inventoryPermissions, loadItem } from '../../../../lib/inventory';
import { runtime } from '../../../../lib/runtime';
import { currentContext } from '../../../../lib/session';
import { AdjustForm, ProjectionTable, TransferForm } from '../inventory-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Item' };

/**
 * One canonical item: where its units are, what each channel would advertise,
 * and how it got here (sections 8, 9, 21).
 *
 * The timeline is the part worth having. Section 17 never edits a committed
 * entry to correct stock, so what is shown is the whole history including its
 * mistakes and their reversals — which is what somebody actually needs six weeks
 * later when a channel and the shelf disagree.
 */
export default async function ItemPage({ params }: { params: Promise<{ item: string }> }) {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { item: canonicalItemId } = await params;
  const { db } = runtime();
  const businesses = await identity().memberships.listBusinessesFor(db, context.user.id);
  const businessId = context.session.activeBusinessId ?? businesses[0]?.businessId ?? null;

  if (businessId === null) {
    notFound();
  }

  const permissions = await inventoryPermissions(db, businessId, context.user.id);

  if (!permissions.viewInventory) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Item</h1>
        <Notice tone="info">You do not have permission to view inventory in this business.</Notice>
      </main>
    );
  }

  const detail = await loadItem(businessId, canonicalItemId);

  if (detail === null) {
    notFound();
  }

  const csrf = csrfToken(context.session);
  const locations = detail.projection.locations.map((location) => ({
    locationId: location.locationId,
    code: location.code,
  }));

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link className="text-sm underline" href="/inventory">
          Inventory
        </Link>
        <h1 className="text-xl font-semibold">
          <span className="font-mono">{detail.projection.sku}</span> {detail.projection.name}
        </h1>
        {detail.projection.isKit ? (
          <p className="text-sm text-neutral-600">
            A kit. It holds no stock of its own; availability comes from its components, and is
            currently {detail.projection.kitCapacity ?? 0}.
          </p>
        ) : null}
      </header>

      <Card title="Now">
        <ProjectionTable projection={detail.projection} />
      </Card>

      {locations.length === 0 ? (
        <Notice tone="info">
          This item is not stocked at any location yet. Adjusting a quantity at a location is what
          puts it there.
        </Notice>
      ) : null}

      {permissions.adjustInventory ? (
        <Card title="Adjust">
          <AdjustForm
            csrf={csrf}
            businessId={businessId}
            canonicalItemId={canonicalItemId}
            locations={locations}
          />
        </Card>
      ) : null}

      {permissions.transferInventory && locations.length > 1 ? (
        <Card title="Transfer">
          <TransferForm
            csrf={csrf}
            businessId={businessId}
            canonicalItemId={canonicalItemId}
            locations={locations}
          />
        </Card>
      ) : null}

      <Card title="History">
        {detail.timeline.length === 0 ? (
          <p className="text-sm text-neutral-600">Nothing has moved yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 text-sm">
            {detail.timeline.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-3 py-2">
                <time className="text-neutral-500" dateTime={entry.occurredAt.toISOString()}>
                  {entry.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                </time>
                <span>{entry.kind.replace('_', ' ')}</span>
                <span className="font-mono">
                  {entry.quantityDelta > 0
                    ? `+${String(entry.quantityDelta)}`
                    : entry.quantityDelta}
                </span>
                <span className="flex-1 text-neutral-600">{entry.reason ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
