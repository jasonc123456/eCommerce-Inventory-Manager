import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card, Notice } from '../../../components/form';
import { csrfToken } from '../../../lib/csrf';
import { identity } from '../../../lib/identity';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { loadOpenPackages, loadShippingAccounts } from '../../../lib/shipping';
import { PackageControls } from './package-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Orders and shipping' };

/**
 * Parcels, labels, and where they have got to (sections 14, 21).
 *
 * The state this screen exists to make visible is the one section 21 names
 * outright: "label-purchased-not-shipped". A parcel with postage on it that is
 * still on the bench is the ordinary condition of a shop at eleven in the
 * morning, and an application that treated buying a label as shipping would have
 * no way to show it — and would have told the customer their order was on its
 * way an hour early.
 *
 * What is not here is a button that buys anything. A label purchase is a
 * reviewed operation: it is proposed against a stored quote, appears on the
 * drafts-and-prices screen with its cost, and is confirmed there. Section 21
 * asks for "purchase label after cost confirmation", and this is what that looks
 * like when the confirmation lives in one place for every operation that spends
 * money or changes what a customer sees.
 */
export default async function ShippingPage() {
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
        <h1 className="text-xl font-semibold">Orders and shipping</h1>
        <Notice tone="info">You are not a member of any business yet.</Notice>
      </main>
    );
  }

  const packages = await loadOpenPackages(businessId, context.user.id);
  const accounts = await loadShippingAccounts(businessId);
  const csrf = csrfToken(context.session);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Orders and shipping</h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href="/operations">
            Drafts and prices
          </Link>
          <Link className="underline" href="/inventory">
            Inventory
          </Link>
        </nav>
      </header>

      {accounts.length === 0 ? (
        <Notice tone="info">
          No shipping provider is connected. Labels are bought on your own EasyPost or Easyship
          account, at your own rates, and appear on your own bill — this installation never holds a
          shipping credential of its own.
        </Notice>
      ) : (
        <Card title="Shipping accounts">
          <ul className="flex flex-col gap-2 text-sm">
            {accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap gap-x-3">
                <span className="font-medium">{account.provider}</span>
                <span className="text-subtle">{account.environment}</span>
                <span>{account.status}</span>
                {account.accountLabel === null ? null : (
                  <span className="text-subtle">{account.accountLabel}</span>
                )}
                {account.lastFailureSummary === null ? null : (
                  <span className="text-subtle">{account.lastFailureSummary}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {packages.length === 0 ? (
        <Notice tone="info">
          Nothing is packed. A package is built from the lines of an order that have not shipped
          yet, priced against your shipping account, and labelled once somebody has confirmed the
          cost.
        </Notice>
      ) : null}

      {packages.map((view) => (
        <Card key={view.parcel.id} title={`Order ${view.externalOrderId}`}>
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-subtle">State</dt>
              <dd>
                {view.parcel.status}
                {view.parcel.status === 'labelled' ? (
                  // Said in words, because it is the distinction the whole
                  // screen exists to make and a bare status word does not carry
                  // it.
                  <span className="text-subtle"> — postage bought, not yet handed over</span>
                ) : null}
              </dd>
              <dt className="text-subtle">Weight</dt>
              <dd>{view.parcel.weightGrams} g</dd>
              {view.parcel.shippedAt === null ? null : (
                <>
                  <dt className="text-subtle">Shipped</dt>
                  <dd>{view.parcel.shippedAt.toISOString()}</dd>
                </>
              )}
            </dl>

            <div>
              <h3 className="text-sm font-medium">Contents</h3>
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {view.contents.map((line) => (
                  <li key={line.externalLineId} className="flex flex-wrap gap-x-3">
                    <span>{line.quantity} ×</span>
                    <span>{line.title ?? line.externalLineId}</span>
                    {line.sku === null ? null : <span className="text-subtle">{line.sku}</span>}
                  </li>
                ))}
              </ul>
            </div>

            {view.label === null ? (
              <Notice tone="info">
                No label yet. Comparing rates and confirming a cost is what buys one.
              </Notice>
            ) : (
              <div>
                <h3 className="text-sm font-medium">Label</h3>
                <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-subtle">Carrier</dt>
                  <dd>
                    {view.label.carrier} {view.label.service}
                  </dd>
                  <dt className="text-subtle">Cost</dt>
                  <dd>
                    {view.label.amount} {view.label.currency}
                  </dd>
                  <dt className="text-subtle">Tracking</dt>
                  <dd>{view.label.trackingNumber}</dd>
                  <dt className="text-subtle">State</dt>
                  <dd>{view.label.state.replace('_', ' ')}</dd>
                  {view.label.voidDetail === null ? null : (
                    <>
                      <dt className="text-subtle">Carrier said</dt>
                      <dd>{view.label.voidDetail}</dd>
                    </>
                  )}
                </dl>
                {view.mayViewDocuments ? null : (
                  <p className="mt-2 text-sm text-subtle">
                    The label document needs <code className="px-1">view_shipments</code>. It is
                    fetched from the carrier when somebody asks for it and is never stored here,
                    because it has the buyer&rsquo;s address printed on it.
                  </p>
                )}
              </div>
            )}

            {view.tracking.length === 0 ? null : (
              <div>
                <h3 className="text-sm font-medium">Tracking</h3>
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                  {view.tracking.map((event) => (
                    <li key={event.id} className="flex flex-wrap gap-x-3">
                      <span className="text-subtle">{event.occurredAt.toISOString()}</span>
                      <span>{event.status.replace(/_/g, ' ')}</span>
                      {event.location === null ? null : (
                        <span className="text-subtle">{event.location}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {view.pushes.length === 0 ? null : (
              <div>
                <h3 className="text-sm font-medium">Told to the channel</h3>
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                  {view.pushes.map((push) => (
                    <li key={push.id} className="flex flex-wrap gap-x-3">
                      <span>{push.kind.replace(/_/g, ' ')}</span>
                      <span className="font-medium">{push.state}</span>
                      {push.failureSummary === null ? null : (
                        <span className="text-subtle">{push.failureSummary}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <PackageControls
              csrf={csrf}
              businessId={businessId}
              packageId={view.parcel.id}
              status={view.parcel.status}
              mayMarkShipped={view.mayMarkShipped}
            />
          </div>
        </Card>
      ))}
    </main>
  );
}
