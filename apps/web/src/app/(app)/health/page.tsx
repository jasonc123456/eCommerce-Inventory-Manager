import { redirect } from 'next/navigation';

import { Card, Notice } from '../../../components/form';
import { loadHealth, loadInstallationSubject } from '../../../lib/health';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'System health' };

/**
 * What is wrong with the installation, and what to do about it (sections 21, 22).
 *
 * Three decisions about who sees this and what it says.
 *
 * It is gated on installation administration, not business ownership. A stalled
 * queue and a filling disk belong to the machine, and showing them to whoever
 * happens to own a business would tell one tenant about the host every other
 * tenant is running on. Section 5 keeps the two authorities separate in both
 * directions.
 *
 * Every check appears, including the ones that are fine. A screen that showed
 * only problems would be empty on a healthy day, and an empty screen is
 * indistinguishable from a broken one — which is the worst possible thing for
 * the page somebody opens when they suspect something is broken.
 *
 * Remediation is shown beside the problem rather than linked to. The person
 * reading this has already decided something is wrong; making them navigate to
 * find out what to do is a step taken during an incident for no reason.
 */
export default async function HealthPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const subject = await loadInstallationSubject(db, context.user.id);

  // Deliberately the same answer as for a signed-in user who is not an
  // administrator at all: nothing here confirms that an installation has a
  // health screen to somebody who may not look at it.
  if (subject?.permissions.has('view_system_health') !== true) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">System health</h1>
        <Notice tone="info">
          This is an installation-administration screen. Your account does not administer this
          installation.
        </Notice>
      </main>
    );
  }

  const { report, alerts } = await loadHealth();

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">System health</h1>
        <p className="text-sm text-subtle">Read at {report.observedAt.toISOString()}</p>
      </header>

      <Notice tone={report.status === 'failing' ? 'error' : 'info'}>
        {report.status === 'ok'
          ? 'Everything checked is working.'
          : report.status === 'degraded'
            ? 'Something is impaired. The application is still usable; synchronization may not be.'
            : 'Something is broken. Read the failing checks below.'}
      </Notice>

      <Card title="Checks">
        <ul className="flex flex-col gap-3 text-sm">
          {report.checks.map((check) => (
            <li key={check.name} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span
                  className={
                    check.status === 'failing'
                      ? 'font-semibold text-[var(--bad)]'
                      : check.status === 'degraded'
                        ? 'font-semibold text-[var(--warn)]'
                        : 'font-semibold'
                  }
                >
                  {check.name}
                </span>
                <span className="text-subtle">{check.status}</span>
                {check.detail === undefined ? null : <span>{check.detail}</span>}
              </div>
              {check.remediation === undefined ? null : (
                <p className="text-muted">{check.remediation}</p>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Installation alerts">
        {alerts.length === 0 ? (
          <Notice tone="info">
            Nothing is outstanding. Alerts about the queue, the workers, storage, backups, and
            configuration appear here; a business’s own alerts do not.
          </Notice>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {alerts.map((alert) => (
              <li key={alert.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-semibold">{alert.severity}</span>
                  <span>{alert.kind}</span>
                  <span className="text-subtle">
                    seen {alert.occurrences}×, last {alert.lastSeenAt.toISOString()}
                  </span>
                </div>
                <p>{alert.summary}</p>
                {alert.recommendedAction === null ? null : (
                  <p className="text-muted">{alert.recommendedAction}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
