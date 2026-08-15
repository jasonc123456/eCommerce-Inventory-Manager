import Link from 'next/link';

import { Card, Notice } from '../../../../../components/form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Connecting a store' };

/**
 * Where WooCommerce sends the operator back (sections 14, 21).
 *
 * Section 21 asks for callback progress, and this page is what it looks like for
 * a flow whose two halves arrive separately. WooCommerce redirects the browser
 * here *and* posts the credential to a different endpoint, and the two are not
 * ordered relative to each other by anything.
 *
 * So this page reports what the store said about the operator's approval, and
 * nothing about whether the credential arrived. It cannot: the parameters here
 * are appended by the store, and a page that read `success=1` as "connected"
 * would tell somebody their store was set up when the callback had in fact been
 * blocked by a firewall — which is precisely the failure the manual fallback
 * exists for.
 *
 * The connections list is the authority, so that is where the operator is sent.
 */
export default async function WooCommerceReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const approved = first(parameters['success']) === '1';

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Connecting a store</h1>

      {approved ? (
        <Card title="Approved at the store">
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Your store reported that you approved this application and issued a key. The store
              sends that key to this application separately, so it may take a moment to appear.
            </p>
            <p className="text-sm text-muted">
              If the store does not appear as connected, the key never arrived — usually a security
              plugin or a proxy blocking the callback. Connect the store with a key you make
              yourself instead; it ends up in exactly the same place.
            </p>
            <Link href="/connections" className="text-sm underline">
              Back to connections
            </Link>
          </div>
        </Card>
      ) : (
        <Card title="Not approved">
          <div className="flex flex-col gap-3">
            <Notice tone="info">
              Your store did not report an approval, so no key was issued and nothing has changed.
            </Notice>
            <p className="text-sm text-muted">
              This happens when the approval screen is declined or closed. You can start again, or
              create a key in the store yourself and enter it directly.
            </p>
            <Link href="/connections" className="text-sm underline">
              Back to connections
            </Link>
          </div>
        </Card>
      )}
    </main>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
