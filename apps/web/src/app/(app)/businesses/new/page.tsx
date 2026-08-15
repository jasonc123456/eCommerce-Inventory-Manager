import { redirect } from 'next/navigation';

import { Card, PageHeader } from '../../../../components/form';
import { csrfToken } from '../../../../lib/csrf';
import { identity } from '../../../../lib/identity';
import { runtime } from '../../../../lib/runtime';
import { currentContext } from '../../../../lib/session';
import { CreateBusinessForm } from './business-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'New business' };

/**
 * Creating a workspace (sections 2, 5).
 *
 * This screen is the answer to a gap that made a clean install unusable: section
 * 2 promises "multiple business workspaces in one installation" and there was no
 * way to create the first one. Bootstrap makes an owner account and stops, so
 * signing in led to an application where every screen said you were not a member
 * of anything and offered nothing to do about it.
 *
 * No permission is checked. Permissions are held *within* a business and this is
 * the act that creates one, so the first grant has to come from somewhere. It is
 * safe here because accounts do not self-register — a user exists only because
 * bootstrap created them or somebody invited them — and it is recorded as
 * `business.created` with the actor either way.
 */
export default async function NewBusinessPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const existing = await identity().memberships.listBusinessesFor(db, context.user.id);
  const first = existing.length === 0;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        title={first ? 'Create your first business' : 'New business'}
        description={
          first
            ? 'A business is one shop: its own stock, its own channels, its own team. Everything else in this application belongs to one.'
            : 'Separate stock, channels, and team members. Nothing is shared between businesses.'
        }
      />

      <Card title="Details" description="Two things now; connections and stock come afterwards.">
        <CreateBusinessForm csrf={csrfToken(context.session)} guess="UTC" />
      </Card>

      {first ? (
        <Card title="What happens next" description="The order the rest of the setup goes in.">
          <ol className="text-muted flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>
              Connect an eBay account and a WooCommerce store. Both import read-only first — nothing
              is written until you say so.
            </li>
            <li>
              Create canonical items and map each channel listing to one. Nothing synchronizes
              before a mapping is approved and activated.
            </li>
            <li>
              Put the business into the observing stage on the pilot screen and watch what the
              system says it would do before letting it do any of it.
            </li>
          </ol>
        </Card>
      ) : null}
    </main>
  );
}
