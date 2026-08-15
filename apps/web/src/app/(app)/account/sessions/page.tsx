import { redirect } from 'next/navigation';

import { signOutEverywhereAction } from '../../../actions/auth';
import { revokeSessionAction } from '../../../actions/account';
import { Button, Card } from '../../../../components/form';
import { csrfToken } from '../../../../lib/csrf';
import { CSRF_FIELD } from '../../../../lib/csrf-field';
import { identity } from '../../../../lib/identity';
import { runtime } from '../../../../lib/runtime';
import { currentContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Devices' };

/**
 * The sessions and devices screen (section 20).
 *
 * Section 20 declines to impose a concurrent-session limit and requires this
 * instead: a list, individual revocation, and a global sign-out. The reasoning
 * is worth keeping in view — an arbitrary limit signs somebody out of a device
 * they were using in order to protect them from a device they were also using,
 * while a list lets them see the one they do not recognise.
 */
export default async function SessionsPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const sessions = await identity().sessions.listForUser(db, context.user.id);
  const token = csrfToken(context.session);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Devices</h1>
        <p className="text-sm text-muted">
          Every session that can currently reach your account. Anything you do not recognise should
          be signed out.
        </p>
      </header>

      <Card title={`${String(sessions.length)} active`}>
        <ul className="flex flex-col divide-y divide-black/10 dark:divide-white/15">
          {sessions.map((session) => {
            const isCurrent = session.id === context.session.id;

            return (
              <li key={session.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">
                    {session.deviceLabel ?? 'Unrecognised device'}
                    {isCurrent ? (
                      <span className="ml-2 text-xs text-muted">this device</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted">
                    {/* Section 20 keeps device metadata minimal, and section 19
                        ages precise network evidence out rather than keeping it
                        indefinitely. What is shown is what a user needs to
                        recognise their own session. */}
                    Last used {formatWhen(session.lastSeenAt)}
                    {session.requestIp === null ? '' : ` from ${session.requestIp}`}
                    {session.rememberDevice ? ' · remembered' : ''}
                  </span>
                </div>

                {isCurrent ? null : (
                  <form action={revokeSessionAction}>
                    <input type="hidden" name={CSRF_FIELD} value={token} />
                    <input type="hidden" name="sessionId" value={session.id} />
                    <Button type="submit" variant="secondary">
                      Sign out
                    </Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Sign out everywhere">
        <p className="text-sm text-muted">
          Ends every session including this one, and revokes every trusted device. Use it if you
          think somebody else has access.
        </p>
        <form action={signOutEverywhereAction}>
          <input type="hidden" name={CSRF_FIELD} value={token} />
          <Button type="submit">Sign out of everything</Button>
        </form>
      </Card>
    </main>
  );
}

function formatWhen(when: Date): string {
  const minutes = Math.round((Date.now() - when.getTime()) / 60_000);

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${String(minutes)} minutes ago`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 24 ? `${String(hours)} hours ago` : when.toISOString().slice(0, 10);
}
