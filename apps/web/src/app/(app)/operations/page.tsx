import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card, Notice } from '../../../components/form';
import { csrfToken } from '../../../lib/csrf';
import { identity } from '../../../lib/identity';
import { OPERATION_LABELS, loadOpenOperations, loadRecentOperations } from '../../../lib/listings';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { OperationControls } from './operation-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Drafts and prices' };

/**
 * Everything waiting for somebody to agree to it (sections 11, 13, 14, 30).
 *
 * Section 16 calls this screen "Drafts and Prices"; what it actually holds is
 * every operation that changes a channel and cannot happen without a person.
 * Creating a draft, publishing one, copying a price, returning a listing to
 * sale, copying an order into a shop — five different things with one shape, and
 * one screen because the question each of them asks is the same: is this what
 * you meant?
 *
 * The preview shown is the one stored with the proposal, not a fresh reading of
 * the world. That is the point rather than an economy: a person confirms the
 * values they were shown, so those must be the values on screen even after they
 * have stopped being true — at which moment the confirmation is refused, with a
 * reason, rather than quietly applied to different numbers.
 *
 * There is no button here that creates a proposal, and none that publishes
 * anything automatically. Section 3 excludes both, and the shape of this screen
 * is what that exclusion looks like.
 */

/**
 * Which fields of a preview a model wrote (section 18).
 *
 * Read out of the stored preview rather than passed alongside it, because the
 * preview is what was fingerprinted: a mark carried separately could say one
 * thing while the agreement said another.
 */
function aiFilledFields(preview: unknown): readonly string[] {
  const named =
    preview !== null && typeof preview === 'object'
      ? (preview as { aiFilledFields?: unknown }).aiFilledFields
      : undefined;

  return Array.isArray(named)
    ? named.filter((name): name is string => typeof name === 'string')
    : [];
}

export default async function OperationsPage() {
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
        <h1 className="text-xl font-semibold">Drafts and prices</h1>
        <Notice tone="info">You are not a member of any business yet.</Notice>
      </main>
    );
  }

  const hasRecentAuthentication = identity().sessions.hasRecentAuthentication(context.session);
  const open = await loadOpenOperations(businessId, context.user.id, hasRecentAuthentication);
  const recent = await loadRecentOperations(businessId);
  const csrf = csrfToken(context.session);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Drafts and prices</h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href="/mappings">
            Mappings
          </Link>
          <Link className="underline" href="/inventory">
            Inventory
          </Link>
        </nav>
      </header>

      {open.length === 0 ? (
        <Notice tone="info">
          Nothing is waiting for a decision. Drafts, price changes, restocks, and order copies all
          appear here once somebody has proposed one; none of them happens on its own.
        </Notice>
      ) : null}

      {open.map(({ operation, label, mayConfirm, stepUpSatisfied }) => (
        <Card key={operation.id} title={label}>
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-subtle">Proposed</dt>
              <dd>{operation.proposedAt.toISOString()}</dd>
              <dt className="text-subtle">Expires</dt>
              <dd>{operation.expiresAt.toISOString()}</dd>
              <dt className="text-subtle">Values read</dt>
              <dd>{operation.sourceObservedAt.toISOString()}</dd>
              <dt className="text-subtle">Needs</dt>
              <dd>{operation.requiredPermission}</dd>
              <dt className="text-subtle">State</dt>
              <dd>{operation.state}</dd>
            </dl>

            {/*
              Section 18: "AI-filled fields are visibly marked". Said in words
              above the preview rather than left for somebody to notice inside
              it, because this is the sentence that changes how the rest of the
              screen should be read. The names are inside the fingerprint too,
              so confirming is agreeing to these fields having come from a model.
            */}
            {aiFilledFields(operation.preview).length > 0 ? (
              <Notice tone="info">
                A model wrote {aiFilledFields(operation.preview).join(', ')}. Read those before
                confirming: they are a suggestion somebody accepted, not a value from your records.
              </Notice>
            ) : null}

            {/*
              The stored preview, rendered as it was recorded. Formatting each
              kind into a bespoke table would be nicer to read and would also be
              a second description of what was agreed to, which could drift from
              the first.
            */}
            <details>
              <summary className="cursor-pointer text-sm underline">
                What this would do, exactly as it was recorded
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
                {JSON.stringify(operation.preview, null, 2)}
              </pre>
            </details>

            {operation.state === 'proposed' ? (
              <OperationControls
                csrf={csrf}
                businessId={businessId}
                operationId={operation.id}
                fingerprint={operation.previewFingerprint}
                mayConfirm={mayConfirm}
                stepUpSatisfied={stepUpSatisfied}
                confirmLabel={label}
              />
            ) : (
              <Notice tone="info">
                Confirmed, and being carried out against the channel. It will not be confirmed
                again.
              </Notice>
            )}
          </div>
        </Card>
      ))}

      {recent.length > 0 ? (
        <Card title="Recently decided">
          <ul className="flex flex-col gap-2 text-sm">
            {recent.map((operation) => (
              <li key={operation.id} className="flex flex-wrap gap-x-3">
                <span className="text-subtle">{operation.proposedAt.toISOString()}</span>
                <span>{OPERATION_LABELS[operation.kind]}</span>
                <span className="font-medium">{operation.state}</span>
                {operation.failureSummary === null ? null : (
                  <span className="text-subtle">{operation.failureSummary}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </main>
  );
}
