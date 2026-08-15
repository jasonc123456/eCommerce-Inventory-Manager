import { expect, type Page } from '@playwright/test';

import { environment } from './environment';
import { actionLink, clearMailbox, messageCount, waitForMessage } from './mailpit';

/** The cookie a session lives in. `__Host-` so it cannot be set by a subdomain. */
export const SESSION_COOKIE = '__Host-eim_session';

/**
 * Asking for a sign-in link, and serving the cooldown if there is one.
 *
 * Section 20 allows one sign-in request per address per minute, and this suite
 * deliberately does not weaken that rule to suit itself: a limit a test can
 * switch off stops being a limit anybody is testing. So it waits, exactly as a
 * person would, and the waiting is why the specs that use it raise their
 * timeout.
 */
export async function requestSignInLink(
  page: Page,
  email: string = environment.adminEmail,
): Promise<void> {
  const deadline = Date.now() + 120_000;

  // The mailbox is the signal, not the notice on the screen. Section 20 gives
  // the same generic sentence to a request that was accepted, a request for an
  // unknown address, and a request that was throttled — deliberately, because
  // three different sentences would answer "does this address have an account".
  // Reading the screen to decide whether to retry would mean depending on
  // exactly the distinction the product refuses to make.
  await clearMailbox();

  for (;;) {
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('status').first()).toBeVisible();

    for (let waited = 0; waited < 6_000; waited += 500) {
      if ((await messageCount()) > 0) {
        return;
      }

      await page.waitForTimeout(500);
    }

    if (Date.now() > deadline) {
      throw new Error(
        'no sign-in message arrived within two minutes of asking. Either the sixty-second ' +
          'resend cooldown never lifted or nothing is being sent.',
      );
    }
  }
}

/**
 * Signing in from nothing, the way a person does.
 *
 * Used by the specs that need a session younger than the ten-minute step-up
 * window (section 20), which a session stored by the setup project is not by the
 * time the suite reaches them.
 */
export async function signIn(page: Page, email: string = environment.adminEmail): Promise<void> {
  await page.goto('/sign-in');

  await requestSignInLink(page, email);

  const message = await waitForMessage(email, { subjectContains: 'Sign in' });

  await page.goto(actionLink(message).toString());
  await page.getByRole('button', { name: 'Confirm sign-in' }).click();

  await expect(page.getByLabel('Active business')).toBeVisible();
}
