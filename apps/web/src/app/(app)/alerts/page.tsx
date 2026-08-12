import { businessAlertKinds } from '@eim/db';
import { redirect } from 'next/navigation';

import { Card, Notice } from '../../../components/form';
import { loadAlerts } from '../../../lib/alerts';
import { csrfToken } from '../../../lib/csrf';
import { identity } from '../../../lib/identity';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { AlertControls, PreferenceForm, QuietHoursForm } from './alert-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Alerts' };

/**
 * What is wrong with this shop, and who was told (sections 21, 22).
 *
 * Three things on this screen are deliberate.
 *
 * The list is filtered by the same permission table the notification router
 * uses. An application where reading your inbox told you more than signing in
 * would be one where the permission catalogue was decoration.
 *
 * The delivery history is shown with each alert rather than behind a click. The
 * question people ask about an alert is almost always "did anybody actually get
 * told", and putting the answer one click away means it gets assumed instead.
 *
 * Nothing here resolves an alert. Section 22 resolves only on a fresh check
 * proving recovery, so acknowledging says "I have seen this" and leaves the
 * problem visible until the world stops being wrong.
 */
export default async function AlertsPage() {
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
        <h1 className="text-xl font-semibold">Alerts</h1>
        <Notice tone="info">You are not a member of any business yet.</Notice>
      </main>
    );
  }

  const view = await loadAlerts(businessId, context.user.id);
  const csrf = csrfToken(context.session);

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Alerts</h1>

      {view.outstanding.length === 0 ? (
        <Notice tone="info">
          Nothing is outstanding. Oversells, blocked mappings, unhealthy connections, abandoned
          jobs, and reconciliation conflicts appear here — and only the ones your permissions let
          you see.
        </Notice>
      ) : null}

      {view.outstanding.map(({ alert, state, deliveries }) => (
        <Card key={alert.id} title={`${alert.severity} · ${alert.kind.replace(/_/gu, ' ')}`}>
          <div className="flex flex-col gap-4">
            <p>{alert.summary}</p>

            {alert.recommendedAction === null ? null : (
              <Notice tone="info">{alert.recommendedAction}</Notice>
            )}

            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">State</dt>
              <dd>{state}</dd>
              <dt className="text-slate-500">First seen</dt>
              <dd>{alert.firstSeenAt.toISOString()}</dd>
              <dt className="text-slate-500">Last seen</dt>
              <dd>
                {alert.lastSeenAt.toISOString()}
                {alert.occurrences === 1 ? '' : ` (${String(alert.occurrences)} times)`}
              </dd>
              {alert.snoozedUntil === null ? null : (
                <>
                  <dt className="text-slate-500">Quiet until</dt>
                  <dd>{alert.snoozedUntil.toISOString()}</dd>
                </>
              )}
              {alert.acknowledgementNote === null ? null : (
                <>
                  <dt className="text-slate-500">Note</dt>
                  <dd>{alert.acknowledgementNote}</dd>
                </>
              )}
            </dl>

            <details>
              <summary className="cursor-pointer text-sm underline">
                Who was told, and whether it arrived
              </summary>
              {deliveries.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">
                  Nothing has been sent yet. The worker sends on its next pass.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {deliveries.map((delivery) => (
                    <li key={delivery.id} className="flex flex-wrap gap-x-3">
                      <span className="text-slate-500">{delivery.createdAt.toISOString()}</span>
                      <span>{delivery.channel}</span>
                      <span className="font-medium">{delivery.status}</span>
                      {delivery.failureReason === null ? null : (
                        <span className="text-slate-500">{delivery.failureReason}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </details>

            <AlertControls
              csrf={csrf}
              businessId={businessId}
              alertId={alert.id}
              acknowledged={state === 'acknowledged'}
            />
          </div>
        </Card>
      ))}

      <Card title="What reaches your inbox">
        <PreferenceForm
          csrf={csrf}
          businessId={businessId}
          emailMinSeverity={view.preference?.emailMinSeverity ?? 'error'}
          optedInKinds={view.preference?.emailOptedInKinds ?? []}
          mutedKinds={view.preference?.emailMutedKinds ?? []}
          kinds={businessAlertKinds}
        />
      </Card>

      <Card title="Quiet hours">
        {view.mayManageNotifications ? (
          <QuietHoursForm
            csrf={csrf}
            businessId={businessId}
            start={view.quietHours?.start.slice(0, 5) ?? ''}
            end={view.quietHours?.end.slice(0, 5) ?? ''}
            timezone={view.timezone}
          />
        ) : (
          <Notice tone="info">
            {view.quietHours === null
              ? 'This business has no quiet hours. Somebody with permission to manage notifications can set them.'
              : `Email waits between ${view.quietHours.start} and ${view.quietHours.end}, ${view.timezone} time. Oversells and unsafe drift do not wait.`}
          </Notice>
        )}
      </Card>
    </main>
  );
}
