import { redirect } from 'next/navigation';

import { removePasskeyAction } from '../../../actions/account';
import { Button, Card, Notice } from '../../../../components/form';
import { csrfToken } from '../../../../lib/csrf';
import { CSRF_FIELD } from '../../../../lib/csrf-field';
import { identity } from '../../../../lib/identity';
import { runtime } from '../../../../lib/runtime';
import { currentContext, hasStepUp } from '../../../../lib/session';
import { TotpPanel } from './security-panels';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Security' };

export default async function SecurityPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const { passkeys, twoFactor } = identity();

  const [credentials, totpActive, remainingRecoveryCodes] = await Promise.all([
    passkeys.list(db, context.user.id),
    twoFactor.isTotpActive(db, context.user.id),
    twoFactor.countRemainingRecoveryCodes(db, context.user.id),
  ]);

  const token = csrfToken(context.session);
  const stepUp = hasStepUp(context);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Security</h1>
        <p className="text-sm opacity-70">Passkeys and second factors for {context.user.email}.</p>
      </header>

      {stepUp ? null : (
        <Notice tone="info">
          Changing anything here needs a sign-in from the last ten minutes. Sign out and back in to
          make changes.
        </Notice>
      )}

      <Card title="Passkeys">
        {credentials.length === 0 ? (
          <p className="text-sm opacity-80">
            None registered. A passkey signs you in with the device you already unlock, and cannot
            be phished the way a code can.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-black/10 dark:divide-white/15">
            {credentials.map((credential) => (
              <li key={credential.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{credential.name}</span>
                  <span className="text-xs opacity-70">
                    Added {credential.createdAt.toISOString().slice(0, 10)}
                    {credential.backupEligible ? ' · synced across your devices' : ''}
                  </span>
                </div>

                <form action={removePasskeyAction}>
                  <input type="hidden" name={CSRF_FIELD} value={token} />
                  <input type="hidden" name="credentialId" value={credential.credentialId} />
                  <Button type="submit" variant="secondary" disabled={!stepUp}>
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs opacity-70">
          Registering a passkey happens in the browser and needs the WebAuthn ceremony, which the
          registration endpoint drives. Only you can add, rename, or remove your own — an
          administrator cannot replace somebody else&apos;s authenticator.
        </p>
      </Card>

      <TotpPanel csrf={token} active={totpActive} remainingRecoveryCodes={remainingRecoveryCodes} />
    </main>
  );
}
